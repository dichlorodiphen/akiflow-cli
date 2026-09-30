import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli";
import { makeTestEnv } from "./helpers/test-env";

describe("validation before side effects", () => {
	test.each([
		"add",
		"remove",
	])("batch attendees %s accepts multiple positional emails", async (action) => {
		const env = makeTestEnv("http://127.0.0.1:1");
		try {
			writeFileSync(
				join(env.cacheDir, "events.jsonl"),
				JSON.stringify({
					id: "event-id",
					title: "Meeting",
					connector_id: "google",
					calendar_id: "cal",
					akiflow_account_id: "account",
					origin_id: "provider",
					start_time: "2026-06-20T09:00:00Z",
					end_time: "2026-06-20T10:00:00Z",
					attendees: [
						{ email: "first@example.com" },
						{ email: "second@example.com" },
					],
				}),
			);
			writeFileSync(
				join(env.cacheDir, "calendars.jsonl"),
				JSON.stringify({
					id: "cal",
					title: "Calendar",
					connector_id: "google",
					akiflow_account_id: "account",
				}),
			);
			const result = await spawnCli(
				[
					"batch",
					"events",
					"attendees",
					action,
					"first@example.com",
					"second@example.com",
					"--search",
					"Meeting",
					"--date",
					"2026-06-20",
					"--dry-run",
					"--json",
				],
				{ env: { ...env.env, AF_JSON_ENVELOPE: "0" } },
			);
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.items).toHaveLength(1);
			expect(report.items[0].emails).toEqual([
				"first@example.com",
				"second@example.com",
			]);
		} finally {
			env.cleanup();
		}
	});
	test.each(
		[
			["task", "create", "Title", "--typo"],
			["task", "list", "unwanted"],
			["event", "create", "Title", "extra"],
			["cal", "--unknown=true"],
			["task", "wat"],
		].map((argv) => ({ argv })),
	)("rejects $argv without touching config or cache", async ({ argv }) => {
		const env = makeTestEnv("http://127.0.0.1:1");
		try {
			const beforeConfig = readdirSync(env.env.AF_CONFIG_DIR ?? "");
			const result = await spawnCli(argv, { env: env.env });
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain(argv.at(-1) ?? "");
			expect(readdirSync(env.cacheDir)).toEqual([]);
			expect(readdirSync(env.env.AF_CONFIG_DIR ?? "")).toEqual(beforeConfig);
		} finally {
			env.cleanup();
		}
	});
	test("completion includes flags introduced in the command tree", async () => {
		const env = makeTestEnv("http://127.0.0.1:1");
		try {
			const result = await spawnCli(["completion", "bash"], { env: env.env });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("--envelope");
			expect(result.stdout).toContain("--no-envelope");
		} finally {
			env.cleanup();
		}
	});
});
