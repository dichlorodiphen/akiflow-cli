import { describe, expect, test } from "bun:test";
import {
	buildInstanceDelete,
	buildInstancePatch,
	occurrenceUuid,
	resolveRecurrenceInstance,
} from "../../lib/recurrence-instance";
import { event } from "./occurrence-fixtures";

const masterId = "123e4567-e89b-12d3-a456-426614174000";
function master() {
	return event({
		id: masterId,
		recurring_id: masterId,
		akiflow_account_id: "account",
		connector_id: "google",
		calendar_id: "calendar",
		origin_id: "provider-master",
		start_time: "2026-10-20T16:00:00.000Z",
		end_time: "2026-10-20T17:00:00.000Z",
		start_datetime_tz: "America/Los_Angeles",
		recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
	});
}
const anchor = "2026-10-21T16:00:00.000Z";
describe("native recurring occurrence identity", () => {
	test("UUID matches both official current Akiflow rust WASM specimens", () => {
		expect(occurrenceUuid(masterId, anchor)).toBe(
			"539d6105-7d91-5abd-97e0-226f32b4ea65",
		);
		expect(occurrenceUuid(masterId, "2026-10-21")).toBe(
			"48eec490-ce1d-50d2-9fff-b04aafca796e",
		);
	});
	test("unmaterialized anchor validates recurrence and uses official stable identity", () => {
		const parent = master();
		const result = resolveRecurrenceInstance(parent, [parent], anchor);
		expect(result.event.id).toBe(occurrenceUuid(masterId, anchor));
		expect(result.event.end_time).toBe("2026-10-21T17:00:00.000Z");
		const op = buildInstancePatch(
			result,
			{ title: "old" },
			{ title: "new" },
			"none",
		);
		expect(op.payload).toEqual({
			base: { title: "old" },
			changes: { title: "new" },
			original_start_time: anchor,
			parent_event_id: masterId,
			send_updates: false,
		});
		expect(op.event_id).not.toBe(parent.id);
		expect(op.account_id).toBe("account");
		expect(parent.title).not.toBe("new");
	});
	test("moved materialized exception preserves observed UUID and original anchor", () => {
		const parent = master();
		const moved = event({
			...parent,
			id: "observed-exception",
			recurring_id: masterId,
			recurrence: null,
			original_start_time: anchor,
			start_time: "2026-10-25T19:00:00Z",
			end_time: "2026-10-25T20:00:00Z",
		});
		const result = resolveRecurrenceInstance(parent, [parent, moved], anchor);
		expect(result.event).toBe(moved);
		const op = buildInstanceDelete(result, "none");
		expect(op.event_id).toBe(moved.id);
		expect(op.payload).toEqual({
			original_start_time: anchor,
			parent_event_id: masterId,
			send_updates: false,
		});
		expect(() =>
			resolveRecurrenceInstance(moved, [parent, moved], "2026-10-22T16:00:00Z"),
		).toThrow("conflicts");
	});
	test("rejects invalid, excluded, expired and ambiguous occurrence anchors", () => {
		const parent = master();
		for (const value of [
			undefined,
			"2026-10-21T16:00:00",
			"2026-10-21T17:00:00Z",
			"2026-10-25T16:00:00Z",
		])
			expect(() =>
				resolveRecurrenceInstance(parent, [parent], value),
			).toThrow();
		const excluded = {
			...parent,
			recurrence: [...parent.recurrence!, "EXDATE:20261021T160000Z"],
		};
		expect(() =>
			resolveRecurrenceInstance(excluded, [excluded], anchor),
		).toThrow("not an active");
		const first = event({
			...parent,
			id: "one",
			recurring_id: masterId,
			recurrence: null,
			original_start_time: anchor,
		});
		expect(() =>
			resolveRecurrenceInstance(
				parent,
				[parent, first, { ...first, id: "two" }],
				anchor,
			),
		).toThrow("Multiple");
	});
	test("cancelled exceptions never resurrect and foreign accounts never resolve", () => {
		const parent = master();
		const cancelled = event({
			...parent,
			id: "cancelled",
			recurring_id: masterId,
			recurrence: null,
			original_start_time: anchor,
			status: "cancelled",
		});
		expect(() =>
			buildInstanceDelete(
				resolveRecurrenceInstance(parent, [parent, cancelled], anchor),
				"none",
			),
		).toThrow("cancelled");
		expect(() =>
			resolveRecurrenceInstance(
				parent,
				[
					parent,
					{
						...cancelled,
						status: "confirmed",
						recurrence_exception_delete: "2026-10-21T00:00:00Z",
					},
				],
				anchor,
			),
		).toThrow("cancellation marker");
		expect(() =>
			resolveRecurrenceInstance(
				{ ...cancelled, akiflow_account_id: "foreign" },
				[parent, cancelled],
			),
		).toThrow("identity");
	});
	test("rejects a mutable child under a deleted/cancelled/read-only parent", () => {
		for (const change of [
			{ deleted_at: "2026-10-20T00:00:00Z" },
			{ status: "cancelled" as const },
			{ read_only: true },
		]) {
			const parent = { ...master(), ...change };
			const child = event({
				...master(),
				id: "child",
				recurring_id: masterId,
				recurrence: null,
				original_start_time: anchor,
			});
			expect(() => resolveRecurrenceInstance(child, [parent, child])).toThrow(
				"master is",
			);
		}
	});

	test("deletes a fresh observed all-day exception directly, preserving series routing", () => {
		const parent = {
			...master(),
			start_time: null,
			end_time: null,
			start_date: "2026-10-20",
			end_date: "2026-10-21",
		};
		const child = event({
			...parent,
			id: "observed-all-day-instance",
			recurrence: null,
			recurring_id: parent.id,
			origin_id: "provider-instance",
			recurrence_exception: true,
			original_start_date: "2026-10-21",
			start_date: "2026-10-25",
			end_date: "2026-10-26",
		});
		const resolved = resolveRecurrenceInstance(
			parent,
			[parent, child],
			"2026-10-21",
		);
		expect(resolved.materialized).toBe(true);
		const operation = buildInstanceDelete(resolved, "none");
		expect(operation.event_id).toBe(child.id);
		expect(operation.account_id).toBe(parent.akiflow_account_id!);
		expect(operation.calendar_id).toBe(parent.calendar_id);
		expect(operation.payload).toEqual({ send_updates: false });
		expect(operation.event_id).not.toBe(parent.id);
		for (const change of [
			{ origin_id: null },
			{ recurrence_exception: false },
			{ calendar_id: "foreign" },
			{ akiflow_account_id: "foreign" },
			{ connector_id: "foreign" },
			{ original_start_date: "2026-10-22" },
		])
			expect(() =>
				buildInstanceDelete(
					{ ...resolved, event: { ...resolved.event, ...change } },
					"none",
				),
			).toThrow("Materialized all-day");
	});

	test("ordinary observed all-day occurrences retain the official anchored delete route", () => {
		const parent = {
			...master(),
			start_time: null,
			end_time: null,
			start_date: "2026-10-20",
			end_date: "2026-10-21",
		};
		const child = event({
			...parent,
			id: "ordinary-observed",
			recurring_id: parent.id,
			recurrence: null,
			origin_id: "provider-instance",
			recurrence_exception: false,
			original_start_date: "2026-10-21",
			start_date: "2026-10-21",
			end_date: "2026-10-22",
		});
		const result = resolveRecurrenceInstance(
			parent,
			[parent, child],
			"2026-10-21",
		);
		expect(result.materialized).toBe(true);
		const operation = buildInstanceDelete(result, "none");
		expect(operation.event_id).toBe(child.id);
		expect(operation.payload).toEqual({
			send_updates: false,
			parent_event_id: parent.id,
			original_start_date: "2026-10-21",
		});
		expect(() =>
			buildInstanceDelete(
				{ ...result, event: { ...child, start_date: "2026-10-25" } },
				"none",
			),
		).toThrow("without an observed exception marker");
	});

	test("all-day anchors use the inclusive Akiflow span and date payload", () => {
		const parent = {
			...master(),
			start_time: null,
			end_time: null,
			start_date: "2026-10-20",
			end_date: "2026-10-21",
		};
		const result = resolveRecurrenceInstance(parent, [parent], "2026-10-21");
		expect(result.event.start_date).toBe("2026-10-21");
		expect(result.event.end_date).toBe("2026-10-22");
		expect(buildInstanceDelete(result, "all").payload).toEqual({
			original_start_date: "2026-10-21",
			parent_event_id: masterId,
			send_updates: true,
		});
	});
});
