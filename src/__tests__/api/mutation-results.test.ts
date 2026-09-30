import { describe, expect, it } from "bun:test";
import { parseEventMutationResult } from "../../lib/api/mutation-results";
import { checkTaskMutationResult } from "../../lib/api/task-results";
import {
	type ApiResponse,
	type EventOperation,
	type EventOperationPayload,
	isReadOnlyCanonical,
} from "../../lib/api/types";

const submitted: EventOperationPayload[] = ["a", "b"].map(
	(id, client_order) => ({
		id,
		event_id: `event-${id}`,
		connector_id: "google",
		account_id: "synthetic-account",
		calendar_id: "synthetic-calendar",
		operation: client_order === 0 ? "create" : "patch",
		payload: {},
		result: null,
		processed_at: null,
		failed_at: null,
		client_order,
		global_created_at: "2026-01-01T00:00:00Z",
		global_updated_at: "2026-01-01T00:00:00Z",
		deleted_at: null,
	}),
);
const records = (): EventOperation[] =>
	submitted.map((operation) => ({
		...operation,
		user_id: 1,
		status: "succeeded",
		processed_at: "2026-01-01T00:00:01Z",
	}));
const envelope = (
	overrides: Partial<ApiResponse<EventOperation[]>> = {},
): ApiResponse<EventOperation[]> => ({
	success: true,
	message: null,
	data: records(),
	...overrides,
});

describe("event mutation receipts", () => {
	it("matches by operation ID and preserves order, raw and server results", () => {
		const data = records().reverse();
		if (data[0]) data[0].result = { provider: "server-value" };
		const raw = envelope({ data });
		const result = parseEventMutationResult(raw, [...submitted].reverse());
		expect(result.raw).toBe(raw);
		expect(result.allAccepted).toBe(true);
		expect(result.receipts.map((r) => r.operation_id)).toEqual(["a", "b"]);
		expect(result.receipts[1]?.result).toEqual({ provider: "server-value" });
		expect(result.receipts[1]?.kind).toBe("patch");
	});
	it("names failed operation IDs even on success:false", () => {
		const result = parseEventMutationResult(
			envelope({ success: false, failed: [{ id: "b", error: "denied" }] }),
			submitted,
		);
		expect(result.receipts.map((r) => r.status)).toEqual([
			"accepted",
			"failed",
		]);
		expect(result.receipts[1]?.error).toBe("denied");
		expect(result.allAccepted).toBe(false);
	});
	it("makes aggregate failure without identifiable IDs unknown", () => {
		for (const failed of [undefined, [{ id: "event-a", error: "wrong ID" }]]) {
			const result = parseEventMutationResult(
				envelope({ success: false, failed }),
				submitted,
			);
			expect(result.receipts.map((r) => r.status)).toEqual([
				"unknown",
				"unknown",
			]);
			expect(result.allAccepted).toBe(false);
			expect(result.receipts.every((r) => r.error !== undefined)).toBe(true);
		}
	});
	it("preserves failed_at and error details from the server", () => {
		const data = records();
		if (data[0]) {
			data[0].failed_at = "2026-01-01T00:00:01Z";
			data[0].result = { error: "conflict" };
		}
		const result = parseEventMutationResult(envelope({ data }), submitted);
		expect(result.receipts[0]?.status).toBe("failed");
		expect(result.receipts[0]?.error).toEqual({ error: "conflict" });
		expect(result.receipts[0]?.failed_at).toBe("2026-01-01T00:00:01Z");
	});
	it("recognizes explicit failed status without failed_at", () => {
		const data = records();
		if (data[0]) data[0].status = "failed";
		expect(
			parseEventMutationResult(envelope({ data }), submitted).receipts[0]
				?.status,
		).toBe("failed");
	});
	it("uses pending only with an explicit pending signal", () => {
		const data = records();
		if (data[0]) {
			data[0].status = "pending";
			data[0].processed_at = null;
		}
		if (data[1]) {
			data[1].status = null;
			data[1].processed_at = null;
		}
		const result = parseEventMutationResult(envelope({ data }), submitted);
		expect(result.receipts.map((r) => r.status)).toEqual([
			"pending",
			"accepted",
		]);
		expect(result.allAccepted).toBe(false);
	});
	it("does not fabricate omitted, empty or missing operation results", () => {
		for (const data of [[], undefined, records().slice(1)]) {
			const raw = { success: true, message: null, data } as ApiResponse<
				EventOperation[]
			>;
			const result = parseEventMutationResult(raw, submitted);
			expect(result.receipts[0]?.status).toBe("unknown");
			expect(result.receipts[0]?.result).toBeNull();
			expect(result.allAccepted).toBe(false);
		}
	});
	it("surfaces unmatched failure IDs on every receipt", () => {
		const result = parseEventMutationResult(
			envelope({ failed: [{ id: "foreign-id", error: "unexpected" }] }),
			submitted,
		);
		for (const receipt of result.receipts)
			expect(receipt.error).toEqual({
				message: "Unmatched envelope failure",
				id: "foreign-id",
				error: "unexpected",
			});
	});
	it("does not correlate event IDs as operation IDs", () => {
		const data = records().map((r) => ({ ...r, id: r.event_id }));
		expect(
			parseEventMutationResult(envelope({ data }), submitted).receipts.map(
				(r) => r.status,
			),
		).toEqual(["unknown", "unknown"]);
	});
	it("keeps empty data unknown even if an envelope names a failure", () => {
		const result = parseEventMutationResult(
			envelope({ data: [], failed: [{ id: "a", error: "rejected" }] }),
			submitted,
		);
		expect(result.receipts.map((receipt) => receipt.status)).toEqual([
			"unknown",
			"unknown",
		]);
		expect(result.receipts[0]?.error).toContain("rejected");
	});
});

