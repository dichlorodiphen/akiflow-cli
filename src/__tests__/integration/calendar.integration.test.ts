import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

let server: FakeAkiflowServer;
let env: ReturnType<typeof makeTestEnv>;

function syncedEnv(): Record<string, string> {
	return { ...env.env, AF_NO_AUTO_SYNC: "" };
}

beforeEach(async () => {
	server = new FakeAkiflowServer();
	await server.start();
	loadAllFixtures(server);
	env = makeTestEnv(server.url);
});

afterEach(async () => {
	await server.stop();
	env.cleanup();
});

describe("af calendar (BDD)", () => {
	test("lists cached calendars as JSON", async () => {
		const result = await spawnCli(["calendar", "list", "--json"], {
			env: syncedEnv(),
		});

		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.result).toHaveLength(1);
		expect(report.result[0].id).toBe("cal-personal-1");
		expect(report.result[0].default_event_calendar).toBe(true);
	});

	test("resolves calendar titles in af cal --calendar", async () => {
		const result = await spawnCli(
			[
				"cal",
				"--from",
				"2026-05-18",
				"--to",
				"2026-05-24",
				"--calendar",
				"Personal",
				"--json",
			],
			{ env: syncedEnv() },
		);

		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(
			report.result.some(
				(entry: { id: string }) => entry.id === "event-meeting-1",
			),
		).toBe(true);
	});
});
