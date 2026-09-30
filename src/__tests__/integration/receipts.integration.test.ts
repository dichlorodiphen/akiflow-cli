import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eventLifecycle } from "./helpers/event-lifecycle";
import { DROP_CONNECTION, FakeAkiflowServer } from "./helpers/fake-server";
import { loadAllFixtures } from "./helpers/load-fixtures";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

let server: FakeAkiflowServer;
let env: ReturnType<typeof makeTestEnv>;
let lifecycle: ReturnType<typeof eventLifecycle>;
const create = [
	"event",
	"create",
	"Receipt meeting",
	"--date",
	"2026-10-01",
	"--at",
	"09:00",
	"--duration",
	"30m",
];
const posts = () =>
	server.requests.filter(
		(req) =>
			req.method === "POST" && req.url.pathname === "/v5/event_operations",
	);
async function run(args: string[], timeoutMs = 10000) {
	return spawnCli(args, { env: { ...env.env, TZ: "UTC" }, timeoutMs });
}

beforeEach(async () => {
	server = new FakeAkiflowServer();
	await server.start();
	loadAllFixtures(server);
	lifecycle = eventLifecycle(server);
	env = makeTestEnv(server.url);
	const refresh = await run(["refresh", "--rebuild", "--json"]);
	expect(refresh.exitCode).toBe(0);
});
afterEach(async () => {
	await server.stop();
	env.cleanup();
});