describe("task mutation results", () => {
	it("reports exact partial successes and named failures", () => {
		expect(
			checkTaskMutationResult(
				{
					success: false,
					message: null,
					data: [{ id: "valid" }],
					failed: [{ id: "invalid", error: "not found" }],
				},
				["valid", "invalid"],
			),
		).toEqual({
			ok: false,
			succeededIds: ["valid"],
			failedIds: ["invalid"],
			unknownIds: [],
			errors: ["Task mutation envelope reported failure", "invalid: not found"],
		});
	});
	it("never invents failures from aggregate failure", () => {
		const result = checkTaskMutationResult(
			{ success: false, message: "rejected", data: [] },
			["a", "b"],
		);
		expect(result.failedIds).toEqual([]);
		expect(result.unknownIds).toEqual(["a", "b"]);
		expect(result.ok).toBe(false);
	});
	it("requires full ID coverage and gives named failures precedence", () => {
		const result = checkTaskMutationResult(
			{
				success: true,
				message: null,
				data: [{ id: "a" }],
				failed: [{ id: "a" }],
			},
			["a", "b"],
		);
		expect(result.succeededIds).toEqual([]);
		expect(result.failedIds).toEqual(["a"]);
		expect(result.unknownIds).toEqual(["b"]);
		expect(result.ok).toBe(false);
		expect(
			checkTaskMutationResult(
				{ success: true, message: null, data: [{ id: "a" }] },
				["a"],
			).ok,
		).toBe(true);
	});
	it("surfaces unidentified failures and deduplicates requested IDs", () => {
		const result = checkTaskMutationResult(
			{
				success: true,
				message: null,
				data: [{ id: "a" }],
				failed: [{ error: "bad" }],
			},
			["a", "a"],
		);
		expect(result.succeededIds).toEqual(["a"]);
		expect(result.errors).toContain("Unmatched failure ID: missing");
		expect(result.ok).toBe(false);
	});
});

it("only canonical boolean true marks a record read-only", () => {
	for (const record of [
		undefined,
		null,
		false,
		{},
		{ read_only: false },
		{ read_only: "true" },
		{ read_only: 1 },
	])
		expect(isReadOnlyCanonical(record)).toBe(false);
	expect(isReadOnlyCanonical({ read_only: true })).toBe(true);
});
