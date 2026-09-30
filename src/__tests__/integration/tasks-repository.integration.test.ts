import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fixtures from "./fixtures/tasks.json";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";
import { eventLifecycle } from "./helpers/event-lifecycle";

const id = "11111111-2222-4333-8444-555555555555";
let server: FakeAkiflowServer;
let env: ReturnType<typeof makeTestEnv>;
let observed: Record<string, unknown>[];
const task = (fields: Record<string, unknown> = {}) => ({
	...fixtures[0],
	id,
	title: "Repository task",
	status: 2,
	date: "2026-05-21",
	datetime: "2026-05-21T09:00:00.000Z",
	datetime_tz: "UTC",
	duration: 1800,
	time_slot_id: "slot-focus-1",
	...fields,
});
const cli = (args: string[]) =>
	spawnCli(args, { env: { ...env.env, TZ: "UTC" }, timeoutMs: 20000 });
async function json(args: string[]) {
	const response = await cli(args);
	expect(response.exitCode, response.stderr).toBe(0);
	return JSON.parse(response.stdout);
}
async function list(raw = true) {
	return (await json(["task", "list", "--all", raw ? "--raw" : "--json"]))
		.result as Record<string, unknown>[];
}
async function cal(raw = true) {
	return (
		await json([
			"cal",
			"--from",
			"2026-05-20",
			"--to",
			"2026-05-30",
			"--no-events",
			"--no-slots",
			raw ? "--raw" : "--json",
		])
	).result as Record<string, unknown>[];
}
const intents = () =>
	JSON.parse(readFileSync(join(env.cacheDir, "pending-tasks.json"), "utf8"))
		.intents as Record<string, unknown>[];

beforeEach(async () => {
	server = new FakeAkiflowServer();
	await server.start();
	loadAllFixtures(server);
	const lifecycle = eventLifecycle(server);
	lifecycle.records.length = 0;
	observed = [task()];
	server.respondTo("GET", "/v5/tasks", () => ({
		success: true,
		message: null,
		data: observed,
		sync_token: "repository-token",
		has_next_page: false,
	}));
	// Acknowledgement echoes the write; GET deliberately remains stale.
	server.respondTo("PATCH", "/v5/tasks", ({ body }: { body: string }) => ({
		success: true,
		message: null,
		data: JSON.parse(body),
	}));
	server.respondTo("PATCH", "/v5/time_slots", ({ body }: { body: string }) => ({
		success: true,
		message: null,
		data: JSON.parse(body),
	}));
	env = makeTestEnv(server.url);
	const response = await cli(["refresh", "--rebuild"]);
	expect(response.exitCode, response.stderr).toBe(0);
	server.requests.length = 0;
});
afterEach(async () => {
	await server.stop();
	env?.cleanup();
});

