import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { localCliSession } from "./helpers/run-local-cli";

let server: FakeAkiflowServer;
let cli: ReturnType<typeof localCliSession>;

const taskId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
	server = new FakeAkiflowServer();
	loadAllFixtures(server);
	cli = localCliSession(server);
});

afterEach(() => {
	cli.cleanup();
});

describe("Workstream F: rescheduling and timezone primitives", () => {
	// Snooze with day unit uses wall-day basis (preserves wall-clock time).
	test("snooze --duration 1d preserves wall-clock time (wall-day basis)", async () => {
		// Task at 2026-09-30 09:00 PDT (16:00 UTC)
		server.scenarios.snooze(taskId, "2026-09-30T16:00:00.000Z", "America/Los_Angeles");
		const result = await cli.run([
			"task",
			"snooze",
			taskId,
			"--duration",
			"1d",
		]);
		expect(result.exitCode).toBe(0);
		const patch = JSON.parse(
			server.requests.find((r) => r.method === "PATCH")!.body,
		)[0];
		// 2026-10-01 09:00 PDT = 16:00 UTC (wall-clock preserved)
		expect(patch.datetime).toBe("2026-10-01T16:00:00.000Z");
		expect(patch.datetime_tz).toBe("America/Los_Angeles");
		expect(patch.date).toBe("2026-10-01");
	});

	// Snooze across DST spring-forward: wall-clock preserved (1d = same time next day).
	test("snooze 1d across spring-forward preserves wall-clock", async () => {
		// Task at 2026-03-07 09:00 PST (17:00 UTC), day before spring-forward
		server.scenarios.snooze(taskId, "2026-03-07T17:00:00.000Z", "America/Los_Angeles");
		const result = await cli.run([
			"task",
			"snooze",
			taskId,
			"--duration",
			"1d",
		]);
		expect(result.exitCode).toBe(0);
		const patch = JSON.parse(
			server.requests.find((r) => r.method === "PATCH")!.body,
		)[0];
		// 2026-03-08 09:00 PDT = 16:00 UTC (23 elapsed hours, but 09:00 wall-clock)
		expect(patch.datetime).toBe("2026-03-08T16:00:00.000Z");
		expect(patch.datetime_tz).toBe("America/Los_Angeles");
	});

	// Snooze with hour unit uses elapsed basis.
	test("snooze --duration 1h uses elapsed basis", async () => {
		server.scenarios.snooze(taskId, "2026-09-30T16:00:00.000Z", "America/Los_Angeles");
		const result = await cli.run([
			"task",
			"snooze",
			taskId,
			"--duration",
			"1h",
		]);
		expect(result.exitCode).toBe(0);
		const patch = JSON.parse(
			server.requests.find((r) => r.method === "PATCH")!.body,
		)[0];
		// 1 hour later: 17:00 UTC (10:00 PDT)
		expect(patch.datetime).toBe("2026-09-30T17:00:00.000Z");
		expect(patch.datetime_tz).toBe("America/Los_Angeles");
	});

	// Plan with --clear-time converts to date-only.
	test("plan --clear-time converts timed task to date-only", async () => {
		server.scenarios.snooze(taskId, "2026-09-30T16:00:00.000Z", "America/Los_Angeles");
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-10-05",
			"--clear-time",
		]);
		expect(result.exitCode).toBe(0);
		const patch = JSON.parse(
			server.requests.find((r) => r.method === "PATCH")!.body,
		)[0];
		expect(patch.date).toBe("2026-10-05");
		expect(patch.datetime).toBeNull();
		expect(patch.datetime_tz).toBeNull();
	});

	// Plan with --date and --at uses explicit timezone.
	test("plan --date --at --timezone interprets time in given zone", async () => {
		server.scenarios.snooze(taskId, "2026-09-30T16:00:00.000Z", "America/Los_Angeles");
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-10-01",
			"--at",
			"09:00",
			"--timezone",
			"America/New_York",
		]);
		expect(result.exitCode).toBe(0);
		const patch = JSON.parse(
			server.requests.find((r) => r.method === "PATCH")!.body,
		)[0];
		// 2026-10-01 09:00 EDT (UTC-4) = 13:00 UTC
		expect(patch.datetime).toBe("2026-10-01T13:00:00.000Z");
		expect(patch.datetime_tz).toBe("America/New_York");
	});

	// Invalid date is rejected.
	test("plan rejects 2026-02-30", async () => {
		server.scenarios.snooze(taskId);
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-02-30",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("Invalid calendar date");
	});

	// DST gap is rejected.
	test("plan rejects DST gap time", async () => {
		server.scenarios.snooze(taskId);
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-03-08",
			"--at",
			"02:30",
			"--timezone",
			"America/Los_Angeles",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("does not exist");
	});

	// DST fold requires explicit choice.
	test("plan requires --fold for ambiguous time", async () => {
		server.scenarios.snooze(taskId);
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-11-01",
			"--at",
			"01:30",
			"--timezone",
			"America/Los_Angeles",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("ambiguous");
	});

	// DST fold with explicit choice works.
	test("plan --fold first resolves ambiguous time", async () => {
		server.scenarios.snooze(taskId);
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-11-01",
			"--at",
			"01:30",
			"--timezone",
			"America/Los_Angeles",
			"--fold",
			"first",
		]);
		expect(result.exitCode).toBe(0);
		const patch = JSON.parse(
			server.requests.find((r) => r.method === "PATCH")!.body,
		)[0];
		// First 1:30 AM is PDT (UTC-7) = 08:30 UTC
		expect(patch.datetime).toBe("2026-11-01T08:30:00.000Z");
	});

	// Task create with --timezone.
	test("task create --timezone interprets time in given zone", async () => {
		const result = await cli.run([
			"task",
			"create",
			"F Timezone Test",
			"--date",
			"2026-10-01",
			"--at",
			"09:00",
			"--timezone",
			"America/New_York",
		]);
		expect(result.exitCode).toBe(0);
		const patch = server.requests.find((r) => r.method === "PATCH");
		expect(patch).toBeDefined();
		const body = JSON.parse(patch!.body);
		const task = Array.isArray(body) ? body[0] : body;
		// 09:00 EDT = 13:00 UTC
		expect(task.datetime).toBe("2026-10-01T13:00:00.000Z");
		expect(task.datetime_tz).toBe("America/New_York");
	});

	// Invalid timezone is rejected.
	test("task create rejects invalid --timezone", async () => {
		const result = await cli.run([
			"task",
			"create",
			"Invalid TZ Test",
			"--date",
			"2026-10-01",
			"--at",
			"09:00",
			"--timezone",
			"Invalid/Zone",
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("Invalid timezone");
	});
});
