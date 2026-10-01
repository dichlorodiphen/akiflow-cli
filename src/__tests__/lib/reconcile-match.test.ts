import { expect, test } from "bun:test";
import { matchRecords } from "../../lib/reconcile/match";
import {
	af,
	ge,
	normalizedA,
	normalizedG,
	workCalendar,
} from "./reconcile-fixtures";

function match(a = [af()], g = [ge()]) {
	return matchRecords(normalizedA(a), normalizedG(g));
}

test("exact_origin_match_survives_title_and_time_changes", () => {
	const result = match(
		[af()],
		[
			ge("g1", {
				summary: "Changed",
				start: { dateTime: "2026-10-02T02:00:00Z" },
				end: { dateTime: "2026-10-02T03:00:00Z" },
			}),
		],
	);
	expect(result.matches).toHaveLength(1);
	expect(result.matches[0]).toMatchObject({
		method: "provider_id",
		confidence: "confirmed",
		akiflow_id: "a1",
		google_id: "g1",
	});
	expect(
		result.matches[0]?.differences.map((difference) => difference.field),
	).toEqual(["title", "time"]);
});
test("same_id_on_different_calendars_does_not_cross_match", () => {
	expect(
		matchRecords(
			normalizedA([af()]),
			normalizedG([ge()], workCalendar.origin_id),
		).matches,
	).toHaveLength(0);
});
test("uuid_prefix_is_not_guessed", () => {
	const result = match([
		af("a", { origin_id: "8e274c12-6063-4a2b-8875-cee04c338a01_g1" }),
	]);
	expect(result.matches).toHaveLength(0);
	expect(result.possible_counterparts).toHaveLength(1);
});
test("base_plus_anchor_matches_one_instance", () => {
	const result = match(
		[
			af("a", {
				origin_id: "series",
				origin_recurring_id: "series",
				original_start_time: "2026-10-01T02:30:00Z",
			}),
		],
		[
			ge("series_20261001T023000Z", {
				recurringEventId: "series",
				originalStartTime: { dateTime: "2026-10-01T02:30:00Z" },
			}),
			ge("series_20261002T023000Z", {
				recurringEventId: "series",
				originalStartTime: { dateTime: "2026-10-02T02:30:00Z" },
			}),
		],
	);
	expect(result.matches).toHaveLength(1);
	expect(result.matches[0]?.google_id).toBe("series_20261001T023000Z");
	expect(result.matches[0]?.method).toBe("occurrence_anchor");
});
test("base_never_matches_every_occurrence", () => {
	const result = match(
		[
			af("a", {
				origin_id: "series",
				origin_recurring_id: "series",
				recurrence_exception: true,
			}),
		],
		[
			ge("series_20261001T023000Z", {
				recurringEventId: "series",
				originalStartTime: { dateTime: "2026-10-01T02:30:00Z" },
			}),
			ge("series_20261002T023000Z", {
				recurringEventId: "series",
				originalStartTime: { dateTime: "2026-10-02T02:30:00Z" },
			}),
		],
	);
	expect(result.matches).toHaveLength(0);
});
test("moved_instance_uses_original_anchor", () => {
	const a = af("a", {
		origin_id: null,
		origin_recurring_id: "series",
		recurrence_exception: true,
		original_start_time: "2026-10-01T02:30:00Z",
		start_time: "2026-10-01T05:00:00Z",
		end_time: "2026-10-01T06:00:00Z",
	});
	const g = ge("instance", {
		recurringEventId: "series",
		originalStartTime: { dateTime: "2026-10-01T02:30:00Z" },
		start: { dateTime: "2026-10-01T06:00:00Z" },
		end: { dateTime: "2026-10-01T07:00:00Z" },
	});
	expect(match([a], [g]).matches[0]).toMatchObject({
		method: "occurrence_anchor",
		confidence: "confirmed",
	});
});
test("eligible actual-start anchor is probable; exception actual-start is ineligible", () => {
	const g = ge("instance", {
		recurringEventId: "series",
		originalStartTime: { dateTime: "2026-10-01T02:30:00Z" },
	});
	expect(
		match(
			[af("a", { origin_id: "series", origin_recurring_id: "series" })],
			[g],
		).matches[0]?.confidence,
	).toBe("probable");
	expect(
		match(
			[
				af("a", {
					origin_id: "series",
					origin_recurring_id: "series",
					recurrence_exception: true,
				}),
			],
			[g],
		).matches,
	).toHaveLength(0);
});
test("two_akiflow_records_claiming_one_google_id_report_collision", () => {
	const result = match([
		af("a"),
		af("b", {
			title: "Unrelated",
			start_time: "2026-10-01T05:00:00Z",
			end_time: null,
		}),
	]);
	expect(result.matches).toHaveLength(0);
	expect(result.collisions).toHaveLength(1);
	expect(result.collisions[0]?.member_refs).toHaveLength(3);
	expect(result.linked.size).toBe(3);
});
test("ambiguous_fallback_stays_unresolved", () => {
	const result = match([
		af("a", { origin_id: null }),
		af("b", { origin_id: null }),
	]);
	expect(result.matches).toHaveLength(0);
	expect(result.possible_counterparts).toHaveLength(2);
});
test("contradictory_origin_is_only_possible_counterpart", () => {
	const result = match([af("a", { origin_id: "another-provider-id" })]);
	expect(result.matches).toHaveLength(0);
	expect(result.possible_counterparts[0]?.google_refs).toHaveLength(1);
});
test("mutually unique nonempty title/start fallback is probable", () => {
	const result = match([af("a", { origin_id: null, title: "  STUDY  " })]);
	expect(result.matches[0]).toMatchObject({
		confidence: "probable",
		method: "title_start",
	});
	expect(
		match([af("a", { origin_id: null, title: "" })], [ge("g", { summary: "" })])
			.matches,
	).toHaveLength(0);
});
test("provider IDs are case-sensitive and no time tolerance is used", () => {
	expect(match([af("a", { origin_id: "G1" })]).matches).toHaveLength(0);
	expect(
		match([af("a", { origin_id: null, start_time: "2026-10-01T02:30:01Z" })])
			.matches,
	).toHaveLength(0);
});
test("never fuzzy-match cancellation; exact cancellation still links", () => {
	expect(
		match([af("a", { origin_id: null })], [ge("g1", { status: "cancelled" })])
			.matches,
	).toHaveLength(0);
	expect(
		match(
			[af()],
			[{ id: "g1", status: "cancelled" }],
		).matches[0]?.differences.map((difference) => difference.field),
	).toEqual(["state"]);
});
test("active series master establishes presence only, never an occurrence", () => {
	expect(
		match(
			[af("a", { origin_id: "series", origin_recurring_id: "series" })],
			[ge("series", { recurrence: ["RRULE:FREQ=DAILY"] })],
		).matches,
	).toHaveLength(0);
});

test("uncovered Akiflow master anchor is not matched to a Google series definition", () => {
	const result = match(
		[
			af("master", {
				origin_id: "series",
				recurring_id: "master",
				recurrence: ["RRULE:FREQ=DAILY"],
				hidden: true,
			}),
		],
		[ge("series", { recurrence: ["RRULE:FREQ=DAILY"] })],
	);
	expect(result.matches).toHaveLength(0);
	expect(result.linked.size).toBe(0);
});
