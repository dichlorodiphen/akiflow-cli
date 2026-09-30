import { describe, expect, spyOn, test } from "bun:test";
import type { AkiflowClient } from "../../lib/api/client";
import {
	printTaskMutation,
	taskMutationOutcome,
	unknownTaskOutcome,
} from "../../lib/task-mutation-output";

const client = {
	get: async () => ({
		success: true,
		message: null,
		data: [{ id: "a", title: "Observed" }],
	}),
} as unknown as AkiflowClient;

describe("task mutation command receipts", () => {
	test("names accepted, failed, and omitted IDs separately", async () => {
		const result = await taskMutationOutcome(
			client,
			{
				success: false,
				message: null,
				data: [{ id: "a" }],
				failed: [{ id: "b", error: "Rejected" }],
			},
			[{ id: "a" }, { id: "b" }, { id: "c" }],
			false,
		);
		expect(result.ok).toBe(false);
		expect(result.receipts.map((r) => [r.id, r.status])).toEqual([
			["a", "accepted"],
			["b", "failed"],
			["c", "unknown"],
		]);
		expect(result.errors.join(" ")).toContain("b");
	});
	test("aggregate failure cannot invent failed IDs", async () => {
		const result = await taskMutationOutcome(
			client,
			{ success: false, message: null, data: [] },
			[{ id: "a" }],
			false,
		);
		expect(result.receipts[0]?.status).toBe("unknown");
		expect(result.ok).toBe(false);
	});
	test("accepted response requires every requested ID", async () => {
		const result = await taskMutationOutcome(
			client,
			{ success: true, message: null, data: [{ id: "a" }] },
			[{ id: "a" }, { id: "b" }],
			false,
		);
		expect(result.ok).toBe(false);
		expect(result.receipts[1]?.status).toBe("unknown");
	});
	test("verification compares fresh observed task fields", async () => {
		const result = await taskMutationOutcome(
			client,
			{ success: true, message: null, data: [{ id: "a" }] },
			[{ id: "a", title: "Observed" } as { id: string }],
			true,
		);
		expect(result.ok).toBe(true);
		expect(result.receipts[0]?.status).toBe("verified");
	});
	test("verification refuses a visible mismatch", async () => {
		const result = await taskMutationOutcome(
			client,
			{ success: true, message: null, data: [{ id: "a" }] },
			[{ id: "a", title: "Requested" } as { id: string }],
			true,
		);
		expect(result.ok).toBe(false);
		expect(result.receipts[0]?.status).toBe("mismatch");
		expect(result.receipts[0]?.differingFields).toEqual(["title"]);
	});
	test("transport uncertainty creates unknown receipts without a retry", () => {
		const result = unknownTaskOutcome(["a", "b"], new Error("Connection lost"));
		expect(result.ok).toBe(false);
		expect(result.receipts.every((r) => r.status === "unknown")).toBe(true);
		expect(result.errors).toEqual(["Connection lost"]);
	});
	test("partial JSON output preserves failed IDs and exits nonzero", async () => {
		const outcome = await taskMutationOutcome(
			client,
			{
				success: true,
				message: null,
				data: [{ id: "a" }],
				failed: [{ id: "b", error: "Invalid task" }],
			},
			[{ id: "a" }, { id: "b" }],
			false,
		);
		const log = spyOn(console, "log").mockImplementation(() => {});
		const previousExit = process.exitCode;
		try {
			expect(
				printTaskMutation("task complete", true, [outcome], [{ id: "a" }]),
			).toBe(false);
			const envelope = JSON.parse(String(log.mock.calls[0]?.[0]));
			expect(envelope.schema_version).toBe(1);
			expect(envelope.command).toBe("task complete");
			expect(envelope.status).toBe("failed");
			expect(envelope.receipts).toContainEqual(
				expect.objectContaining({ id: "b", status: "failed" }),
			);
			expect(envelope.errors.join(" ")).toContain("b");
			expect(process.exitCode).toBe(1);
		} finally {
			log.mockRestore();
			process.exitCode = previousExit ?? 0;
		}
	});
});
