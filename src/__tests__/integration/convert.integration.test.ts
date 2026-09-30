import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
	server.seed("tasks", [convertTaskFixture()]);
	server.seed("events", []);

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
		expect(server.snapshot("events")).toHaveLength(1);
		expect(server.snapshot("tasks")[0]?.deleted_at).toEqual(expect.any(String));
		const summary = JSON.parse(result.stdout);
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
