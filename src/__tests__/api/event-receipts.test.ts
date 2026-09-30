import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { buildCreateEventPayload } from "../../commands/create";
import { AkiflowClient } from "../../lib/api/client";
import {
	buildCreateEventOperation,
	buildDeleteEventOperation,
	buildPatchEventOperation,
} from "../../lib/api/event-intents";
import type {
	Calendar,
	EventOperationPayload,
	MutationOperationStatus,
} from "../../lib/api/types";

const payload = buildCreateEventPayload({
	id: "synthetic-event",
	title: "Submitted title",
	startTime: "2026-06-20T16:00:00Z",
	endTime: "2026-06-20T16:30:00Z",
	timezone: "America/Los_Angeles",
	calendar: {
		id: "synthetic-calendar",
		akiflow_account_id: "synthetic-account",
		connector_id: "google",
		origin_id: "synthetic@example.com",
	} as Calendar,
});

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

function mockResponse(make: (operations: EventOperationPayload[]) => unknown) {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (_url: unknown, init?: RequestInit) =>
				new Response(JSON.stringify(make(JSON.parse(String(init?.body)))), {
					status: 200,
				}),
			{ preconnect() {} },
		),
	);
	return new AkiflowClient({
		credentials: { token: "synthetic-token", clientId: "synthetic-client" },
	});
}

describe("submitEventOperations receipt transport", () => {
	it("returns server operation results instead of submitted event fields", async () => {
		const client = mockResponse((operations) => ({
			success: true,
			message: null,
			data: operations.map((operation) => ({
				...operation,
				user_id: 1,
				status: "succeeded",
				result: { title: "Server canonical title", read_only: true },
				processed_at: "2026-06-20T16:00:01Z",
			})),
		}));
		const result = await client.submitEventOperations([
			buildCreateEventOperation(payload),
		]);
		expect(result.allAccepted).toBe(true);
		expect(result.receipts[0]?.result).toEqual({
			title: "Server canonical title",
			read_only: true,
		});
		expect(result.receipts[0]?.processed_at).toBe("2026-06-20T16:00:01Z");
		expect("data" in result).toBe(false);
		expect("success" in result).toBe(false);
		expect(result.raw.success).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
	it("does not repeat a POST after an ambiguous transport failure", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Connection lost after POST"),
		);
		const client = new AkiflowClient({
			credentials: { token: "synthetic-token", clientId: "synthetic-client" },
		});
		const result = await client.submitEventOperations([
			buildCreateEventOperation(payload),
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.receipts[0]?.status).toBe("unknown");
		expect(result.receipts[0]?.operation_id).toBeString();
		expect(result.receipts[0]?.error).toBe("Failed to connect to Akiflow API");
	});

	it("keeps receipts in submission order for create, patch and delete", async () => {
		const client = mockResponse((operations) => ({
			success: true,
			message: null,
			data: operations.toReversed().map((operation) => ({
				...operation,
				user_id: 1,
				status: "succeeded",
			})),
		}));
		const route = {
			connectorId: "google",
			accountId: "synthetic-account",
			calendarId: "synthetic-calendar",
		};
		const target = {
			id: "target-event",
			deleted_at: null,
			status: "confirmed" as const,
			read_only: false,
			hidden: false,
		};
		const result = await client.submitEventOperations([
			buildCreateEventOperation(payload, "none", 0),
			buildPatchEventOperation(
				{
					...route,
					eventId: "patch-event",
					target: { ...target, id: "patch-event" },
				},
				{ title: "Old title" },
				{ title: "New title" },
				"none",
				1,
			),
			buildDeleteEventOperation(
				{
					...route,
					eventId: "delete-event",
					target: { ...target, id: "delete-event" },
				},
				"none",
				2,
			),
		]);
		expect(result.receipts.map((receipt) => receipt.kind)).toEqual([
			"create",
			"patch",
			"delete",
		]);
		expect(result.receipts.map((receipt) => receipt.event_id)).toEqual([
			"synthetic-event",
			"patch-event",
			"delete-event",
		]);
		expect(
			result.receipts.every((receipt) => receipt.status === "accepted"),
		).toBe(true);
	});
	it("handles every uncertain and failed envelope through the actual POST", async () => {
		const cases: Array<{
			status: MutationOperationStatus;
			make: (operations: EventOperationPayload[]) => unknown;
		}> = [
			{
				status: "pending",
				make: (operations: EventOperationPayload[]) => ({
					success: true,
					data: operations.map((operation) => ({
						...operation,
						status: "pending",
					})),
				}),
			},
			{
				status: "failed",
				make: (operations: EventOperationPayload[]) => ({
					success: false,
					data: operations,
					failed: [{ id: operations[0]?.id, error: "denied" }],
				}),
			},
			{
				status: "failed",
				make: (operations: EventOperationPayload[]) => ({
					success: true,
					data: operations.map((operation) => ({
						...operation,
						failed_at: "2026-06-20T16:00:00Z",
						result: { error: "conflict" },
					})),
				}),
			},
			{
				status: "unknown",
				make: (operations: EventOperationPayload[]) => ({
					success: false,
					data: operations,
					failed: [{ id: "unmatched", error: "unexpected" }],
				}),
			},
			{ status: "unknown", make: () => ({ success: true, data: [] }) },
			{ status: "unknown", make: () => ({ success: true }) },
			{
				status: "unknown",
				make: () => ({ success: true, data: [{ id: payload.id }] }),
			},
		];
		for (const testCase of cases) {
			const client = mockResponse(testCase.make);
			const result = await client.submitEventOperations([
				buildCreateEventOperation(payload),
			]);
			expect(result.receipts[0]?.status).toBe(testCase.status);
			expect(result.allAccepted).toBe(false);
			expect("data" in result).toBe(false);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			fetchSpy?.mockRestore();
		}
	});
});
