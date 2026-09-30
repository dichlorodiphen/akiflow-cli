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

	env = makeTestEnv(server.url);
});
afterEach(async () => {
	await server.stop();
	env.cleanup();
});

describe("af task create (BDD)", () => {
	test("creates a task via PATCH /v5/tasks with the given title", async () => {
		const result = await spawnCli(["task", "create", "Test new task"], {
			env: env.env,
		});
		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout);
			console.error("STDERR:", result.stderr);
		}
		expect(result.exitCode).toBe(0);

		const patchReq = server.requests.find(
			(r) => r.method === "PATCH" && r.url.pathname === "/v5/tasks",
		);
		expect(patchReq).toBeDefined();
		const body = JSON.parse(patchReq!.body);
		// PATCH body shape from upstream: array of task payloads
		expect(Array.isArray(body) || (body && typeof body === "object")).toBe(
			true,
		);
		const firstTask = Array.isArray(body) ? body[0] : body;
		expect(firstTask.title).toBe("Test new task");
	});
});
