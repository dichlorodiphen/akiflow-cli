import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

setDefaultTimeout(30_000);
let isolated: ReturnType<typeof makeTestEnv>;
beforeEach(() => {
	isolated = makeTestEnv("http://127.0.0.1:1");
	for (const name of ["tasks", "events", "time_slots", "calendars", "accounts"])
		writeFileSync(join(isolated.cacheDir, `${name}.jsonl`), "");
});
afterEach(() => isolated.cleanup());
function inventory(): Record<string, string> {
	return Object.fromEntries(
		readdirSync(isolated.cacheDir).map((name) => [
			name,
			readFileSync(join(isolated.cacheDir, name), "utf8"),
		]),
	);
}
describe("H strict selectors and versioned JSON (isolated subprocesses)", () => {
	test("bad selectors fail before auth or cache access, including conflicting selectors", async () => {
		const before = inventory();
		for (const args of [
			["task", "list", "--date", "nonsense"],
			["cal", "--date", "nonsense"],
			["task", "list", "--month", "2026-13"],
			["cal", "--from", "2026-02-30"],
			["cal", "--today", "--date", "nonsense"],
			["task", "list", "--to", "garbage"],
		]) {
			const result = await spawnCli(args, {
				env: {
					...isolated.env,
					AF_CONFIG_DIR: join(isolated.configDir, "absent"),
					AF_NO_AUTO_SYNC: "",
				},
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("Invalid --");
			expect(result.stderr).toContain(args.at(-1) ?? "");
			expect(result.stderr).not.toContain("Authentication");
			expect(inventory()).toEqual(before);
		}
	});
	test("legacy JSON remains unchanged and announces envelope migration on stderr", async () => {
		const result = await spawnCli(["cal", "--date", "2026-05-21", "--json"], {
			env: isolated.env,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			result: [],
			next_cursor: null,
			errors: [],
		});
		expect(result.stderr).toContain(
			"schema_version: 1 will become the default",
		);
	});
	test("flag and env opt in produce the same complete envelope for cleaned and raw output", async () => {
		for (const flag of ["--json", "--raw"]) {
			for (const optIn of ["flag", "env"]) {
				const result = await spawnCli(
					[
						"cal",
						"--date",
						"2026-05-21",
						flag,
						...(optIn === "flag" ? ["--envelope"] : []),
					],
					{
						env: {
							...isolated.env,
							AF_JSON_ENVELOPE: optIn === "env" ? "1" : "",
						},
					},
				);
				expect(result.exitCode).toBe(0);
				const envelope = JSON.parse(result.stdout);
				expect(Object.keys(envelope).sort()).toEqual(
					[
						"schema_version",
						"command",
						"status",
						"result",
						"errors",
						"warnings",
						"meta",
					].sort(),
				);
				expect(envelope.schema_version).toBe(1);
				expect(envelope.command).toBe("cal");
				expect(envelope.status).toBe("ok");
				expect(envelope.result).toEqual([]);
				expect(envelope.errors).toEqual([]);
				expect(envelope.warnings[0]).toContain("will become the default");
				expect(envelope.meta.exit_code).toBe(0);
			}
		}
	});
	test("validation and not-found errors have versioned envelopes and distinct exit codes", async () => {
		for (const [args, code] of [
			[["cal", "--date", "nonsense", "--json", "--envelope"], 2],
			[
				[
					"event",
					"update",
					"missing-event",
					"--date",
					"2026-05-21",
					"--at",
					"09:00",
					"--duration",
					"30m",
					"--dry-run",
					"--json",
					"--envelope",
				],
				4,
			],
		] as Array<[string[], number]>) {
			const result = await spawnCli(args, { env: isolated.env });
			expect(result.exitCode).toBe(code);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.status).toBe("error");
			expect(envelope.errors.length).toBeGreaterThan(0);
			expect(envelope.meta.exit_code).toBe(code);
		}
	});
});

test("envelope negation and flag-shaped positional title keep the legacy JSON format", async () => {
	const negated = await spawnCli(["cal", "--json", "--no-envelope"], {
		env: { ...isolated.env, AF_JSON_ENVELOPE: "1" },
	});
	expect(negated.exitCode).toBe(0);
	expect(JSON.parse(negated.stdout)).not.toHaveProperty("schema_version");
	const title = await spawnCli(
		["task", "create", "--dry-run", "--json", "--", "--envelope"],
		{ env: { ...isolated.env, AF_JSON_ENVELOPE: "0" } },
	);
	expect(title.exitCode).toBe(0);
	expect(JSON.parse(title.stdout)).not.toHaveProperty("schema_version");
	expect(JSON.parse(title.stdout).items[0].title).toBe("--envelope");
});

async function fixtureCli(args: string[], fixture: string) {
	const runner = join(isolated.cacheDir, "contract-fixture.ts");
	writeFileSync(
		runner,
		fixture +
			`\nawait import(${JSON.stringify(join(import.meta.dir, "..", "..", "index.ts"))});`,
	);
	const child = Bun.spawn(["bun", runner, ...args], {
		env: { ...process.env, ...isolated.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: await child.exited,
		stdout: await new Response(child.stdout).text(),
		stderr: await new Response(child.stderr).text(),
	};
}

test("fixture API authentication, not-found and upstream errors use distinct codes", async () => {
	for (const [status, code] of [
		[401, 3],
		[404, 4],
		[503, 5],
	] as const) {
		const response = await fixtureCli(
			[
				"task",
				"update",
				"aaaaaaaa-1111-1111-1111-111111111111",
				"--title",
				"New",
				"--json",
				"--envelope",
			],
			`globalThis.fetch = async () => new Response(JSON.stringify({message:"fixture failure"}),{status:${status}});`,
		);
		expect(response.exitCode).toBe(code);
		const envelope = JSON.parse(response.stdout);
		expect(envelope.status).toBe("error");
		expect(envelope.meta.exit_code).toBe(code);
		expect(envelope.errors.length).toBeGreaterThan(0);
	}
});

test("partial batch fixture reports exit 6 in JSON and text with structured errors", async () => {
	const original = JSON.parse(
		readFileSync(join(import.meta.dir, "fixtures", "events.json"), "utf8"),
	)[0];
	const calendars = readFileSync(
		join(import.meta.dir, "fixtures", "calendars.json"),
		"utf8",
	);
	const events = [
		{ ...original, id: "partial-1", title: "Contract fixture", attendees: [] },
		{ ...original, id: "partial-2", title: "Contract fixture", attendees: [] },
	];
	writeFileSync(
		join(isolated.cacheDir, "events.jsonl"),
		events.map((event) => JSON.stringify(event)).join("\n"),
	);
	writeFileSync(
		join(isolated.cacheDir, "calendars.jsonl"),
		JSON.parse(calendars)
			.map((calendar: unknown) => JSON.stringify(calendar))
			.join("\n"),
	);
	const fixture = `globalThis.fetch = async () => new Response(JSON.stringify({success:true,data:[{event_id:"partial-1"}],message:"fixture partial"}));`;
	const command = [
		"batch",
		"events",
		"attendees",
		"add",
		"new@example.com",
		"--search",
		"Contract fixture",
		"--execute",
	];
	for (const json of [true, false]) {
		const response = await fixtureCli(
			[...command, ...(json ? ["--json", "--envelope"] : [])],
			fixture,
		);
		expect(response.exitCode).toBe(6);
		if (json) {
			const envelope = JSON.parse(response.stdout);
			expect(envelope.status).toBe("partial");
			expect(envelope.result.changed).toBe(1);
			expect(envelope.result.failed).toBe(1);
			expect(envelope.errors).toEqual([
				{ id: "partial-2", message: "fixture partial" },
			]);
		}
	}
});
