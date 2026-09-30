import { describe, expect, it } from "bun:test";
import type { AkiflowClient } from "../../lib/api/client";
import type { Event } from "../../lib/api/types";
import { verifyEventAttendees } from "../../lib/attendee-verification";

describe("fresh attendee verification", () => {
	it("folds later paginated versions and returns the original observed record", async () => {
		const calls: Array<unknown> = [];
		const original = {
			id: "event",
			title: "Meeting",
			attendees: [{ email: "GUEST@example.com" }],
			deleted_at: null,
		} as Event;
		const client = {
			get: async (_path: string, params: { sync_token?: string }) => {
				calls.push(params);
				return params.sync_token
					? { success: true, message: null, data: [original] }
					: {
							success: true,
							message: null,
							data: [{ ...original, attendees: [] }],
							has_next_page: true,
							sync_token: "next",
						};
			},
		} as unknown as Pick<AkiflowClient, "get">;
		const result = await verifyEventAttendees(
			client,
			"event",
			["guest@example.com"],
			["removed@example.com"],
			{ timeoutMs: 100 },
		);
		expect(result.status).toBe("verified");
		expect(result.observed).toEqual(original);
		expect(calls).toEqual([
			{ limit: 2500, sync_token: undefined },
			{ limit: 2500, sync_token: "next" },
		]);
	});

	it("reports attendee membership mismatch without inventing title differences", async () => {
		const client = {
			get: async () => ({
				success: true,
				message: null,
				data: [
					{ id: "event", title: "Meeting", attendees: [], deleted_at: null },
				],
			}),
		} as unknown as Pick<AkiflowClient, "get">;
		const result = await verifyEventAttendees(
			client,
			"event",
			["guest@example.com"],
			[],
			{ timeoutMs: 100 },
		);
		expect(result.status).toBe("mismatch");
		expect(result.differingFields).toEqual(["attendees"]);
		expect(result.observed?.title).toBe("Meeting");
	});
});
