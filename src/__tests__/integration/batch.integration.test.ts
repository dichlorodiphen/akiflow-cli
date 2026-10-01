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
	// The legacy modifiers endpoint returns HTTP 410 in production. It is
	// registered here only as a regression guard: the CLI must never call it.
	server.respondTo(
		"POST",
		"/v3/events/modifiers",
		() => ({ success: false, message: "Gone", data: [] }),
		410,
	);
	server.respondTo("PATCH", "/v5/time_slots", (req: { body: string }) => {
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

describe("af batch (BDD)", () => {
	test("adds attendee emails to selected events through a silent v5 patch operation", async () => {
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"batch",
				"events",
				"attendees",
				"add",
				"julia@example.com",
				"--date",
				"2026-05-21",
				"--search",
				"Standup",
				"--execute",
				"--json",
			],
			{ env: env.env },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		const report = envelope.result ?? envelope;
		expect(report).toMatchObject({
			mode: "execute",
			operation: "events.attendees.add",
			selected: 1,
			changed: 0,
			accepted: 1,
			noop: 0,
			skipped: 0,
			failed: 0,
		});

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload).toHaveLength(1);
		expect(payload[0]).toMatchObject({
			event_id: "event-meeting-1",
			connector_id: "google",
			account_id: "account-gmail-1",
			calendar_id: "cal-personal-1",
			operation: "patch",
			payload: {
				changes: {
					attendees: [
						{ email: "pat@example.com", name: "Pat", response: "accepted" },
						{ email: "julia@example.com", responseStatus: "needsAction" },
					],
				},
				send_updates: false,
			},
		});
		// The 410 modifiers endpoint is never touched.
		expect(
			server.requests.some(
				(r) => r.method === "POST" && r.url.pathname === "/v3/events/modifiers",
			),
		).toBe(false);
	});

	test("dry-runs attendee removal without posting operations", async () => {
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"batch",
				"events",
				"attendees",
				"remove",
				"pat@example.com",
				"--date",
				"2026-05-21",
				"--search",
				"Standup",
				"--json",
			],
			{ env: env.env },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		const report = envelope.result ?? envelope;
		expect(report).toMatchObject({
			mode: "dry-run",
			operation: "events.attendees.remove",
			selected: 1,
			changed: 1,
		});
		expect(
			server.requests.some(
				(r) =>
					r.method === "POST" &&
					(r.url.pathname === "/v5/event_operations" ||
						r.url.pathname === "/v3/events/modifiers"),
			),
		).toBe(false);
	});

	test("deletes selected events through the v5 event operations endpoint", async () => {
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"batch",
				"events",
				"delete",
				"--date",
				"2026-05-21",
				"--search",
				"Standup",
				"--send-updates",
				"none",
				"--confirm",
				"--execute",
				"--json",
			],
			{ env: env.env },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		const report = envelope.result ?? envelope;
		expect(report).toMatchObject({
			mode: "execute",
			operation: "events.delete",
			selected: 1,
			changed: 0,
			accepted: 1,
		});

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload[0]).toEqual(
			expect.objectContaining({
				event_id: "event-meeting-1",
				operation: "delete",
				payload: { send_updates: false },
			}),
		);
	});

	test("deletes selected slots through the captured v5 time slots endpoint", async () => {
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"batch",
				"slots",
				"delete",
				"--date",
				"2026-05-21",
				"--search",
				"focus",
				"--execute",
				"--json",
			],
			{ env: env.env },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		const report = envelope.result ?? envelope;
		expect(report).toMatchObject({
			mode: "execute",
			operation: "slots.delete",
			selected: 1,
			changed: 0,
			accepted: 1,
		});

		const request = server.requests.find(
			(r) => r.method === "PATCH" && r.url.pathname === "/v5/time_slots",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload).toEqual([
			{
				id: "slot-focus-1",
				deleted_at: expect.any(String),
				global_updated_at: expect.any(String),
			},
		]);
	});

	test("reports partial v5 operation failures and exits nonzero", async () => {
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);
		// Empty result data: the envelope cannot identify any operation, so
		// receipts stay unknown and the command exits nonzero.
		server.respondTo("POST", "/v5/event_operations", {
			success: true,
			message: null,
			data: [],
		});

		const result = await spawnCli(
			[
				"batch",
				"events",
				"attendees",
				"add",
				"julia@example.com",
				"--date",
				"2026-05-21",
				"--search",
				"Standup",
				"--execute",
				"--json",
			],
			{ env: env.env },
		);

		expect(result.exitCode).not.toBe(0);
		const envelope = JSON.parse(result.stdout);
		const report = envelope.result ?? envelope;
		expect(report).toMatchObject({
			mode: "execute",
			operation: "events.attendees.add",
			selected: 1,
			changed: 0,
			failed: 0,
			unknown: 1,
		});
	});
});
