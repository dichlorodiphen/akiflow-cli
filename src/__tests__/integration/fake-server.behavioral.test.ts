import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { localCliSession } from "./helpers/run-local-cli";

let server: FakeAkiflowServer;
let cli: ReturnType<typeof localCliSession>;
const updateTiming = [
	"--date",
	"2026-05-21",
	"--at",
	"09:00",
	"--duration",
	"1h",
];
const taskId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
	server = new FakeAkiflowServer();
	loadAllFixtures(server);
	cli = localCliSession(server);
});
afterEach(() => {
	cli.cleanup();
});
async function rebuild() {
	expect((await cli.run(["refresh", "--rebuild", "--json"])).exitCode).toBe(0);
}
async function create() {
	await rebuild();
	return cli.run([
		"event",
		"create",
		"Incident event",
		"--date",
		"2026-09-30",
		"--at",
		"09:00",
		"--duration",
		"1h",
	]);
}

// All eight skipped assertions failed against the current CLI on 2026-09-30.
// README.md records the observed failures and fixing workstream ownership.
describe("incident matrix against behavioral server (BDD)", () => {
	// Workstream A: reject success:false envelopes without printing creation success.
	test.skip("A I5: rejected envelope must not print event creation success", async () => {
		server.scenarios.fabricatedAcceptance(true);
		const result = await create();
		expect(server.operations.size).toBe(1);
		expect([...server.operations.values()][0]?.status).toBe("failed");
		expect(result.stdout).not.toContain("successfully");
		expect(result.exitCode).not.toBe(0);
	});
	// Workstream A: surface failed operation receipts even when envelope.success is true.
	test.skip("A I5: per-operation failure must be surfaced even in a success envelope", async () => {
		server.scenarios.fabricatedAcceptance();
		const result = await create();
		expect([...server.operations.values()][0]?.status).toBe("failed");
		expect(result.stdout).not.toContain("successfully");
		expect(result.exitCode).not.toBe(0);
	});
	// Workstream A: report each applied/failed result independently using operation receipts.
	test.skip("A I5/I9: mixed batch must report applied and failed items independently", async () => {
		const first = server.snapshot("events")[0]!;
		server.seed("events", [
			first,
			{ ...first, id: "event-meeting-2", origin_id: "google-second" },
		]);
		server.scenarios.mixedBatch((op) => op.event_id === "event-meeting-2");
		await rebuild();
		const result = await cli.run([
			"batch",
			"events",
			"delete",
			"--date",
			"2026-05-21",
			"--search",
			"Standup",
			"--execute",
			"--json",
		]);
		expect([...server.operations.values()].map((op) => op.status)).toEqual([
			"succeeded",
			"failed",
		]);
		expect(result.exitCode).not.toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.failed).toBe(1);
	});
	// Workstreams A/E: serialize competing edits or rebase field intents to preserve both changes.
	test.skip("A/E I5: competing updates must preserve both independent field changes", async () => {
		await rebuild();
		server.scenarios.staleBaseChain();
		const gate = server.gate({ path: "/v5/event_operations" });
		const titleUpdate = cli.run([
			"event",
			"update",
			"event-meeting-1",
			"--title",
			"Changed title",
			...updateTiming,
			"--json",
		]);
		await gate.entered;
		const descriptionUpdate = cli.run([
			"event",
			"update",
			"event-meeting-1",
			"--description",
			"Changed description",
			...updateTiming,
			"--json",
		]);
		try {
			// A repaired mutation queue may block the second command here.
			await Promise.race([descriptionUpdate, Bun.sleep(300)]);
		} finally {
			gate.release();
		}
		const outcomes = await Promise.all([titleUpdate, descriptionUpdate]);
		expect(outcomes.map((result) => result.exitCode)).toEqual([0, 0]);
		const stored = server.snapshot("events")[0]!;
		expect([...server.operations.values()]).toHaveLength(2);
		expect(stored.title).toBe("Changed title");
		expect(stored.description).toBe("Changed description");
	});
	// Workstream C: retain exclusive ownership for the entire cache rebuild and publication.
	test.skip("C I9: overlapping rebuilds must keep the second writer outside the first rebuild", async () => {
		const gate = server.scenarios.lockRace();
		const first = cli.run(["refresh", "--rebuild", "--json"]);
		await gate.entered;
		const second = cli.run(["refresh", "--rebuild", "--json"]);
		let overlap: boolean;
		try {
			overlap = await Promise.race([
				second.then(() => true),
				Bun.sleep(300).then(() => false),
			]);
		} finally {
			gate.release();
			await Promise.all([first, second]);
		}
		expect(server.requests.filter((r) => r.method !== "GET")).toEqual([]);
		expect(overlap).toBe(false);
	});
	// Workstream F: move datetime and preserve datetime_tz for elapsed-time snoozes.
	test.skip("F I8: snooze must move the timed instant and preserve its timezone", async () => {
		server.scenarios.snooze(taskId);
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
		expect(patch.datetime).toBe("2026-09-30T17:00:00.000Z");
		expect(patch.datetime_tz).toBe("America/Los_Angeles");
		expect(server.snapshot("tasks")[0]?.datetime).toBe(patch.datetime);
	});
	// Workstream F: move the timed instant to the requested day while preserving wall time.
	test.skip("F I8: date-only planning must preserve the scheduled wall time on the new day", async () => {
		server.scenarios.snooze(taskId);
		const result = await cli.run([
			"task",
			"plan",
			taskId,
			"--date",
			"2026-10-01",
		]);
		expect(result.exitCode).toBe(0);
		expect(server.snapshot("tasks")[0]).toMatchObject({
			date: "2026-10-01",
			datetime: "2026-10-01T16:00:00.000Z",
			datetime_tz: "America/Los_Angeles",
		});
	});
	// Workstream E: reject cancelled targets; update intent must never infer deletion.
	test.skip("E I7: update of a cancelled event must never dispatch a delete", async () => {
		const event = server.snapshot("events")[0]!;
		server.seed("events", [{ ...event, status: "cancelled" }]);
		await rebuild();
		const result = await cli.run([
			"event",
			"update",
			"event-meeting-1",
			"--title",
			"Must not delete",
			...updateTiming,
		]);
		expect(server.requests.filter((r) => r.method === "POST")).toEqual([]);
		expect(result.exitCode).not.toBe(0);
	});
});

