import { afterEach, beforeEach, expect, test } from "bun:test";
import { event, instant, slot, task } from "../lib/occurrence-fixtures";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { localCliSession } from "./helpers/run-local-cli";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

let server: FakeAkiflowServer;
let local: ReturnType<typeof localCliSession> | undefined;
let isolated: ReturnType<typeof makeTestEnv>;
beforeEach(async () => {
	server = new FakeAkiflowServer({ pageSize: 2 });
	try {
		await server.start();
		isolated = makeTestEnv(server.url);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		local = localCliSession(server);
		isolated = local.env;
	}
	server.seed("calendars", [
		{ id: "cal", title: "Primary", hidden_at: null, deleted_at: null },
		{ id: "other", title: "Other", hidden_at: null, deleted_at: null },
		{ id: "hidden", title: "Hidden", hidden_at: "now", deleted_at: null },
		{ id: "deleted", title: "Deleted", deleted_at: "now" },
	]);
	server.seed("events", [
		event({ task_id: "t", origin_id: "echo" }),
		event({
			id: "echo",
			origin_id: "echo",
			start_time: instant(9.5).toISOString(),
			end_time: instant(11).toISOString(),
		}),
		event({
			id: "other-e",
			calendar_id: "other",
			akiflow_account_id: "other-account",
			connector_id: "microsoft",
			start_time: instant(13).toISOString(),
			end_time: instant(14).toISOString(),
		}),
		event({ id: "cancelled", status: "cancelled" }),
		event({ id: "declined", declined: true }),
		event({ id: "hidden-e", calendar_id: "hidden" }),
		event({ id: "deleted-e", calendar_id: "deleted" }),
	] as never);
	server.seed("time_slots", [
		slot({
			start_time: instant(10).toISOString(),
			end_time: instant(12).toISOString(),
		}),
		slot({
			id: "other-s",
			calendar_id: "other",
			akiflow_account_id: "other-account",
			connector_id: "microsoft",
			start_time: instant(14).toISOString(),
			end_time: instant(15).toISOString(),
		}),
	] as never);
	server.seed("tasks", [
		task({ datetime: instant(18).toISOString(), duration: 7200 }),
		task({
			id: "other-t",
			calendar_id: "other",
			akiflow_account_id: "other-account",
			connector_id: "microsoft",
			datetime: instant(15).toISOString(),
			duration: 3600,
		}),
		task({ id: "done", done: true }),
		task({ id: "trashed", trashed_at: "now" }),
	] as never);
	const refresh = local
		? await local.run(["refresh", "--rebuild", "--json"])
		: await spawnCli(["refresh", "--rebuild", "--json"], { env: isolated.env });
	expect(refresh.exitCode).toBe(0);
});
afterEach(async () => {
	await server?.stop();
	if (local) {
		local.cleanup();
		local = undefined;
	} else isolated?.cleanup();
});
async function run(args: string[]) {
	const result = local
		? await local.run(args)
		: await spawnCli(args, { env: isolated.env });
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout);
}

