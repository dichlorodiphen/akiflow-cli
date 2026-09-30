import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

let server: FakeAkiflowServer;
let env: ReturnType<typeof makeTestEnv>;

beforeEach(async () => {
	server = new FakeAkiflowServer();
	await server.start();
	loadAllFixtures(server);
	server.respondTo("POST", "/v5/event_operations", (req: { body: string }) => {
		const payload = JSON.parse(req.body);
		return {
			success: true,
			message: null,
			data: payload,
		};
	});
	server.respondTo("POST", "/v3/events/modifiers", (req: { body: string }) => {
		const payload = JSON.parse(req.body);
		return {
			success: true,
			message: null,
			data: payload,
		};
	});
	env = makeTestEnv(server.url);
});

afterEach(async () => {
	await server.stop();
	env.cleanup();
});

describe("af event (BDD)", () => {
	test("updates a cached timed event through the v5 event operations endpoint", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const expectedStart = new Date(2026, 4, 21, 10, 30).toISOString();
		const expectedEnd = new Date(2026, 4, 21, 11, 15).toISOString();
		const result = await spawnCli(
			[
				"event",
				"update",
				"event-meeting-1",
				"--date",
				"2026-05-21",
				"--at",
				"10:30",
				"--duration",
				"45m",
				"--description",
				"Updated by integration test",
				"--location",
				"Room 12",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.status).toBe("accepted");
		expect(envelope.receipts[0].event_id).toBe("event-meeting-1");
		expect(envelope.receipts[0].kind).toBe("patch");

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload[0].event_id).toBe("event-meeting-1");
		expect(payload[0].operation).toBe("patch");
		expect(payload[0].payload.changes.start_time).toBe(expectedStart);
		expect(payload[0].payload.changes.end_time).toBe(expectedEnd);
	});

	test("deletes a cached timed event through the v5 event operations endpoint", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			["event", "delete", "event-meeting-1", "--notify", "none", "--json"],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.status).toBe("accepted");
		expect(envelope.receipts[0].event_id).toBe("event-meeting-1");
		expect(envelope.receipts[0].kind).toBe("delete");

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload[0]).toEqual(
			expect.objectContaining({
				event_id: "event-meeting-1",
				operation: "delete",
				global_updated_at: expect.any(String),
				payload: { send_updates: false },
			}),
		);
	});

	test("adds attendee emails through the captured event modifiers endpoint", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"event",
				"attendees",
				"add",
				"event-meeting-1",
				"julia@example.com",
				"alex@example.com",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.schema_version).toBe(1);
		expect(envelope.status).toBe("accepted");
		expect(envelope.receipts[0].event_id).toBe("event-meeting-1");

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v3/events/modifiers",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload[0].calendar_id).toBe("cal-personal-1");
		expect(payload[0].akiflow_account_id).toBe("account-gmail-1");
	});

	test("does not post attendee modifier payloads for no-op additions", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"event",
				"attendees",
				"add",
				"event-meeting-1",
				"pat@example.com",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).result).toEqual(
			expect.objectContaining({
				event_id: "event-meeting-1",
				action: "add",
				requested: 1,
				changed: 0,
			}),
		);
		expect(
			server.requests.some(
				(r) => r.method === "POST" && r.url.pathname === "/v3/events/modifiers",
			),
		).toBe(false);
	});
});