describe("unified repository command regressions", () => {
	const cases = [
		{
			kind: "create",
			args: [
				"task",
				"create",
				"Created pending",
				"--date",
				"2026-05-21",
				"--at",
				"10:00",
				"--duration",
				"30m",
				"--json",
			],
			fields: {
				title: "Created pending",
				datetime: "2026-05-21T10:00:00.000Z",
			},
		},
		{
			kind: "update",
			args: [
				"task",
				"update",
				id,
				"--title",
				"Updated pending",
				"--duration",
				"45m",
			],
			fields: { title: "Updated pending", duration: 2700 },
		},
		{
			kind: "plan",
			args: ["task", "plan", id, "--date", "2026-05-22", "--at", "11:00"],
			fields: { date: "2026-05-22", datetime: "2026-05-22T11:00:00.000Z" },
		},
		{
			kind: "snooze",
			args: ["task", "snooze", id, "--duration", "1d"],
			fields: { date: "2026-05-22", datetime: "2026-05-22T09:00:00.000Z" },
		},
		{
			kind: "complete",
			args: ["task", "complete", id],
			fields: { done: true, status: 2 },
		},
		{ kind: "delete", args: ["task", "delete", id], fields: {} },
	];
	for (const scenario of cases)
		test(`list and cal agree immediately after ${scenario.kind} while observations lag`, async () => {
			const response = await cli(scenario.args);
			expect(response.exitCode, response.stderr).toBe(0);
			const target =
				scenario.kind === "create" ? JSON.parse(response.stdout).result.id : id;
			const listed = (await list()).find((t) => t.id === target);
			const calendarRow = (await cal()).find(
				(t) => (t.record as Record<string, unknown>)?.id === target,
			);
			if (scenario.kind === "delete") {
				expect(listed).toBeUndefined();
				expect(calendarRow).toBeUndefined();
			} else {
				expect(listed).toMatchObject({ ...scenario.fields, pending: true });
				expect(calendarRow?.record).toMatchObject({
					...scenario.fields,
					pending: true,
				});
				expect(calendarRow?.pending).toBe(true);
				expect((await list(false)).find((t) => t.id === target)?.pending).toBe(
					true,
				);
				expect((await cal(false)).find((t) => t.id === target)?.pending).toBe(
					true,
				);
			}
			expect(
				intents().some((i) => i.kind === scenario.kind && i.taskId === target),
			).toBe(true);
			expect(
				server.requests.filter(
					(r) => r.method === "GET" && r.url.pathname === "/v5/tasks",
				),
			).toHaveLength(0);
		}, 20_000);

	test("date-only planning clears an old timed schedule in both views", async () => {
		const planned = await cli(["task", "plan", id, "--date", "2026-05-22"]);
		expect(planned.exitCode, planned.stderr).toBe(0);
		expect((await list())[0]).toMatchObject({
			date: "2026-05-22",
			datetime: null,
			datetime_tz: null,
			status: 2,
			pending: true,
		});
		expect(await cal()).toHaveLength(0);
	}, 20_000);
	test("generated virtual rows remain query-only and completing a master stays sticky", async () => {
		observed = [
			task({
				date: "2026-01-01",
				datetime: null,
				original_date: "2026-01-01",
				recurrence: "RRULE:FREQ=DAILY",
			}),
		];
		await cli(["refresh", "--rebuild"]);
		const report = await json(["task", "list", "--raw"]);
		expect(
			report.result.some((t: { id: string }) => t.id.startsWith("virtual:")),
		).toBe(true);
		const virtualShortId =
			report.result.findIndex((t: { id: string }) =>
				t.id.startsWith("virtual:"),
			) + 1;
		const rejected = await cli(["task", "complete", String(virtualShortId)]);
		expect(rejected.exitCode).not.toBe(0);
		expect(rejected.stderr).toContain(
			"Synthetic task ID",
		);
		expect(existsSync(join(env.cacheDir, "pending-tasks.json"))).toBe(false);
		const completed = await cli(["task", "complete", id]);
		expect(completed.exitCode, completed.stderr).toBe(0);
		const next = await json(["task", "list", "--raw"]);
		expect(next.result).toHaveLength(0);
		expect(intents()).toHaveLength(1);
		expect(intents()[0]!.taskId).toBe(id);
	}, 20_000);
	test("numeric IDs resolve the merged pending-create view, and completion cannot resurrect", async () => {
		const created = await json([
			"task",
			"create",
			"Numeric pending",
			"--date",
			"2026-05-21",
			"--at",
			"10:00",
			"--json",
		]);
		await cli(["task", "list", "--all", "--plain"]);
		const context = JSON.parse(
			readFileSync(join(env.cacheDir, "last-list.json"), "utf8"),
		);
		const short = context.tasks.find(
			(t: { id: string }) => t.id === created.result.id,
		).shortId;
		const complete = await cli(["task", "complete", String(short)]);
		expect(complete.exitCode, complete.stderr).toBe(0);
		for (let i = 0; i < 2; i++) {
			expect((await list()).find((t) => t.id === created.result.id)).toMatchObject({
				done: true,
				pending: true,
			});
			expect(
				(await cal()).find(
					(t) => (t.record as Record<string, unknown>)?.id === created.result.id,
				)?.record,
			).toMatchObject({ done: true, pending: true });
		}
	}, 20_000);

	test("parallel CLI list and mutate processes preserve all fields and never read torn state", async () => {
		const changes = [
			["--title", "Concurrent title"],
			["--description", "Concurrent description"],
			["--duration", "45m"],
			["--priority", "3"],
		];
		const results = await Promise.all(
			changes.flatMap((flags) => [
				cli(["task", "update", id, ...flags]),
				cli(["task", "list", "--all", "--raw"]),
			]),
		);
		for (const result of results)
			expect(result.exitCode, result.stderr).toBe(0);
		for (let i = 1; i < results.length; i += 2)
			expect(JSON.parse(results[i]!.stdout).result).toHaveLength(1);
		expect(intents()).toHaveLength(changes.length);
		expect((await list())[0]).toMatchObject({
			title: "Concurrent title",
			description: "Concurrent description",
			duration: 2700,
			priority: 3,
			pending: true,
		});
		expect((await cal())[0]?.record).toMatchObject({
			title: "Concurrent title",
			description: "Concurrent description",
			duration: 2700,
			priority: 3,
			pending: true,
		});
	}, 20_000);

	test("list, cal, convert and slot uniformly exclude trashed rows; list can explicitly query trash", async () => {
		observed = [task({ trashed_at: "2026-05-21T00:00:00Z", status: 10 })];
		await cli(["refresh", "--rebuild"]);
		const normal = await json([
			"task",
			"list",
			"--date",
			"2026-05-21",
			"--raw",
		]);
		expect(normal.result).toHaveLength(0);
		expect(
			(await json(["task", "list", "--trashed", "--raw"])).result,
		).toHaveLength(1);
		expect(await cal()).toHaveLength(0);
		const conversion = await json([
			"convert",
			"tasks",
			"--to",
			"events",
			"--search",
			"Repository task",
			"--json",
		]);
		expect(conversion.selected).toBe(0);
		const slot = await json(["slot", "show", "slot-focus-1", "--json"]);
		expect(slot.tasks).toHaveLength(0);
	}, 20_000);

	test("virtual IDs and numeric virtual context fail before any mutation request", async () => {
		const virtual = `virtual:${id}:2026-05-21`;
		writeFileSync(
			join(env.cacheDir, "last-list.json"),
			JSON.stringify({
				timestamp: Date.now(),
				tasks: [{ shortId: 1, id: virtual, title: "Virtual" }],
			}),
		);
		for (const command of ["update", "plan", "snooze", "complete", "delete"]) {
			const flags =
				command === "update"
					? ["--title", "Bad"]
					: command === "plan"
						? ["--date", "2026-05-21"]
						: command === "snooze"
							? ["--duration", "1d"]
							: [];
			for (const identifier of [virtual, "1"]) {
				const result = await cli(["task", command, identifier, ...flags]);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain(
					"Synthetic task ID",
				);
			}
		}
		const slot = await cli([
			"slot",
			"create",
			"Bad",
			"--date",
			"2026-05-21",
			"--at",
			"10:00",
			"--duration",
			"1h",
			"--task-id",
			virtual,
		]);
		expect(slot.exitCode).not.toBe(0);
		expect(slot.stderr).toContain(
			"Synthetic task ID",
		);
		expect(server.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
		expect(existsSync(join(env.cacheDir, "pending-tasks.json"))).toBe(false);
	}, 20_000);

	test("slot, conversion and project outputs distinguish pending task fields", async () => {
		const changed = await cli([
			"task",
			"update",
			id,
			"--title",
			"Visible pending",
			"--project",
			"label-personal",
		]);
		expect(changed.exitCode, changed.stderr).toBe(0);
		const slot = await json(["slot", "show", "slot-focus-1", "--json"]);
		expect(slot.tasks[0]).toMatchObject({
			title: "Visible pending",
			pending: true,
		});
		const conversion = await json([
			"convert",
			"tasks",
			"--to",
			"events",
			"--search",
			"Visible pending",
			"--json",
		]);
		expect(conversion.items[0]).toMatchObject({ task_id: id, pending: true });
		const projects = await cli(["project", "list"]);
		expect(projects.exitCode, projects.stderr).toBe(0);
		expect(projects.stdout).toMatch(/Personal[^\n]*1 task \(1 pending\)/);
		const plainSlot = await cli(["slot", "show", "slot-focus-1"]);
		expect(plainSlot.stdout).toContain("[pending] Visible pending");
		const plainConvert = await cli([
			"convert",
			"tasks",
			"--to",
			"events",
			"--search",
			"Visible pending",
		]);
		expect(plainConvert.stdout).toContain("[pending] Visible pending");
	}, 20_000);
	test("slot task writes and conversion deletes feed the same overlay", async () => {
		const linked = await cli([
			"slot",
			"update",
			"slot-focus-1",
			"--remove-task-id",
			id,
			"--json",
		]);
		expect(linked.exitCode, linked.stderr).toBe(0);
		expect((await list())[0]).toMatchObject({
			time_slot_id: null,
			pending: true,
		});
		const conversion = await cli([
			"convert",
			"tasks",
			"--to",
			"events",
			"--search",
			"Repository task",
			"--execute",
			"--delete-source",
			"--json",
		]);
		expect(conversion.exitCode, conversion.stderr).toBe(0);
		expect(await list()).toHaveLength(0);
		expect(await cal()).toHaveLength(0);
	}, 20_000);
});
