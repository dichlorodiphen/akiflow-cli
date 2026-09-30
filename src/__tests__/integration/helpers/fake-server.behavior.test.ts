import { describe, expect, test } from "bun:test";
import type { EventOperationPayload } from "../../../lib/api/types";
import { DroppedConnection, FakeAkiflowServer } from "./fake-server";

function operation(
	eventId = "event-a",
	kind: EventOperationPayload["operation"] = "create",
): EventOperationPayload {
	return {
		id: crypto.randomUUID(),
		event_id: eventId,
		connector_id: "google",
		account_id: "account-a",
		calendar_id: "calendar-a",
		operation: kind,
		payload:
			kind === "create"
				? {
						event: {
							title: "  Canonical title  ",
							start_time: "2026-09-30T09:00:00Z",
							end_time: "2026-09-30T10:00:00Z",
						},
					}
				: { changes: { title: "Changed" } },
		result: null,
		processed_at: null,
		failed_at: null,
		client_order: 0,
		global_created_at: "2099-01-01T00:00:00Z",
		global_updated_at: "2099-01-01T00:00:00Z",
		deleted_at: null,
	};
}
function request(
	server: FakeAkiflowServer,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
) {
	return server.dispatch(
		new Request(`http://127.0.0.1${path}`, {
			method:
				body === undefined
					? "GET"
					: path.includes("event_operations")
						? "POST"
						: "PATCH",
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
async function read(server: FakeAkiflowServer, path: string, body?: unknown) {
	return (await (await request(server, path, body)).json()) as {
		success: boolean;
		data: { id: string; status: string; result: Record<string, unknown> }[];
		sync_token: string;
		has_next_page: boolean;
	};
}

describe("behavioral fake model (no sockets)", () => {
	test("canonical events and receipts diverge from the submitted payload and dedupe operation retries", async () => {
		const server = new FakeAkiflowServer();
		const input = operation();
		const receipt = await read(server, "/v5/event_operations", [input]);
		expect(receipt.data[0]).toMatchObject({
			status: "succeeded",
			failed_at: null,
			processed_at: expect.any(String),
			result: { title: "Canonical title", origin_id: expect.any(String) },
		});
		expect(receipt.data[0]?.id).not.toBe(input.id);
		expect(server.operationHistory.map((h) => h.status)).toEqual([
			"pending",
			"succeeded",
		]);
		const events = await read(server, "/v5/events");
		expect(events.data[0]).toMatchObject({
			id: input.event_id,
			title: "Canonical title",
			created_at: expect.any(String),
			updated_at: expect.any(String),
			global_created_at: "2026-01-01T00:00:00.002Z",
		});
		await read(server, "/v5/event_operations", [input]);
		expect(server.operations.size).toBe(1);
		expect(server.snapshot("events")).toHaveLength(1);
	});
	test("tasks and slots normalize and PATCH date-only leaves the timed instant intact", async () => {
		const server = new FakeAkiflowServer();
		server.scenarios.snooze("task-a");
		await read(server, "/v5/tasks", [
			{ id: "task-a", title: "  Trim me  ", date: "2026-10-01" },
		]);
		expect((await read(server, "/v5/tasks")).data[0]).toMatchObject({
			title: "Trim me",
			date: "2026-10-01",
			datetime: "2026-09-30T16:00:00.000Z",
			datetime_tz: "America/Los_Angeles",
		});
		await read(server, "/v5/time_slots", [
			{ id: "slot-a", title: "  Focus  " },
		]);
		expect((await read(server, "/v5/time_slots")).data[0]).toMatchObject({
			title: "Focus",
			status: "confirmed",
			origin_id: expect.any(String),
		});
	});
	test("pending operations transition only after configured further requests; visibility is independently delayed", async () => {
		const server = new FakeAkiflowServer({
			operationDelayRequests: 1,
			visibilityRequests: 1,
		});
		const receipt = await read(server, "/v5/event_operations", [operation()]);
		expect(receipt.data[0]).toMatchObject({
			status: "pending",
			processed_at: null,
			failed_at: null,
			result: null,
		});
		expect((await read(server, "/v5/events")).data).toEqual([]);
		expect((await read(server, "/v5/events")).data).toEqual([]);
		expect(server.snapshot("events")).toHaveLength(1);
		expect((await read(server, "/v5/events")).data).toEqual([]);
		expect((await read(server, "/v5/events")).data).toHaveLength(1);
	});
	test("millisecond visibility delay publishes at a later GET", async () => {
		const server = new FakeAkiflowServer({ visibilityMs: 20 });
		await read(server, "/v5/event_operations", [operation()]);
		expect((await read(server, "/v5/events")).data).toEqual([]);
		await Bun.sleep(25);
		expect((await read(server, "/v5/events")).data).toHaveLength(1);
	});
	test("mixed and envelope failures preserve per-operation status and canonical truth", async () => {
		const server = new FakeAkiflowServer().scenarios.mixedBatch(
			(op) => op.event_id === "bad",
		);
		const result = await read(server, "/v5/event_operations", [
			operation("good"),
			operation("bad"),
		]);
		expect(result.success).toBe(true);
		expect(result.data.map((op: { status: string }) => op.status)).toEqual([
			"succeeded",
			"failed",
		]);
		expect(result.data[1]).toMatchObject({
			processed_at: null,
			failed_at: expect.any(String),
			result: { error: "operation_rejected" },
		});
		expect(server.snapshot("events").map((r) => r.id)).toEqual(["good"]);
		server.scenarios.fabricatedAcceptance(true);
		expect(
			(await read(server, "/v5/event_operations", [operation("rejected")]))
				.success,
		).toBe(false);
		expect(server.snapshot("events")).toHaveLength(1);
	});
	test("resource cursors advance per page, repeat boundary rows, freeze pages and emit tombstones once per delta", async () => {
		const server = new FakeAkiflowServer({
			pageSize: 1,
			duplicatePageBoundaries: true,
		}).seed("tasks", [{ id: "a" }, { id: "b" }]);
		const page1 = await read(server, "/v5/tasks");
		await read(server, "/v5/tasks", [{ id: "c" }]);
		const page2 = await read(
			server,
			`/v5/tasks?sync_token=${page1.sync_token}`,
		);
		expect(page1.has_next_page).toBe(true);
		expect(page2.has_next_page).toBe(false);
		expect(page2.sync_token).not.toBe(page1.sync_token);
		expect(page2.data.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
		const delta = await read(
			server,
			`/v5/tasks?sync_token=${page2.sync_token}`,
		);
		expect(delta.data.map((r: { id: string }) => r.id)).toEqual(["c"]);
		await read(server, "/v5/tasks", [
			{ id: "a", deleted_at: "2026-09-30T00:00:00Z" },
		]);
		const tombstone = await read(
			server,
			`/v5/tasks?sync_token=${delta.sync_token}`,
		);
		expect(tombstone.data[0]).toMatchObject({
			id: "a",
			deleted_at: expect.any(String),
		});
		expect(
			(await read(server, `/v5/tasks?sync_token=${tombstone.sync_token}`)).data,
		).toEqual([]);
		expect(
			(await request(server, `/v5/events?sync_token=${page1.sync_token}`))
				.status,
		).toBe(410);
		server.expireToken("tasks");
		expect(
			(await request(server, `/v5/tasks?sync_token=${tombstone.sync_token}`))
				.status,
		).toBe(410);
		expect((await request(server, "/v5/tasks")).status).toBe(200);
	});
	test("faults match arrival index, path and predicate once; after-apply leaves a canonical mutation", async () => {
		const server = new FakeAkiflowServer().schedule(
			{ index: 1, type: "rate-limit", retryAfter: 2 },
			{
				path: "/v5/tasks",
				predicate: (r) => r.method === "PATCH",
				type: "latency",
				ms: 20,
			},
			{ path: "/v5/event_operations", type: "after-apply" },
		);
		const rate = await request(server, "/v5/tasks");
		expect(rate.status).toBe(429);
		expect(rate.headers.get("retry-after")).toBe("2");
		const start = performance.now();
		await read(server, "/v5/tasks", [{ id: "a" }]);
		expect(performance.now() - start).toBeGreaterThanOrEqual(18);
		expect(
			(await request(server, "/v5/event_operations", [operation()])).status,
		).toBe(500);
		expect(server.snapshot("events")).toHaveLength(1);
		server.schedule({ type: "drop", index: server.requests.length + 1 });
		await expect(request(server, "/v5/tasks")).rejects.toBeInstanceOf(
			DroppedConnection,
		);
		expect((await request(server, "/v5/tasks")).status).toBe(200);
	});
	test("strict stale bases fail and non-strict competing snapshots apply in sequence", async () => {
		const server = new FakeAkiflowServer({ strictBase: true });
		await read(server, "/v5/event_operations", [operation()]);
		const update = operation("event-a", "patch");
		update.payload = {
			base: { title: "outdated" },
			changes: { title: "Next" },
		};
		expect(
			(await read(server, "/v5/event_operations", [update])).data[0]?.result
				.error,
		).toBe("stale_base");
		server.options.strictBase = false;
		await read(server, "/v5/event_operations", [
			{ ...update, id: crypto.randomUUID() },
		]);
		expect(server.snapshot("events")[0]?.title).toBe("Next");
	});
	test("request gates suspend one matching request while another finishes", async () => {
		const server = new FakeAkiflowServer();
		const gate = server.scenarios.lockRace();
		const blocked = read(server, "/v5/tasks");
		await gate.entered;
		try {
			expect((await read(server, "/v5/tasks")).success).toBe(true);
		} finally {
			gate.release();
		}
		expect((await blocked).success).toBe(true);
	});
	test("single 401 refresh endpoint rotates tokens and rejects the old bearer", async () => {
		const server = new FakeAkiflowServer().force401();
		expect((await request(server, "/v5/tasks")).status).toBe(401);
		const refreshed = await server.dispatch(
			new Request("http://127.0.0.1/oauth/refreshToken", {
				method: "POST",
				body: JSON.stringify({
					client_id: "10",
					refresh_token: "fake-refresh",
				}),
			}),
		);
		const tokens = (await refreshed.json()) as { access_token: string };
		expect(
			(
				await request(server, "/v5/tasks", undefined, {
					authorization: `Bearer ${tokens.access_token}`,
				})
			).status,
		).toBe(200);
		expect(
			(
				await request(server, "/v5/tasks", undefined, {
					authorization: "Bearer old",
				})
			).status,
		).toBe(401);
	});
});