describe("truthful receipts (BDD)", () => {
	for (const args of [
		create,
		["event", "update", "event-meeting-1", "--title", "Changed"],
		["event", "delete", "event-meeting-1"],
	]) {
		test(`${args.slice(0, 2).join(" ")} distinguishes acceptance from confirmation`, async () => {
			const result = await run(args);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("submitted, not yet confirmed");
			expect(result.stdout).not.toContain("successfully");
			expect(posts()).toHaveLength(1);
		});
		test(`${args.slice(0, 2).join(" ")} verifies fresh observed state`, async () => {
			const result = await run([...args, "--verify", "--json"]);
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			expect(output.schema_version).toBe(1);
			expect(output.status).toBe("verified");
			expect(output.receipts).toHaveLength(1);
			expect(posts()).toHaveLength(1);
		});
	}
	test("failure retains per-operation receipt and exits nonzero", async () => {
		lifecycle.status = "failed";
		const result = await run([...create, "--json"]);
		expect(result.exitCode).not.toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.status).toBe("failed");
		expect(output.receipts[0].status).toBe("failed");
	});
	test("aggregate failure without named ids is unknown", async () => {
		lifecycle.aggregateUnknown = true;
		const result = await run([...create, "--json"]);
		expect(result.exitCode).not.toBe(0);
		expect(JSON.parse(result.stdout).status).toBe("unknown");
		expect(posts()).toHaveLength(1);
	});
	test("pending receipt never claims success", async () => {
		lifecycle.status = "pending";
		const result = await run(create);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout + result.stderr).toContain("pending");
		expect(result.stdout + result.stderr).not.toContain("successfully");
	});
	test("verification mismatch names requested fields", async () => {
		lifecycle.wrongTitle = true;
		const result = await run([...create, "--verify"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout + result.stderr).toContain(
			"Mismatch on fields: title",
		);
	});
	test("delayed visibility verifies without resubmission", async () => {
		lifecycle.delayReads = 1;
		const result = await run([...create, "--verify"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Verified:");
		expect(posts()).toHaveLength(1);
	});
	test("never-applied operation times out without success", async () => {
		lifecycle.apply = false;
		const result = await run([...create, "--verify"], 20000);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout + result.stderr).toContain("Verification timed out");
		expect(result.stdout + result.stderr).not.toContain("successfully");
		expect(posts()).toHaveLength(1);
	}, 25000);
	test("transport failure after POST never triggers a second POST", async () => {
		// Simulate the server dropping the connection after the POST was
		// received (e.g. crash after apply): the request is recorded, the
		// client must surface unknown and never retry the mutation.
		server.respondTo("POST", "/v5/event_operations", () => DROP_CONNECTION);
		const result = await run([...create, "--json"]);
		expect(result.exitCode).not.toBe(0);
		expect(JSON.parse(result.stdout).status).toBe("unknown");
		expect(posts()).toHaveLength(1);
	});
	test("canonical read-only target refuses mutation before POST", async () => {
		if (lifecycle.records[0]) lifecycle.records[0].read_only = true;
		const result = await run([
			"event",
			"update",
			"event-meeting-1",
			"--title",
			"Forbidden",
		]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout + result.stderr).toMatch(/read.only/i);
		expect(posts()).toHaveLength(0);
	});
	test("back-to-back updates use the first observed change as second base", async () => {
		expect(
			(await run(["event", "update", "event-meeting-1", "--title", "First"]))
				.exitCode,
		).toBe(0);
		expect(
			(
				await run([
					"event",
					"update",
					"event-meeting-1",
					"--description",
					"Second",
				])
			).exitCode,
		).toBe(0);
		const operation = JSON.parse(posts()[1]?.body ?? "[]")[0];
		expect(operation.payload.base.title).toBe("First");
		expect(operation.payload.changes.title).toBe("First");
	});
	test("batch mixed outcomes preserve failed versus unknown and submit once", async () => {
		const first = lifecycle.records[0];
		lifecycle.records.push({
			...first,
			id: "event-meeting-2",
			origin_id: "google-2",
		});
		lifecycle.mixed = true;
		expect((await run(["refresh", "--rebuild", "--json"])).exitCode).toBe(0);
		const result = await run([
			"batch",
			"events",
			"delete",
			"--search",
			"Standup",
			"--execute",
			"--json",
		]);
		expect(result.exitCode).not.toBe(0);
		const output = JSON.parse(result.stdout);
		expect(
			output.receipts.map((receipt: { status: string }) => receipt.status),
		).toEqual(["failed", "unknown"]);
		expect(posts()).toHaveLength(1);
	});
	test("unverified conversion keeps sources intact", async () => {
		server.respondTo("GET", "/v5/tasks", {
			success: true,
			data: [
				{
					id: "convert-source",
					title: "Trip receipt",
					description: "",
					date: "2026-10-01",
					datetime: "2026-10-01T09:00:00Z",
					datetime_tz: "UTC",
					duration: 1800,
					status: 2,
					done: false,
					deleted_at: null,
					trashed_at: null,
					connector_id: null,
				},
			],
			has_next_page: false,
			sync_token: "conversion",
		});
		lifecycle.apply = false;
		expect((await run(["refresh", "--rebuild", "--json"])).exitCode).toBe(0);
		const result = await run(
			[
				"convert",
				"tasks",
				"--to",
				"events",
				"--search",
				"Trip receipt",
				"--execute",
				"--delete-source",
				"--json",
			],
			20000,
		);
		expect(result.exitCode).not.toBe(0);
		expect(JSON.parse(result.stdout).status).toBe("timeout");
		expect(
			server.requests.filter(
				(req) => req.method === "PATCH" && req.url.pathname === "/v5/tasks",
			),
		).toHaveLength(0);
		expect(posts()).toHaveLength(1);
	}, 25000);
	test("task complete partial response names failed id and exits nonzero", async () => {
		const good = "11111111-1111-4111-8111-111111111111";
		const bad = "22222222-2222-4222-8222-222222222222";
		server.respondTo("PATCH", "/v5/tasks", {
			success: true,
			data: [{ id: good, done: true }],
			failed: [{ id: bad, error: "Missing task" }],
		});
		const result = await run(["task", "complete", good, bad, "--json"]);
		expect(result.exitCode).not.toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.status).toBe("failed");
		expect(output.receipts).toContainEqual(
			expect.objectContaining({ id: bad, status: "failed" }),
		);
		expect(output.receipts).toContainEqual(
			expect.objectContaining({ id: good, status: "accepted" }),
		);
	});
	for (const command of ["update", "plan", "snooze", "complete", "delete"]) {
		test(`task ${command} verifies all submitted fields via fresh reads`, async () => {
			const id = "33333333-3333-4333-8333-333333333333";
			let record: Record<string, unknown> = {
				id,
				title: "Before",
				date: "2026-10-01",
				done: false,
				deleted_at: null,
			};
			server.respondTo("GET", "/v5/tasks", () => ({
				success: true,
				data: [record],
				has_next_page: false,
			}));
			server.respondTo("PATCH", "/v5/tasks", ({ body }: { body: string }) => {
				const payload = JSON.parse(body);
				record = { ...record, ...payload[0] };
				return { success: true, data: [record] };
			});
			const flags =
				command === "update"
					? ["--title", "After", "--duration", "30m"]
					: command === "plan"
						? ["--date", "2026-10-02", "--at", "10:00"]
						: command === "snooze"
							? ["--duration", "1d"]
							: [];
			const result = await run([
				"task",
				command,
				id,
				...flags,
				"--verify",
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout).status).toBe("verified");
			expect(
				server.requests.filter(
					(req) => req.method === "PATCH" && req.url.pathname === "/v5/tasks",
				),
			).toHaveLength(1);
		});
	}
	for (const resource of ["task", "slot"]) {
		test(`${resource} create verifies fresh fields including instants and zone`, async () => {
			const endpoint = resource === "task" ? "/v5/tasks" : "/v5/time_slots";
			let records: Array<Record<string, unknown>> = [];
			server.respondTo("GET", endpoint, () => ({
				success: true,
				data: records,
				has_next_page: false,
			}));
			server.respondTo("PATCH", endpoint, ({ body }: { body: string }) => {
				records = JSON.parse(body);
				return { success: true, data: records };
			});
			const result = await run([
				resource,
				"create",
				"Fresh create",
				"--date",
				"2026-10-01",
				"--at",
				"10:00",
				"--duration",
				"30m",
				"--verify",
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			expect(output.schema_version).toBe(1);
			expect(output.status).toBe("verified");
			expect(output.receipts).toHaveLength(1);
		});
	}
	test("verification preserves canonical read-only record and blocks subsequent writes", async () => {
		server.respondTo(
			"POST",
			"/v5/event_operations",
			({ body }: { body: string }) => {
				const payload = JSON.parse(body);
				const record = lifecycle.records[0];
				if (record)
					Object.assign(record, payload[0].payload.changes, {
						read_only: true,
					});
				return { success: true, data: payload };
			},
		);
		const first = await run([
			"event",
			"update",
			"event-meeting-1",
			"--title",
			"Canonical",
			"--verify",
			"--json",
		]);
		expect(first.exitCode).not.toBe(0);
		expect(JSON.parse(first.stdout).errors.join(" ")).toContain("read-only");
		const second = await run([
			"event",
			"update",
			"event-meeting-1",
			"--title",
			"Forbidden",
		]);
		expect(second.exitCode).not.toBe(0);
		expect(posts()).toHaveLength(1);
	});
});
