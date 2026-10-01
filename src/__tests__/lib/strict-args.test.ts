import { describe, expect, test } from "bun:test";
import { defineCommand } from "citty";
import { main } from "../../command-tree";
import { commandManifest } from "../../lib/command-tree";
import { validateArgv } from "../../lib/strict-args";

const leaf = defineCommand({
	args: {
		name: { type: "positional", required: true },
		quiet: { type: "boolean", alias: "q" },
		verbose: { type: "boolean", alias: "v" },
		search: { type: "string", alias: "s" },
		mode: { type: "enum", options: ["one", "two"] },
		"dry-run": { type: "boolean" },
		execute: { type: "boolean" },
	},
});
const tree = defineCommand({ subCommands: { thing: leaf, alias: leaf } });

describe("strict command tree arguments", () => {
	test.each([
		"add",
		"remove",
	])("batch attendees %s accepts multiple positional emails", async (action) => {
		await expect(
			validateArgv(main, [
				"batch",
				"events",
				"attendees",
				action,
				"first@example.com",
				"second@example.com",
				"--dry-run",
			]),
		).resolves.toMatchObject({ command: `batch events attendees ${action}` });
	});
	test.each(
		[
			["thing", "title", "--wat"],
			["thing", "title", "extra"],
			["thing", "title", "--search"],
			["thing", "title", "--no-search"],
			["thing", "title", "-qx"],
			["thing", "title", "--mode=nonsense"],
			["thing", "title", "--quiet=maybe"],
			["absent"],
		].map((argv) => ({ argv })),
	)("rejects $argv", async ({ argv }) => {
		await expect(validateArgv(tree, argv)).rejects.toThrow();
	});
	test("names offending flags and positionals", async () => {
		await expect(
			validateArgv(tree, ["thing", "title", "--wat"]),
		).rejects.toThrow("--wat");
		await expect(
			validateArgv(tree, ["thing", "title", "extra"]),
		).rejects.toThrow("extra");
	});
	test("supports inline and separate strings, short bundles, aliases, and negation", async () => {
		expect(
			(
				await validateArgv(tree, [
					"alias",
					"title",
					"-qshello",
					"--no-verbose",
					"--mode=one",
				])
			).values,
		).toEqual({ quiet: true, search: "hello", verbose: false, mode: "one" });
		expect(
			(
				await validateArgv(tree, [
					"thing",
					"title",
					"--search",
					"hello",
					"--quiet=false",
				])
			).values,
		).toEqual({ search: "hello", quiet: false });
	});
	test("terminator makes flag-shaped title positional", async () => {
		await expect(
			validateArgv(tree, ["thing", "--", "--wat"]),
		).resolves.toMatchObject({ command: "thing" });
	});
	test("required fields and contradictory execution flags fail", async () => {
		await expect(validateArgv(tree, ["thing"])).rejects.toThrow("name");
		await expect(
			validateArgv(tree, ["thing", "title", "--execute", "--dry-run"]),
		).rejects.toThrow("--execute and --dry-run");
		await expect(
			validateArgv(tree, ["thing", "--help"]),
		).resolves.toBeDefined();
	});
	test("completion derives aliases and flags from definitions", async () => {
		const manifest = await commandManifest(tree);
		expect(manifest.thing?.flags).toContain("--search");
		expect(manifest.thing?.flags).toContain("-s");
		expect(manifest.thing?.flags).toContain("--no-quiet");
		expect(manifest.alias?.flags).toEqual(manifest.thing?.flags);
	});
});

test("reconcile exposes only read-only day, calendar, timezone and helper flags", async () => {
	await expect(
		validateArgv(main, [
			"reconcile",
			"--date",
			"2026-09-30",
			"--timezone",
			"America/Los_Angeles",
			"--calendar",
			"Personal",
			"--google-cmd",
			"/tmp/helper with spaces",
			"--json",
			"--envelope",
		]),
	).resolves.toMatchObject({ command: "reconcile" });
	for (const flag of [
		"--execute",
		"--delete",
		"--raw",
		"--search",
		"--send-updates",
		"--refresh",
	])
		await expect(validateArgv(main, ["reconcile", flag])).rejects.toThrow(flag);
	await expect(validateArgv(main, ["reconcile", "unexpected"])).rejects.toThrow(
		"unexpected",
	);
});
