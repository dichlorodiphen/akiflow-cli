import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ReconcileReport } from "../../lib/reconcile/types";
import { af, calendar, ge, workCalendar } from "../lib/reconcile-fixtures";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { type GooglePlan, makeGoogleReader } from "./helpers/reconcile-google";
import { startReconcileServer } from "./helpers/reconcile-server";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

let server: FakeAkiflowServer;
let env: ReturnType<typeof makeTestEnv>;
let transport: Awaited<ReturnType<typeof startReconcileServer>>;
let googleDir: string;
let google: ReturnType<typeof makeGoogleReader>;
const baseArgs = [
	"reconcile",
	"--date",
	"2026-09-30",
	"--timezone",
	"America/Los_Angeles",
];
function collection(items: unknown[]) {
	return { kind: "calendar#events", items, timeZone: "America/Los_Angeles" };
}
function setup(plan: GooglePlan = {}) {
	google = makeGoogleReader(googleDir, plan);
}
function calls(): Array<{ executable: string; argv: string[] }> {
	return existsSync(google.logPath)
		? readFileSync(google.logPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}
function tree(directory: string) {
	const files: Record<string, { bytes: string; mtime: number }> = {};
	const walk = (path: string) => {
		for (const name of readdirSync(path)) {
			const entry = join(path, name),
				stat = statSync(entry);
			if (stat.isDirectory()) walk(entry);
			else
				files[relative(directory, entry)] = {
					bytes: readFileSync(entry).toString("hex"),
					mtime: stat.mtimeMs,
				};
		}
	};
	walk(directory);
	return files;
}
function seedCache() {
	const generation = join(env.cacheDir, "gen-7");
	mkdirSync(generation);
	writeFileSync(join(env.cacheDir, "current"), "gen-7\n");
	writeFileSync(join(generation, "events.jsonl"), `${JSON.stringify(af())}\n`);
	writeFileSync(
		join(generation, "calendars.jsonl"),
		`${JSON.stringify(calendar)}\n${JSON.stringify(workCalendar)}\n`,
	);
	writeFileSync(
		join(generation, "tokens.json"),
		JSON.stringify({
			events: "cached-token-must-not-be-used",
			calendars: "cached-calendar-token",
			last_success_at: {
				events: "2026-09-30T04:00:00Z",
				calendars: "2026-09-30T04:00:00Z",
			},
		}),
	);
	writeFileSync(
		join(env.cacheDir, "pending-tasks.json"),
		'{"sentinel":"unchanged"}',
	);
}
async function run(extra: string[] = ["--json"]) {
	return spawnCli([...baseArgs, ...extra], {
		env: { ...env.env, ...google.env },
		timeoutMs: 15000,
	});
}
function safety(
	beforeCache: ReturnType<typeof tree>,
	beforeConfig: ReturnType<typeof tree>,
) {
	expect(tree(env.cacheDir)).toEqual(beforeCache);
	expect(tree(env.configDir)).toEqual(beforeConfig);
	expect(server.requests.length).toBeGreaterThan(0);
	expect(server.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(
		server.requests.every((request) =>
			["/v5/events", "/v5/calendars"].includes(request.url.pathname),
		),
	).toBe(true);
	for (const call of calls()) {
		expect(call.executable).toBe(google.executable);
		expect(call.argv.slice(0, 2)).toEqual(["calendar", "events"]);
		expect(["list", "get"]).toContain(call.argv[2] ?? "");
		expect(call.argv).toHaveLength(5);
		const params = JSON.parse(call.argv[4] ?? "{}");
		expect(params).not.toHaveProperty("sendUpdates");
		const allowed =
			call.argv[2] === "list"
				? [
						"calendarId",
						"timeMin",
						"timeMax",
						"singleEvents",
						"showDeleted",
						"orderBy",
						"maxResults",
						"pageToken",
					]
				: ["calendarId", "eventId"];
		expect(Object.keys(params).every((key) => allowed.includes(key))).toBe(
			true,
		);
	}
}

beforeEach(async () => {
	server = new FakeAkiflowServer({ pageSize: 1 });
	transport = await startReconcileServer(server);
	server.seed("calendars", [{ ...calendar }, { ...workCalendar }]);
	server.seed("events", [{ ...af() }]);
	env = makeTestEnv(transport.url);
	Object.assign(env.env, transport.env);
	googleDir = mkdtempSync(join(tmpdir(), "af reconcile Google "));
	setup({
		lists: {
			[calendar.origin_id]: [
				collection([
					ge(),
					ge("study-extra", { start: { dateTime: "2026-10-01T02:45:00Z" } }),
				]),
			],
		},
	});
});
afterEach(async () => {
	await transport?.stop();
	env?.cleanup();
	if (googleDir) rmSync(googleDir, { recursive: true, force: true });
});

describe("af reconcile read-only integration", () => {
	test("Study discrepancy exits zero; tokenless cold GETs, argv spaces, cache and credentials unchanged", async () => {
		seedCache();
		const beforeCache = tree(env.cacheDir),
			beforeConfig = tree(env.configDir);
		const result = await run(["--google-cmd", google.executable, "--json"]);
		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout),
			report: ReconcileReport = output.result;
		expect(report).toMatchObject({
			schema_version: 1,
			complete: true,
			sources: {
				atomic: false,
				akiflow: {
					mode: "fresh_full",
					pages: { calendars: 2, events: 1 },
					complete: true,
				},
				cache: { generation: "gen-7", availability: "available" },
			},
		});
		expect(report.tiers?.google_missing[0]?.reason).toBe("both_gap");
		expect(
			report.tiers?.duplicates_or_overlaps.filter(
				(group) => group.kind === "duplicate" && group.side === "google",
			),
		).toHaveLength(1);
		expect(report.counts.records_by_source).toEqual({
			server: 1,
			cache: 1,
			google: 2,
		});
		expect(
			output.warnings.every((warning: unknown) => typeof warning === "string"),
		).toBe(true);
		for (const resource of ["events", "calendars"])
			expect(
				server.requests
					.find((request) => request.url.pathname === `/v5/${resource}`)
					?.url.searchParams.has("sync_token"),
			).toBe(false);
		const params = JSON.parse(calls()[0]?.argv[4] ?? "{}");
		expect(params).toMatchObject({
			timeMin: "2026-09-30T07:00:00.000Z",
			timeMax: "2026-10-01T07:00:00.000Z",
			singleEvents: true,
			showDeleted: true,
			orderBy: "startTime",
			maxResults: 2500,
		});
		safety(beforeCache, beforeConfig);
	});
	test("401 path fails auth with exactly one GET, no credential refresh/write", async () => {
		seedCache();
		server.force401();
		const beforeCache = tree(env.cacheDir),
			beforeConfig = tree(env.configDir);
		const result = await run();
		expect(result.exitCode).toBe(3);
		const output = JSON.parse(result.stdout);
		expect(output.result).toMatchObject({
			complete: false,
			tiers: null,
			sources: { akiflow: { complete: false } },
		});
		expect(output.errors[0]?.message).toContain("Authenticate separately");
		expect(server.requests).toHaveLength(1);
		expect(calls()).toHaveLength(0);
		safety(beforeCache, beforeConfig);
	});
	test("missing cache stays uninitialized and creates no cache gap", async () => {
		setup({ lists: { [calendar.origin_id]: [collection([ge()])] } });
		const beforeCache = tree(env.cacheDir),
			beforeConfig = tree(env.configDir);
		const result = await run();
		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.result.sources.cache.availability).toBe("unavailable");
		expect(output.result.tiers.google_missing).toHaveLength(0);
		expect(output.warnings.join(" ")).toContain("cache is unavailable");
		safety(beforeCache, beforeConfig);
	});
	test("empty Google page with a token still fetches every page", async () => {
		setup({
			lists: {
				[calendar.origin_id]: [
					{ ...collection([]), nextPageToken: "page-1" },
					collection([ge()]),
				],
			},
		});
		const result = await run();
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).result.sources.google[0].pages).toBe(2);
		expect(calls().filter((call) => call.argv[2] === "list")).toHaveLength(3);
	});
	test("supplementary get finds an exact identity outside the window", async () => {
		setup({
			gets: {
				[`${calendar.origin_id}:g1`]: ge("g1", {
					summary: "Moved Study",
					start: { dateTime: "2026-10-02T02:30:00Z" },
					end: { dateTime: "2026-10-02T04:30:00Z" },
				}),
			},
		});
		const beforeCache = tree(env.cacheDir),
			beforeConfig = tree(env.configDir);
		const result = await run();
		const output = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(output.result.matches).toHaveLength(1);
		expect(
			output.result.records.find(
				(record: { side: string }) => record.side === "google",
			).in_window,
		).toBe(false);
		expect(output.result.tiers.akiflow_missing_or_cancelled).toHaveLength(0);
		expect(output.result.sources.google[0].identity_probes).toBe(1);
		safety(beforeCache, beforeConfig);
	});
	test.each([
		404, 410,
	])("get %s is not-found evidence, findings exit zero", async (code) => {
		setup({
			gets: {
				[`${calendar.origin_id}:g1`]: { error: { code, message: "gone" } },
			},
		});
		const result = await run();
		const output = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(output.result.tiers.akiflow_missing_or_cancelled[0].reason).toBe(
			"provider_id_not_found",
		);
	});
	test("Dinner sparse get cancellation stays evidence and no deletion causality is claimed", async () => {
		setup({
			gets: { [`${calendar.origin_id}:g1`]: { id: "g1", status: "cancelled" } },
		});
		const result = await run();
		const output = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(output.result.cancelled_evidence[0]).toMatchObject({
			title: null,
			time: { kind: "unknown" },
		});
		expect(output.result.tiers.akiflow_missing_or_cancelled[0].reason).toBe(
			"cancelled_on_google",
		);
	});
	test.each([
		401, 403, 500,
	])("required Google failure %s emits incomplete tiers:null with proper exit", async (code) => {
		seedCache();
		setup({ failure: { error: { code, message: "Google failure" } } });
		const beforeCache = tree(env.cacheDir),
			beforeConfig = tree(env.configDir);
		const result = await run();
		const output = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(code === 401 ? 3 : 5);
		expect(output.result).toMatchObject({ complete: false, tiers: null });
		expect(output.result.sources.google[0].complete).toBe(false);
		safety(beforeCache, beforeConfig);
	});
	test("Google identity permission failure invalidates entire report", async () => {
		setup({
			gets: {
				[`${calendar.origin_id}:g1`]: {
					error: { code: 403, message: "identity permission denied" },
				},
			},
		});
		const result = await run();
		expect(result.exitCode).toBe(5);
		expect(JSON.parse(result.stdout).result.tiers).toBeNull();
	});
	test("privsep failure remains upstream and preserves stderr evidence", async () => {
		setup({ raw: "", stderr: "privsep socket denied", exit: 1 });
		const result = await run();
		expect(result.exitCode).toBe(5);
		expect(JSON.parse(result.stdout).errors[0].message).toContain(
			"privsep socket denied",
		);
	});
	test("malformed relevant live Google record fails completeness", async () => {
		setup({
			lists: {
				[calendar.origin_id]: [
					collection([{ id: "broken", status: "confirmed" }]),
				],
			},
		});
		const result = await run();
		expect(result.exitCode).toBe(5);
		expect(JSON.parse(result.stdout).result.tiers).toBeNull();
	});
	test("missing cursor and malformed Akiflow record fail completeness", async () => {
		server.respondTo("GET", "/v5/events", {
			success: true,
			data: [{ id: "broken" }],
			has_next_page: true,
		});
		const result = await run();
		expect(result.exitCode).toBe(5);
		expect(JSON.parse(result.stdout).result.sources.akiflow.complete).toBe(
			false,
		);
		expect(JSON.parse(result.stdout).result.tiers).toBeNull();
	});
	test("unconnected default calendar is still read and diagnosed even when empty", async () => {
		server.seed("calendars", [{ ...calendar }]);
		const result = await run();
		const output = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(output.result.sources.google).toHaveLength(2);
		expect(output.result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "calendar_not_connected",
				calendar: workCalendar.origin_id,
			}),
		);
	});
	test("explicit calendar replaces both defaults", async () => {
		const result = await run(["--calendar", "Personal", "--json"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).result.sources.google).toHaveLength(1);
		expect(
			calls().every(
				(call) =>
					JSON.parse(call.argv[4] ?? "{}").calendarId === calendar.origin_id,
			),
		).toBe(true);
	});
	test("JSON envelope is valid and warnings stay on stderr in human mode", async () => {
		seedCache();
		const json = await run(["--json", "--envelope"]);
		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			schema_version: 1,
			command: "reconcile",
			status: "ok",
			result: { schema_version: 1, complete: true },
		});
		const human = await run([]);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("Google missing from Akiflow (1)");
		expect(human.stdout).not.toContain("Warning:");
		expect(human.stderr).toContain("Warning:");
	});
	test("profile timezone precedes host timezone", async () => {
		writeFileSync(
			join(env.env.AF_CONFIG_DIR ?? "", "config.json"),
			'{"timezone":"America/Los_Angeles"}',
		);
		const result = await spawnCli(
			["reconcile", "--date", "2026-09-30", "--json"],
			{ env: { ...env.env, ...google.env, TZ: "UTC" } },
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).result.window.start).toBe(
			"2026-09-30T07:00:00.000Z",
		);
	});
	test("usage and helper-missing exit 2 before provider requests", async () => {
		for (const extra of [
			["--today", "--tomorrow"],
			["--from", "today"],
			["--google-cmd", "/missing/helper"],
			["--date", "today at 9am"],
		]) {
			const result = await spawnCli(["reconcile", ...extra, "--json"], {
				env: { ...env.env, ...google.env },
			});
			expect(result.exitCode).toBe(2);
		}
		expect(server.requests).toHaveLength(0);
	});
});

test("read-only series-master probe establishes series presence, not a missing occurrence", async () => {
	server.seed("events", [
		{
			...af("master", {
				origin_id: "series",
				recurring_id: "master",
				recurrence: ["RRULE:FREQ=DAILY"],
				hidden: true,
			}),
		},
	]);
	setup({
		gets: {
			[`${calendar.origin_id}:series`]: ge("series", {
				recurrence: ["RRULE:FREQ=DAILY"],
			}),
		},
	});
	const beforeCache = tree(env.cacheDir),
		beforeConfig = tree(env.configDir);
	const result = await run();
	const output = JSON.parse(result.stdout);
	expect(result.exitCode).toBe(0);
	expect(output.result.matches).toHaveLength(0);
	expect(output.result.tiers.akiflow_missing_or_cancelled[0].reason).toBe(
		"series_present_occurrence_unobserved",
	);
	expect(output.result.sources.google[0].identity_probes).toBe(1);
	safety(beforeCache, beforeConfig);
});