describe("working CLI controls against behavioral server (BDD)", () => {
	test("401 refresh rotates isolated credentials and retries with the new token", async () => {
		server.force401();
		await rebuild();
		const refresh = server.requests.find(
			(r) => r.url.pathname === "/oauth/refreshToken",
		)!;
		expect(JSON.parse(refresh.body)).toEqual({
			client_id: "10",
			refresh_token: "fake-refresh",
		});
		expect(server.requests[2]?.headers.authorization).not.toBe(
			server.requests[0]?.headers.authorization,
		);
		const credentials = JSON.parse(
			readFileSync(cli.env.credentialsPath, "utf8"),
		);
		expect(server.requests[2]?.headers.authorization).toBe(
			`Bearer ${credentials.token}`,
		);
		expect(credentials.refreshToken).toBe("fake-refresh");
		expect(
			server.requests.filter((r) => r.url.pathname === "/oauth/refreshToken"),
		).toHaveLength(1);
	});
	test("HTTP 500 after apply fails the command while leaving a canonical created event", async () => {
		server.schedule({ path: "/v5/event_operations", type: "after-apply" });
		const before = server.snapshot("events").length;
		const result = await create();
		expect(result.exitCode).not.toBe(0);
		expect(server.snapshot("events")).toHaveLength(before + 1);
		expect(
			server.requests.filter((r) => r.url.pathname === "/v5/event_operations"),
		).toHaveLength(1);
	});
});
