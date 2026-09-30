import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createTaskCommand } from "../../commands/create";
import { taskCompleteCommand } from "../../commands/do";
import {
	taskDeleteCommand,
	taskPlanCommand,
	taskSnoozeCommand,
	taskUpdateCommand,
} from "../../commands/task";
import type { Task } from "../../lib/api/types";
import * as storage from "../../lib/auth/storage";
import { readResource, upsertResourceRecords } from "../../lib/cache";
import { readTasks } from "../../lib/tasks";
import fixtures from "../integration/fixtures/tasks.json";
import { isolateTaskCache } from "./task-test-cache";

isolateTaskCache();
const id = "11111111-2222-4333-8444-555555555555";
const base = {
	...fixtures[0],
	id,
	title: "Observed",
	date: "2026-05-21",
	datetime: "2026-05-21T09:00:00.000Z",
	datetime_tz: "UTC",
	status: 2,
} as Task;
const offline = {
	get: async () => {
		throw new Error("Unexpected network read");
	},
} as never;
let fetchSpy: ReturnType<typeof spyOn>;
let credentials: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
beforeEach(async () => {
	await upsertResourceRecords("tasks", [base]);
	credentials = spyOn(storage, "loadCredentials").mockResolvedValue({
		token: "test",
		clientId: "test",
		expiryTimestamp: Date.now() + 60000,
	});
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		expect(String(input)).toContain("/v5/tasks");
		expect(init?.method).toBe("PATCH");
		const payloads = JSON.parse(init?.body as string);
		return new Response(
			JSON.stringify({
				success: true,
				message: null,
				data: payloads.map((payload: Partial<Task>) => ({
					...base,
					...payload,
				})),
			}),
		);
	}) as typeof fetch);
	log = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	fetchSpy.mockRestore();
	credentials.mockRestore();
	log.mockRestore();
});

describe("task mutation repository write-through", () => {
	const cases = [
		{
			name: "create",
			command: createTaskCommand,
			args: { title: "Created", date: "2026-05-21" },
			fields: { title: "Created", date: "2026-05-21" },
		},
		{
			name: "update",
			command: taskUpdateCommand,
			args: { id, title: "Changed" },
			fields: { title: "Changed" },
		},
		{
			name: "plan",
			command: taskPlanCommand,
			args: { id, date: "2026-05-22", at: "11:00" },
			fields: { date: "2026-05-22", pending: true },
		},
		{
			name: "date-only plan",
			command: taskPlanCommand,
			args: { id, date: "2026-05-22" },
			fields: { datetime: null, datetime_tz: null, date: "2026-05-22" },
		},
		{
			name: "snooze",
			command: taskSnoozeCommand,
			args: { id, duration: "1d" },
			fields: { datetime: "2026-05-22T09:00:00.000Z" },
		},
		{
			name: "complete",
			command: taskCompleteCommand,
			args: { id },
			fields: { done: true, status: 2 },
		},
		{ name: "delete", command: taskDeleteCommand, args: { id }, fields: {} },
	];
	for (const scenario of cases)
		test(`${scenario.name} overlays the next local read without rewriting observed tasks`, async () => {
			await scenario.command.run?.({
				args: scenario.args,
				rawArgs: [],
			} as never);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const row = (await readTasks(offline)).find((t) =>
				scenario.name === "create" ? t.id !== id : t.id === id,
			);
			if (scenario.name === "delete") expect(row).toBeUndefined();
			else expect(row).toMatchObject({ ...scenario.fields, pending: true });
			expect(await readResource(offline, "tasks", { cacheOnly: true })).toEqual(
				[base],
			);
		});
});
