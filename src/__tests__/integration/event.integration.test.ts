import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eventLifecycle } from "./helpers/event-lifecycle";
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
	// The legacy modifiers endpoint returns HTTP 410 in production. It is
	// registered here only as a regression guard: the CLI must never call it.
	server.respondTo(
		"POST",
		"/v3/events/modifiers",
		() => ({ success: false, message: "Gone", data: [] }),
		410,
	);
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

		// The event is in America/New_York. Workstream F: --at is interpreted
		// in the event's zone (not the host TZ). 10:30 EDT (UTC-4) = 14:30 UTC.
		const expectedStart = "2026-05-21T14:30:00.000Z";
		const expectedEnd = "2026-05-21T15:15:00.000Z";
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
			[
				"event",
				"delete",
				"event-meeting-1",
				"--send-updates",
				"all",
				"--confirm",
				"--json",
			],
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
				payload: { send_updates: true },
			}),
		);
	});

	test("adds attendee emails through a silent v5 patch operation, never the 410 modifiers endpoint", async () => {
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
		expect(envelope.receipts[0].kind).toBe("patch");

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload).toHaveLength(1);
		expect(payload[0]).toEqual(
			expect.objectContaining({
				event_id: "event-meeting-1",
				connector_id: "google",
				account_id: "account-gmail-1",
				calendar_id: "cal-personal-1",
				operation: "patch",
			}),
		);
		// Silent by default: guests get no email.
		expect(payload[0].payload.send_updates).toBe(false);
		// The full merged attendee list rides the patch; existing members are
		// preserved and new ones are marked needsAction.
		expect(payload[0].payload.changes.attendees).toEqual([
			{ email: "pat@example.com", name: "Pat", response: "accepted" },
			{ email: "julia@example.com", responseStatus: "needsAction" },
			{ email: "alex@example.com", responseStatus: "needsAction" },
		]);
		// The 410 modifiers endpoint is never touched.
		expect(
			server.requests.some(
				(r) => r.method === "POST" && r.url.pathname === "/v3/events/modifiers",
			),
		).toBe(false);
	});

	test("verifies attendee membership with a fresh server read after --verify", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		// eventLifecycle applies submitted operations to its event records
		// and echoes the client's operation ids, so the verification pass
		// reads back genuinely updated state.
		eventLifecycle(server);

		const result = await spawnCli(
			[
				"event",
				"attendees",
				"add",
				"event-meeting-1",
				"julia@example.com",
				"--verify",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.status).toBe("verified");
		expect(envelope.receipts[0].event_id).toBe("event-meeting-1");
		expect(envelope.receipts[0].kind).toBe("patch");

		const requests = server.requests;
		const postIndex = requests.findIndex(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(postIndex).toBeGreaterThanOrEqual(0);
		// A verification read of /v5/events happens strictly after the mutation POST.
		const verifyIndex = requests.findIndex(
			(r, index) =>
				index > postIndex &&
				r.method === "GET" &&
				r.url.pathname === "/v5/events",
		);
		expect(verifyIndex).toBeGreaterThan(postIndex);
		// The 410 modifiers endpoint is never touched.
		expect(
			requests.some(
				(r) => r.method === "POST" && r.url.pathname === "/v3/events/modifiers",
			),
		).toBe(false);
	});

	test("does not post attendee patch operations for no-op additions", async () => {
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
				(r) =>
					r.method === "POST" &&
					(r.url.pathname === "/v5/event_operations" ||
						r.url.pathname === "/v3/events/modifiers"),
			),
		).toBe(false);
	});

	test("refreshes attendee state before no-op decisions without a prior rebuild", async () => {
		// No `refresh --rebuild` here: the cache starts empty, so the no-op
		// decision can only succeed if the command refreshes first.
		const testEnv = { ...env.env, TZ: "UTC" };

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
				(r) =>
					r.method === "POST" &&
					(r.url.pathname === "/v5/event_operations" ||
						r.url.pathname === "/v3/events/modifiers"),
			),
		).toBe(false);
	});
});
