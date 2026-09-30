import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { cacheFile, cachePath } from "../../lib/platform-config";

const origAfCacheDir = process.env.AF_CACHE_DIR;
afterEach(() => {
	if (origAfCacheDir === undefined) delete process.env.AF_CACHE_DIR;
	else process.env.AF_CACHE_DIR = origAfCacheDir;
});

describe("platform-config", () => {
	test("cachePath defaults to ~/.cache/af", () => {
		delete process.env.AF_CACHE_DIR;
		expect(cachePath()).toBe(`${homedir()}/.cache/af`);
	});

	test("cacheFile composes paths under cachePath", () => {
		// Use an isolated cache dir to avoid interference from the generational
		// pointer (C) that may exist in the real cache dir.
		process.env.AF_CACHE_DIR = `/tmp/af-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		expect(cacheFile("tasks.jsonl")).toBe(`${process.env.AF_CACHE_DIR}/tasks.jsonl`);
	});

	test("respects AF_CACHE_DIR override", () => {
		process.env.AF_CACHE_DIR = "/tmp/af-test";
		expect(cachePath()).toBe("/tmp/af-test");
		expect(cacheFile("tokens.json")).toBe("/tmp/af-test/tokens.json");
	});
});
