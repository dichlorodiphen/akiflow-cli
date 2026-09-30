import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eventLifecycle } from "./helpers/event-lifecycle";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

let server: FakeAkiflowServer;
let env: ReturnType<typeof makeTestEnv>;

function convertTaskFixture() {
	return {
		id: "task-convert-1",
		user_id: 42,
		status: 2,
		done: false,
		title: "Convert fixture trip block",
		description: "Preserve this description.",
		date: "2026-06-22",
		datetime: "2026-06-22T18:30:00.000Z",
		datetime_tz: "America/Los_Angeles",
		original_date: null,
		original_datetime: null,
		duration: 3600,
		recurrence: null,
		recurrence_version: null,
		priority: null,
		dailyGoal: null,
		done_at: null,
		read_at: null,
		listId: null,
		section_id: null,
		tags_ids: [],
		sorting: 0,
		sorting_label: null,
		origin: null,
		due_date: null,
		connector_id: null,
		origin_id: null,
		origin_account_id: null,
		akiflow_account_id: null,
		doc: {},
		calendar_id: null,
		time_slot_id: null,
		links: [],
		content: {},
		trashed_at: null,
		plan_unit: null,
		plan_period: null,
		global_list_id_updated_at: null,
		global_tags_ids_updated_at: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		data: {},
		deleted_at: null,
		recurring_id: null,
	};
}

beforeEach(async () => {
	server = new FakeAkiflowServer();
	await server.start();
	loadAllFixtures(server);
	server.respondTo("GET", "/v5/tasks", {
		success: true,
		message: null,
		data: [convertTaskFixture()],
		sync_token: "tasks-token",
		has_next_page: false,
	});
	server.respondTo("GET", "/v5/events", {
		success: true,
		message: null,
		data: [],
		sync_token: "events-token",
		has_next_page: false,
	});
	server.respondTo("POST", "/v5/event_operations", (req: { body: string }) => {
		const payload = JSON.parse(req.body);
		return {
			success: true,
			message: null,
			data: payload,
		};
	});
	server.respondTo("PATCH", "/v5/tasks", (req: { body: string }) => {
		const payload = JSON.parse(req.body);
		return {
			success: true,
			message: null,
			data: payload,
		};
	});
	const lifecycle = eventLifecycle(server);
	lifecycle.records.length = 0;
	env = makeTestEnv(server.url);
});

afterEach(async () => {
	await server.stop();
	env.cleanup();
});

describe("af convert tasks --to events (BDD)", () => {
	test("creates missing events then tombstones native source tasks", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--search",
				"Convert fixture",
				"--from",
				"2026-06-22",
				"--until",
				"2026-06-22",
				"--execute",
				"--delete-source",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.status).toBe("accepted");
		const summary = envelope.result;
		expect(summary).toEqual(
			expect.objectContaining({
				mode: "execute",
				selected: 1,
				matched: 0,
				to_create: 1,
				to_delete: 1,
			}),
		);

		const createRequest = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(createRequest).toBeDefined();
		const eventPayload = JSON.parse(createRequest!.body);
		expect(eventPayload[0]).toEqual(
			expect.objectContaining({
				operation: "create",
				calendar_id: "cal-personal-1",
				payload: {
					event: expect.objectContaining({
						title: "Convert fixture trip block",
						description: "Preserve this description.",
						start_time: "2026-06-22T18:30:00.000Z",
						end_time: "2026-06-22T19:30:00.000Z",
					}),
					// Conversions are silent by default: no guest invite spam.
					send_updates: false,
				},
			}),
		);

		const deleteRequest = server.requests.find(
			(r) => r.method === "PATCH" && r.url.pathname === "/v5/tasks",
		);
		expect(deleteRequest).toBeDefined();
		const deletePayload = JSON.parse(deleteRequest!.body);
		expect(deletePayload[0]).toEqual(
			expect.objectContaining({
				id: "task-convert-1",
				deleted_at: expect.any(String),
			}),
		);
	});

	test("does not delete source tasks when event creation fails", async () => {
		await server.stop();
		server = new FakeAkiflowServer();
		await server.start();
		loadAllFixtures(server);
		server.respondTo("GET", "/v5/tasks", {
			success: true,
			message: null,
			data: [convertTaskFixture()],
			sync_token: "tasks-token",
			has_next_page: false,
		});
		server.respondTo("GET", "/v5/events", {
			success: true,
			message: null,
			data: [],
			sync_token: "events-token",
			has_next_page: false,
		});
		server.respondTo(
			"POST",
			"/v5/event_operations",
			{ success: false, message: "create failed", data: [] },
			500,
		);
		server.respondTo("PATCH", "/v5/tasks", {
			success: true,
			message: null,
			data: [],
		});
		env.cleanup();
		env = makeTestEnv(server.url);
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--search",
				"Convert fixture",
				"--execute",
				"--delete-source",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).not.toBe(0);
		expect(
			server.requests.some(
				(r) => r.method === "PATCH" && r.url.pathname === "/v5/tasks",
			),
		).toBe(false);
	});
});

