import { describe, expect, test } from "bun:test";
import { resolveGoogleIdentity } from "../../lib/providers/google";
import { editRecurrenceInstance } from "../../lib/providers/router";

describe("resolveGoogleIdentity", () => {
	test("resolves from observed origin_id", () => {
		const result = resolveGoogleIdentity({
			id: "akiflow-uuid",
			origin_id: "google-event-id-123",
			calendar_id: "cal-1",
			account_id: null,
			connector_id: null,
		});
		expect("refused" in result).toBe(false);
		if (!("refused" in result)) {
			expect(result.kind).toBe("google");
			expect(result.providerEventId).toBe("google-event-id-123");
		}
	});

	test("refuses when origin_id is missing (never title-searches)", () => {
		const result = resolveGoogleIdentity({
			id: "akiflow-uuid",
			origin_id: null,
			calendar_id: "cal-1",
			account_id: null,
			connector_id: null,
		});
		expect(result).toEqual({ refused: "no-provider-identity" });
	});

	test("refuses Akiflow-native UUIDs (not a Google identity)", () => {
		const result = resolveGoogleIdentity({
			id: "akiflow-uuid",
			origin_id: "123e4567-e89b-12d3-a456-426614174000",
			calendar_id: "cal-1",
			account_id: null,
			connector_id: null,
		});
		expect(result).toEqual({ refused: "no-provider-identity" });
	});

	test("revert-sensitive: does not guess from title", () => {
		// There is no title parameter at all — identity must come from
		// observed provider fields. If a title-search fallback were added,
		// this test's contract (refusal on missing origin_id) would break.
		const result = resolveGoogleIdentity({
			id: "akiflow-uuid",
			origin_id: undefined,
			calendar_id: null,
			account_id: null,
			connector_id: null,
		});
		expect("refused" in result).toBe(true);
	});
});

describe("editRecurrenceInstance", () => {
	const baseEvent = {
		id: "event-1",
		origin_id: "google-event-abc",
		calendar_id: "cal-1",
	} as never;

	test("refuses without original_start_time anchor", async () => {
		const outcome = await editRecurrenceInstance(baseEvent, "", {
			title: "New title",
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe("no-identity");
		}
	});

	test("refuses when Google adapter has no credentials", async () => {
		// AF_GOOGLE_ACCESS_TOKEN is not set in test env.
		const outcome = await editRecurrenceInstance(
			baseEvent,
			"2026-06-22T16:00:00.000Z",
			{ title: "New title" },
			{ akiflowExceptionWrites: false, googleDirectEdits: false },
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe("no-credentials");
		}
	});

	test("refuses when identity is ambiguous/missing (no guessing)", async () => {
		const noIdentityEvent = {
			id: "event-2",
			origin_id: null,
			calendar_id: "cal-1",
		} as never;
		const outcome = await editRecurrenceInstance(
			noIdentityEvent,
			"2026-06-22T16:00:00.000Z",
			{ title: "New title" },
			{ akiflowExceptionWrites: false, googleDirectEdits: true },
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(["no-identity", "ambiguous-identity"]).toContain(outcome.reason);
		}
	});

	test("revert-sensitive: anchor is required (never falls back to start_time)", async () => {
		// If the anchor check were removed, an empty anchor would proceed to
		// provider routing instead of refusing.
		const outcome = await editRecurrenceInstance(baseEvent, "", {});
		expect(outcome.ok).toBe(false);
	});
});
