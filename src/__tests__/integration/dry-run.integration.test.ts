import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

const taskId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const slotId = "33333333-3333-4333-8333-333333333333";
const task = {
	id: taskId,
	title: "Before task",
	date: "2026-06-20",
	datetime: "2026-06-20T09:00:00.000Z",
	datetime_tz: "UTC",
	duration: 1800,
	done: false,
	status: 2,
};
const event = {
	id: eventId,
	title: "Before event",
	connector_id: "google",
	calendar_id: "cal",
	akiflow_account_id: "account",
	origin_id: "provider",
	start_time: "2026-06-20T09:00:00.000Z",
	end_time: "2026-06-20T10:00:00.000Z",
	start_datetime_tz: "UTC",
	attendees: [{ email: "old@example.com" }],
	recurrence: null,
};
const slot = {
	id: slotId,
	title: "Before slot",
	calendar_id: "cal",
	start_time: "2026-06-20T09:00:00.000Z",
	end_time: "2026-06-20T10:00:00.000Z",
	start_datetime_tz: "UTC",
};
function snapshot(dir: string): string {
	return JSON.stringify(
		readdirSync(dir)
			.sort()
			.map((name) => [name, readFileSync(join(dir, name), "utf8")]),
	);
}

const cases: Array<[string, string[]]> = [
	[
		"task create",
		[
			"task",
			"create",
			"Created",
			"--date",
			"2026-06-20",
			"--at",
			"09:00",
			"--project",
			"Work",
		],
	],
	["task complete", ["task", "complete", taskId]],
	[
		"task update",
		["task", "update", taskId, "--title", "After task", "--duration", "1h"],
	],
	[
		"task plan",
		["task", "plan", taskId, "--date", "2026-06-21", "--at", "10:00"],
	],
	["task snooze", ["task", "snooze", taskId, "--duration", "1d"]],
	["task delete", ["task", "delete", taskId]],
	[
		"event create",
		[
			"event",
			"create",
			"Created event",
			"--date",
			"2026-06-20",
			"--at",
			"09:00",
			"--duration",
			"1h",
		],
	],
	[
		"event update",
		[
			"event",
			"update",
			eventId,
			"--date",
			"2026-06-21",
			"--at",
			"10:00",
			"--duration",
			"30m",
		],
	],
	["event delete", ["event", "delete", eventId, "--send-updates", "none"]],
	["attendees add", ["event", "attendees", "add", eventId, "new@example.com"]],
	[
		"attendees remove",
		["event", "attendees", "remove", eventId, "old@example.com"],
	],
	[
		"slot create",
		[
			"slot",
			"create",
			"Created slot",
			"--date",
			"2026-06-20",
			"--at",
			"09:00",
			"--duration",
			"1h",
			"--task",
			"New child",
			"--task-id",
			taskId,
		],
	],
	["slot update", ["slot", "update", slotId, "--title", "After slot"]],
	["slot delete", ["slot", "delete", slotId]],
	[
		"convert",
		[
			"convert",
			"tasks",
			"--to",
			"events",
			"--search",
			"Before task",
			"--delete-source",
		],
	],
	[
		"batch event delete",
		["batch", "events", "delete", "--search", "Before event"],
	],
	[
		"batch attendee add",
		[
			"batch",
			"events",
			"attendees",
			"add",
			"new@example.com",
			"--search",
			"Before event",
		],
	],
	[
		"batch slot delete",
		["batch", "slots", "delete", "--search", "Before slot"],
	],
	[
		"batch attendee remove",
		[
			"batch",
			"events",
			"attendees",
			"remove",
			"old@example.com",
			"--search",
			"Before event",
		],
	],
	[
		"convert default preview",
		["convert", "tasks", "--to", "events", "--search", "Before task"],
	],
	[
		"batch default preview",
		["batch", "slots", "delete", "--search", "Before slot"],
	],
];
describe("universal mutation dry-run", () => {
	for (const [name, args] of cases)
		test(`${name} previews normalized changes with zero writes`, async () => {
			const env = makeTestEnv("http://127.0.0.1:1");
			try {
				for (const [resource, records] of Object.entries({
					tasks: [task],
					events: [event],
					time_slots: [slot],
					labels: [{ id: "label", title: "Work" }],
					calendars: [
						{
							id: "cal",
							title: "Calendar",
							connector_id: "google",
							akiflow_account_id: "account",
							akiflow_primary: true,
						},
					],
				}))
					writeFileSync(
						join(env.cacheDir, `${resource}.jsonl`),
						`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
					);
				const beforeCache = snapshot(env.cacheDir);
				const beforeCredentials = readFileSync(env.credentialsPath, "utf8");
				const result = await spawnCli(
					[
						...args,
						...(name.includes("default preview") ? [] : ["--dry-run"]),
						"--json",
					],
					{
						env: { ...env.env, AF_NO_AUTO_SYNC: "", AF_JSON_ENVELOPE: "0" },
					},
				);
				expect(result.exitCode).toBe(0);
				const report = JSON.parse(result.stdout);
				expect(report.mode).toBe("dry-run");
				expect(report.items.length).toBeGreaterThan(0);
				for (const item of report.items) {
					expect(item.id ?? item.task_id).toBeTruthy();
					expect(item.title).toBeTruthy();
					expect(item).toHaveProperty("before");
					expect(item).toHaveProperty("after");
					expect(item.notification_policy).toMatch(/^(all|none)$/);
				}
				expect(snapshot(env.cacheDir)).toBe(beforeCache);
				expect(readFileSync(env.credentialsPath, "utf8")).toBe(
					beforeCredentials,
				);
			} finally {
				env.cleanup();
			}
		});
});
