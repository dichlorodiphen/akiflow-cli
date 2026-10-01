import { afterEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as generation from "../../lib/cache/generation";
import { captureCacheSnapshot } from "../../lib/reconcile/cache-snapshot";
import { af, calendar, now } from "./reconcile-fixtures";

let directory: string | undefined;
const prior = process.env.AF_CACHE_DIR;
afterEach(() => {
	if (prior === undefined) delete process.env.AF_CACHE_DIR;
	else process.env.AF_CACHE_DIR = prior;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});
function cache() {
	directory = mkdtempSync(join(tmpdir(), "af-reconcile-cache-"));
	process.env.AF_CACHE_DIR = directory;
	const pin = join(directory, "gen-1");
	mkdirSync(pin);
	writeFileSync(join(directory, "current"), "gen-1\n");
	writeFileSync(join(pin, "events.jsonl"), `${JSON.stringify(af())}\n`);
	writeFileSync(join(pin, "calendars.jsonl"), `${JSON.stringify(calendar)}\n`);
	writeFileSync(
		join(pin, "tokens.json"),
		JSON.stringify({
			events: "never-use-cached-cursor",
			last_success_at: {
				events: "2026-10-01T04:00:00Z",
				calendars: now.toISOString(),
			},
		}),
	);
	return { directory, pin };
}
test("snapshot pins once, reads timestamps from same generation, writes nothing", () => {
	const { directory, pin } = cache();
	const before = readdirSync(pin).map((file) => [
		file,
		readFileSync(join(pin, file), "utf8"),
	]);
	const spy = spyOn(generation, "pinGeneration");
	try {
		const result = captureCacheSnapshot(now);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.events).toHaveLength(1);
		expect(result.metadata).toMatchObject({
			availability: "available",
			generation: "gen-1",
			events_age_seconds: 3600,
		});
		expect(result.warnings.join(" ")).toContain("ten minutes");
		expect(
			readdirSync(pin).map((file) => [
				file,
				readFileSync(join(pin, file), "utf8"),
			]),
		).toEqual(before);
		expect(readFileSync(join(directory, "current"), "utf8")).toBe("gen-1\n");
		expect(readdirSync(directory)).toEqual(["current", "gen-1"]);
	} finally {
		spy.mockRestore();
	}
});
test("missing cache is unavailable, never initialized", () => {
	directory = join(
		mkdtempSync(join(tmpdir(), "af-reconcile-missing-")),
		"missing",
	);
	process.env.AF_CACHE_DIR = directory;
	const result = captureCacheSnapshot(now);
	expect(result.metadata.availability).toBe("unavailable");
	expect(existsSync(directory)).toBe(false);
	expect(result.warnings).toHaveLength(1);
	rmSync(join(directory, ".."), { recursive: true, force: true });
});
test("corrupt cache yields unavailable, not empty available cache", () => {
	const { pin } = cache();
	writeFileSync(join(pin, "calendars.jsonl"), "{invalid");
	const result = captureCacheSnapshot(now);
	expect(result.metadata.availability).toBe("unavailable");
	expect(result.events).toHaveLength(0);
});
test("vanished pin retries the whole capture once", () => {
	const { directory, pin } = cache();
	const vanished = join(directory, "gen-0");
	const spy = spyOn(generation, "pinGeneration")
		.mockReturnValueOnce(vanished)
		.mockReturnValueOnce(pin);
	try {
		const result = captureCacheSnapshot(now);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(result.metadata.generation).toBe("gen-1");
		expect(result.events).toHaveLength(1);
	} finally {
		spy.mockRestore();
	}
});
test("second vanished pin gives warning after exactly one retry", () => {
	const { directory } = cache();
	const spy = spyOn(generation, "pinGeneration").mockReturnValue(
		join(directory, "gen-0"),
	);
	try {
		expect(captureCacheSnapshot(now).metadata.availability).toBe("unavailable");
		expect(spy).toHaveBeenCalledTimes(2);
	} finally {
		spy.mockRestore();
	}
});