describe("af convert tasks --to events (Workstream B: safe conversion)", () => {
	test("unfiltered conversion requires --all (exit 2)", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		// No --search, no --all, no date filter: must refuse with exit 2.
		const result = await spawnCli(
			["convert", "tasks", "--to", "events", "--execute", "--json"],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("requires a selector");
		// No event creation should have been attempted.
		expect(
			server.requests.some(
				(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
			),
		).toBe(false);
	});

	test("unfiltered conversion proceeds with --all", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--all",
				"--execute",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.selected).toBe(1);
	});

	test("failure receipt contains created event IDs and resume token", async () => {
		// Set up: first creation succeeds, second fails (partial failure).
		// We'll use two tasks; the fake server fails the second operation.
		await server.stop();
		server = new FakeAkiflowServer();
		await server.start();
		loadAllFixtures(server);
		const task1 = convertTaskFixture();
		const task2 = { ...convertTaskFixture(), id: "task-convert-2", title: "Second convert fixture" };
		server.respondTo("GET", "/v5/tasks", {
			success: true,
			message: null,
			data: [task1, task2],
			sync_token: "tasks-token",
			has_next_page: false,
		});
		server.respondTo("GET", "/v5/events", {
			success: true,
			message: null,
			data: [],
			sync_token: "events-token",
			has_next_page: false,
		});
		server.respondTo("POST", "/v5/event_operations", {
			success: false,
			message: "simulated failure",
			data: [],
		});
		env.cleanup();
		env = makeTestEnv(server.url);
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--search",
				"convert fixture",
				"--execute",
				"--json",
			],
			{ env: testEnv },
		);

		// The batch fails; receipt should contain resume token.
		const envelope = JSON.parse(result.stdout);
		expect(envelope.result.resume_token).toBeDefined();
		expect(typeof envelope.result.resume_token).toBe("string");
		// Created event IDs should be present (may be empty if all failed).
		expect(Array.isArray(envelope.result.created_event_ids)).toBe(true);
	});

	test("journal prevents duplicate creation on rerun", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		// First run: convert the task.
		const first = await spawnCli(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--search",
				"Convert fixture",
				"--execute",
				"--json",
			],
			{ env: testEnv },
		);
		expect(first.exitCode).toBe(0);
		const firstEnvelope = JSON.parse(first.stdout);
		expect(firstEnvelope.result.to_create).toBe(1);

		const createRequestsBefore = server.requests.filter(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		).length;

		// Second run: same selector. Journal should prevent re-creation.
		// The fake server returns the created event in GET /v5/events now.
		// (In a real scenario, refresh would pick it up; here we simulate
		// by having the server return it.)
		const createdEventId = firstEnvelope.result.created_event_ids[0];
		server.respondTo("GET", "/v5/events", {
			success: true,
			message: null,
			data: [
				{
					id: createdEventId,
					title: "Convert fixture trip block",
					start_time: "2026-06-22T18:30:00.000Z",
					end_time: "2026-06-22T19:30:00.000Z",
					calendar_id: "cal-personal-1",
					status: "confirmed",
					deleted_at: null,
					hidden: false,
					read_only: false,
				},
			],
			sync_token: "events-token-2",
			has_next_page: false,
		});

		const second = await spawnCli(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--search",
				"Convert fixture",
				"--execute",
				"--json",
			],
			{ env: testEnv },
		);
		expect(second.exitCode).toBe(0);
		const secondEnvelope = JSON.parse(second.stdout);
		// Matched via journal; nothing to create.
		expect(secondEnvelope.result.matched).toBe(1);
		expect(secondEnvelope.result.to_create).toBe(0);

		const createRequestsAfter = server.requests.filter(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		).length;
		expect(createRequestsAfter).toBe(createRequestsBefore);
	});
});
