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
		const { body } = req;
		const payload = JSON.parse(body);
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

describe("af event create (BDD)", () => {
	test("creates a timed event through the v5 event operations endpoint", async () => {
		const testEnv = { ...env.env, TZ: "UTC" };
		const expectedStart = new Date(2026, 5, 20, 9, 0).toISOString();
		const expectedEnd = new Date(2026, 5, 20, 9, 30).toISOString();
		const refresh = await spawnCli(["refresh", "--rebuild", "--json"], {
			env: testEnv,
		});
		expect(refresh.exitCode).toBe(0);

		const result = await spawnCli(
			[
				"event",
				"create",
				"Integration event",
				"--date",
				"2026-06-20",
				"--at",
				"09:00",
				"--duration",
				"30m",
				"--description",
				"Created by integration test",
				"--location",
				"Test office",
				"--json",
			],
			{ env: testEnv },
		);

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.schema_version).toBe(1);
		expect(envelope.status).toBe("accepted");
		expect(envelope.result).toBeNull();
		expect(envelope.receipts[0].kind).toBe("create");

		const request = server.requests.find(
			(r) => r.method === "POST" && r.url.pathname === "/v5/event_operations",
		);
		expect(request).toBeDefined();
		const payload = JSON.parse(request!.body);
		expect(payload[0].connector_id).toBe("google");
		expect(payload[0].operation).toBe("create");
		expect(payload[0].payload.event.start_time).toBe(expectedStart);
		expect(payload[0].payload.event.end_time).toBe(expectedEnd);
	});
});
