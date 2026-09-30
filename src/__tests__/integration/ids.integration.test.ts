import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestEnv } from "./helpers/test-env";

let calls: string;
let runner: string;
let env: ReturnType<typeof makeTestEnv>;
const id = "aaaaaaaa-1111-1111-1111-111111111111";
beforeEach(() => {
	env = makeTestEnv("http://fixture.invalid");
	calls = join(env.cacheDir, "calls.jsonl");
	runner = join(env.cacheDir, "fixture-cli.ts");
	// Fixture-backed subprocess: no listening socket and no network access.
	writeFileSync(
		runner,
		`
import { appendFileSync, readFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
 const url = new URL(String(input));
 appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method:init?.method ?? "GET", path:url.pathname}) + "\\n");
 const resource = url.pathname.split("/").pop();
 const files = {tasks:"tasks", labels:"labels", accounts:"accounts"};
 let data = [];
 if (files[resource]) data = JSON.parse(readFileSync(${JSON.stringify(join(import.meta.dir, "fixtures"))} + "/" + files[resource] + ".json", "utf8"));
 if (resource === "tasks" && process.env.AF_ID_TEST_VIRTUAL === "1") data = [{...data[0],id:"aaaaaaaa-1111-1111-1111-111111111111",title:"Recurring synthetic",date:"2026-01-01",original_date:"2026-01-01",recurrence:"RRULE:FREQ=DAILY",recurring_id:null}];
 if (resource === "tasks" && process.env.AF_H_CLEANED === "1") data = [{...data[0],recurring_id:"series",recurrence:"RRULE:FREQ=WEEKLY;BYDAY=MO",calendar_id:"calendar-1",datetime_tz:"Europe/London"}];
 return new Response(JSON.stringify({success:true,data,sync_token:"fixture-token",has_next_page:false}), {headers:{"content-type":"application/json"}});
};
await import(${JSON.stringify(join(import.meta.dir, "..", "..", "index.ts"))});
`,
	);
});
afterEach(() => {
	env.cleanup();
});
async function spawnCli(
	args: string[],
	options: { env: Record<string, string> },
) {
	const proc = Bun.spawn(["bun", runner, ...args], {
		env: { ...process.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: await proc.exited,
		stdout: await new Response(proc.stdout).text(),
		stderr: await new Response(proc.stderr).text(),
	};
}
function recordedCalls(): string {
	try {
		return readFileSync(calls, "utf8");
	} catch {
		return "";
	}
}

test("list raw JSON publishes a snapshot that pins the saved numbered inventory", async () => {
	const result = await spawnCli(["task", "list", "--all", "--raw"], {
		env: env.env,
	});
	expect(result.exitCode).toBe(0);
	const report = JSON.parse(result.stdout);
	const context = JSON.parse(
		readFileSync(join(env.cacheDir, "last-list.json"), "utf8"),
	);
	expect(report.meta.snapshot).toMatch(/^[a-f0-9]{24}$/);
	expect(context.snapshot).toBe(report.meta.snapshot);
	expect(context.tasks.map((t: { id: string }) => t.id)).toEqual(
		report.result.map((t: { id: string }) => t.id),
	);
});
test("list text publishes the snapshot token", async () => {
	const result = await spawnCli(["task", "list", "--all", "--plain"], {
		env: env.env,
	});
	expect(result.exitCode).toBe(0);
	const context = JSON.parse(
		readFileSync(join(env.cacheDir, "last-list.json"), "utf8"),
	);
	expect(result.stdout).toContain(`Snapshot: ${context.snapshot}`);
});
test("strict unpinned and synthetic numeric mutation IDs fail before any API call", async () => {
	writeFileSync(
		join(env.cacheDir, "last-list.json"),
		JSON.stringify({
			tasks: [{ shortId: 1, id, title: "Example" }],
			timestamp: 123,
			snapshot: "pinned",
		}),
	);
	const strict = await spawnCli(["task", "complete", "1"], {
		env: { ...env.env, AF_STRICT_IDS: "1" },
	});
	expect(strict.exitCode).toBe(2);
	expect(strict.stderr).toContain("requires --snapshot");
	const synthetic = `virtual:${id}:2026-09-30`;
	const virtual = await spawnCli(["task", "complete", synthetic], {
		env: env.env,
	});
	expect(virtual.exitCode).toBe(2);
	expect(virtual.stderr).toContain("Synthetic task ID");
	expect(recordedCalls()).toBe("");
});
test("prefix ambiguity uses full inventory before mutation even when filtered list appears unique", async () => {
	writeFileSync(
		join(env.cacheDir, "last-list.json"),
		JSON.stringify({
			tasks: [{ shortId: 1, id, title: "Example" }],
			timestamp: 123,
		}),
	);
	writeFileSync(
		join(env.cacheDir, "tasks.jsonl"),
		[id, "aaaaaaaa-2222-2222-2222-222222222222"]
			.map((id) => JSON.stringify({ id }))
			.join("\n"),
	);
	const result = await spawnCli(["task", "complete", "aaaa"], { env: env.env });
	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("full cached task inventory");
	expect(result.stderr).toContain("Ambiguous");
	expect(recordedCalls()).toBe("");
});

test("virtual list records and numbered context are explicitly synthetic", async () => {
	const refresh = await spawnCli(["refresh", "--rebuild"], {
		env: { ...env.env, AF_ID_TEST_VIRTUAL: "1" },
	});
	expect(refresh.exitCode).toBe(0);
	const raw = await spawnCli(["task", "list", "--raw"], {
		env: { ...env.env, AF_ID_TEST_VIRTUAL: "1" },
	});
	expect(raw.exitCode).toBe(0);
	const virtual = JSON.parse(raw.stdout).result.find((t: { id: string }) =>
		t.id.startsWith("virtual:"),
	);
	expect(virtual.synthetic).toBe(true);
	const context = JSON.parse(
		readFileSync(join(env.cacheDir, "last-list.json"), "utf8"),
	);
	expect(
		context.tasks.find((t: { id: string }) => t.id === virtual.id).synthetic,
	).toBe(true);
	const text = await spawnCli(["task", "list", "--plain"], {
		env: { ...env.env, AF_ID_TEST_VIRTUAL: "1" },
	});
	expect(text.stdout).toContain("Recurring synthetic [synthetic]");
});

test("cleaned task JSON preserves recurrence, calendar semantics and timezone inside the envelope", async () => {
	const refresh = await spawnCli(["refresh", "--rebuild"], {
		env: { ...env.env, AF_H_CLEANED: "1" },
	});
	expect(refresh.exitCode).toBe(0);
	const response = await spawnCli(
		["task", "list", "--all", "--json", "--envelope"],
		{ env: { ...env.env, AF_H_CLEANED: "1" } },
	);
	expect(response.exitCode).toBe(0);
	const envelope = JSON.parse(response.stdout);
	expect(envelope.schema_version).toBe(1);
	expect(envelope.meta.snapshot).toMatch(/^[a-f0-9]{24}$/);
	expect(envelope.result[0].recurring.rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
	expect(envelope.result[0].calendar_id).toBe("calendar-1");
	expect(envelope.result[0].datetime_tz).toBe("Europe/London");
	expect(envelope.result[0]).not.toHaveProperty("linked_event_id");
});

test("synthetic task prefixes reject completion before API calls", async () => {
	const synthetic = `virtual:${id}:2026-09-30`;
	writeFileSync(
		join(env.cacheDir, "last-list.json"),
		JSON.stringify({
			tasks: [{ shortId: 1, id: synthetic, title: "Virtual" }],
			timestamp: 123,
		}),
	);
	const result = await spawnCli(["task", "complete", "vir"], { env: env.env });
	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("Synthetic task ID");
	expect(recordedCalls()).toBe("");
});
for (const dryRun of [false, true]) {
	test(`slot create rejects virtual task linkage before any API call (dry-run=${dryRun})`, async () => {
		const result = await spawnCli(
			[
				"slot",
				"create",
				"Focus",
				"--date",
				"2026-09-30",
				"--at",
				"09:00",
				"--duration",
				"30m",
				"--task-id",
				`virtual:${id}:2026-09-30`,
				...(dryRun ? ["--dry-run"] : []),
			],
			{ env: env.env },
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("Synthetic task ID");
		expect(recordedCalls()).toBe("");
	});
	for (const option of ["--add-task-id", "--remove-task-id"]) {
		test(`slot update rejects virtual ${option} before API calls (dry-run=${dryRun})`, async () => {
			const result = await spawnCli(
				[
					"slot",
					"update",
					id,
					option,
					`virtual:${id}:2026-09-30`,
					...(dryRun ? ["--dry-run"] : []),
				],
				{ env: env.env },
			);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("Synthetic task ID");
			expect(recordedCalls()).toBe("");
		});
		test(`slot update rejects synthetic prefix ${option} in cached inventory (dry-run=${dryRun})`, async () => {
			writeFileSync(
				join(env.cacheDir, "time_slots.jsonl"),
				JSON.stringify({
					id,
					title: "Focus",
					start_time: "2026-09-30T09:00:00Z",
					end_time: "2026-09-30T10:00:00Z",
				}),
			);
			writeFileSync(
				join(env.cacheDir, "tasks.jsonl"),
				JSON.stringify({
					id: `virtual:${id}:2026-09-30`,
					title: "Virtual",
					time_slot_id: id,
				}),
			);
			const result = await spawnCli(
				["slot", "update", id, option, "vir", ...(dryRun ? ["--dry-run"] : [])],
				{ env: env.env },
			);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("Synthetic task ID");
			expect(recordedCalls()).toBe("");
		});
	}
}
