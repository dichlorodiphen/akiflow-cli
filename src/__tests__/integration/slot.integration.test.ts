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
	server.respondTo("PATCH", "/v5/tasks", (req: { body: string }) => {
		const payload = JSON.parse(req.body);
		return {
			success: true,
			message: null,
			data: payload,
		};
	});
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

function loadSlotTasksFixture() {
	server.respondTo("GET", "/v5/tasks", {
		success: true,
		message: null,
		data: [
			{
				id: "task-linked-1",
				title: "Linked fixture task",
				time_slot_id: "slot-focus-1",
				deleted_at: null,
			},
			{
				id: "task-add-1",
				title: "Task to add",
				time_slot_id: null,
				deleted_at: null,
			},
		],
		sync_token: "slot-task-token",
		has_next_page: false,
	});
}

describe("af slot (BDD)", () => {
	test("lists and shows cached task slots with linked tasks", async () => {
		loadSlotTasksFixture();
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);

		const list = await spawnCli(
			["slot", "list", "--date", "2026-05-21", "--search", "focus", "--json"],
			{ env: env.env },
		);
		expect(list.exitCode).toBe(0);
		const listed = JSON.parse(list.stdout);
		expect(listed).toHaveLength(1);
		expect(listed[0].slot.id).toBe("slot-focus-1");
		expect(listed[0].tasks.map((task: { id: string }) => task.id)).toEqual([
			"task-linked-1",
		]);

		const show = await spawnCli(["slot", "show", "slot-focus-1", "--json"], {
			env: env.env,
		});
		expect(show.exitCode).toBe(0);
		const shown = JSON.parse(show.stdout);
		expect(shown.slot.id).toBe("slot-focus-1");
		expect(shown.tasks).toHaveLength(1);
	});

	test("updates a cached slot and patches task membership", async () => {
		loadSlotTasksFixture();
		const commandEnv = { ...env.env, TZ: "America/Los_Angeles" };
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: commandEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const expectedStart = "2026-05-22T16:30:00.000Z";
		const expectedEnd = "2026-05-22T17:15:00.000Z";
		const result = await spawnCli(
			[
				"slot",
				"update",
				"slot-focus-1",
				"--title",
				"Updated fixture slot",
				"--date",
				"2026-05-22",
				"--at",
				"09:30",
				"--duration",
				"45m",
				"--add-task-id",
				"task-add-1",
				"--remove-task-id",
				"task-linked-1",
				"--json",
			],
			{ env: commandEnv },
		);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.slot).toMatchObject({
			id: "slot-focus-1",
			title: "Updated fixture slot",
			start_time: expectedStart,
			end_time: expectedEnd,
		});
		expect(output.tasks.map((task: { id: string }) => task.id).sort()).toEqual([
			"task-add-1",
			"task-linked-1",
		]);

		const slotRequest = server.requests.find(
			(r) => r.method === "PATCH" && r.url.pathname === "/v5/time_slots",
		);
		expect(slotRequest).toBeDefined();
		const slotPayload = JSON.parse(slotRequest!.body);
		expect(slotPayload[0]).toMatchObject({
			id: "slot-focus-1",
			title: "Updated fixture slot",
			start_time: expectedStart,
			end_time: expectedEnd,
			global_updated_at: expect.any(String),
		});

		const taskRequest = server.requests.find(
			(r) => r.method === "PATCH" && r.url.pathname === "/v5/tasks",
		);
		expect(taskRequest).toBeDefined();
		const taskPayload = JSON.parse(taskRequest!.body);
		expect(taskPayload).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "task-add-1",
					date: "2026-05-22",
					datetime: expectedStart,
					time_slot_id: "slot-focus-1",
					status: 2,
				}),
				expect.objectContaining({
					id: "task-linked-1",
					time_slot_id: null,
				}),
			]),
		);
	});

	test("deletes a cached slot through the captured v5 time slots endpoint", async () => {
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: env.env,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			["slot", "delete", "slot-focus-1", "--json"],
			{ env: env.env },
		);

		expect(result.exitCode).toBe(0);
		const deletedSlot = JSON.parse(result.stdout);
		expect(deletedSlot).toEqual({
			id: "slot-focus-1",
			deleted_at: expect.any(String),
			global_updated_at: expect.any(String),
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
});