test("occurrence summary unions overlap and linked owner time across sources", async () => {
	const output = await run([
		"cal",
		"--date",
		"2026-06-20",
		"--summary",
		"--json",
	]);
	expect(output.result).toEqual({
		counts: { event: 3, slot: 2, task: 2 },
		total: 7,
		busy_minutes: 360,
	});
});
test("occurrence free windows subtract merged busy intervals and honor minimum duration", async () => {
	const output = await run(["cal", "--date", "2026-06-20", "--free", "--json"]);
	expect(output.result).toEqual([
		{
			start: new Date(2026, 5, 20).toISOString(),
			end: instant(9).toISOString(),
		},
		{ start: instant(12).toISOString(), end: instant(13).toISOString() },
		{
			start: instant(16).toISOString(),
			end: new Date(2026, 5, 21).toISOString(),
		},
	]);
	expect(
		(
			await run([
				"cal",
				"--date",
				"2026-06-20",
				"--free",
				"--min-duration",
				"2h",
				"--json",
			])
		).result,
	).toHaveLength(2);
});
test("occurrence identity filters apply to cal, slot list, and batch slot reads", async () => {
	for (const [flag, value] of [
		["--account", "other-account"],
		["--connector", "microsoft"],
		["--calendar", "Other"],
	]) {
		const output = await run([
			"cal",
			"--date",
			"2026-06-20",
			flag!,
			value!,
			"--raw",
		]);
		expect(
			output.result.map((o: { record: { id: string } }) => o.record.id),
		).toEqual(["other-e", "other-s", "other-t"]);
		expect(output.result.map((o: { type: string }) => o.type)).toEqual([
			"event",
			"slot",
			"task",
		]);
		const slots = await run([
			"slot",
			"list",
			"--date",
			"2026-06-20",
			flag!,
			value!,
			"--json",
		]);
		expect(slots.map((o: { slot: { id: string } }) => o.slot.id)).toEqual([
			"other-s",
		]);
		const batch = await run([
			"batch",
			"slots",
			"delete",
			"--date",
			"2026-06-20",
			flag!,
			value!,
			"--json",
		]);
		expect(batch.items.map((o: { id: string }) => o.id)).toEqual(["other-s"]);
	}
	expect(
		(
			await run([
				"cal",
				"--date",
				"2026-06-20",
				"--calendar",
				"Hidden",
				"--raw",
			])
		).result.map((o: { record: { id: string } }) => o.record.id),
	).toEqual(["hidden-e"]);
	// Sync tombstones remove deleted calendars; explicit resolution then fails validation.
	const deletedArgs = [
		"cal",
		"--date",
		"2026-06-20",
		"--calendar",
		"Deleted",
		"--raw",
	];
	const deleted = local
		? await local.run(deletedArgs)
		: await spawnCli(deletedArgs, { env: isolated.env });
	expect(deleted.exitCode).toBe(2);
	expect(server.requests.every((r) => r.method === "GET")).toBe(true);
});
test("occurrence audit envelope carries snapshot provenance and explainable discrepancies", async () => {
	const output = await run(["audit", "--date", "2026-06-20", "--json"]);
	expect(output.schema_version).toBe(1);
	expect(output.envelope.schema_version).toBe(1);
	expect(Number.isFinite(Date.parse(output.envelope.generated_at))).toBe(true);
	expect(output.envelope.timezone).toBe(
		Intl.DateTimeFormat().resolvedOptions().timeZone,
	);
	expect(output.envelope.provenance.generation).toMatch(/^gen-\d+$/);
	expect(
		Number.isFinite(Date.parse(output.envelope.provenance.observed_at)),
	).toBe(true);
	expect(output.envelope.busy_minutes).toBe(360);
	expect(
		output.audit.discrepancies.possible_echo_groups[0].suggested_canonical.id,
	).toBe("e");
	expect(output.audit.discrepancies.link_divergences[0].linked.id).toBe("t");
	expect(output.audit.discrepancies.statuses).toEqual({
		cancelled: { seen: 1, excluded: 1 },
		declined: { seen: 1, excluded: 1 },
		done: { seen: 1, excluded: 1 },
		trashed: { seen: 1, excluded: 1 },
	});
	for (const o of output.envelope.occurrences) {
		expect(o.provenance.generation).toBe(output.envelope.provenance.generation);
		expect(o.provenance.pending).toBe(false);
		expect(o.provenance.observedAt).toBe(
			output.audit.fetch.observed_at[
				o.source === "slot" ? "time_slots" : `${o.source}s`
			],
		);
		expect(o).not.toHaveProperty("raw");
	}
	expect(
		output.envelope.occurrences.find((o: { id: string }) => o.id === "t")
			.timeSuppressed,
	).toBe(true);
	expect(server.requests.every((r) => r.method === "GET")).toBe(true);
});
