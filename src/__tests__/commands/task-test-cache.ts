import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolate commands that now read or write the local task repository. */
export function isolateTaskCache(): void {
	let directory: string;
	let previous: string | undefined;
	let previousConfig: string | undefined;
	beforeEach(() => {
		previous = process.env.AF_CACHE_DIR;
		previousConfig = process.env.AF_CONFIG_DIR;
		directory = mkdtempSync(join(tmpdir(), "af-command-tasks-"));
		process.env.AF_CACHE_DIR = directory;
		process.env.AF_CONFIG_DIR = join(directory, "config");
		mkdirSync(process.env.AF_CONFIG_DIR, { recursive: true });
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		rmSync(`${directory}.lock.reclaim`, { force: true });
		if (previous === undefined) delete process.env.AF_CACHE_DIR;
		else process.env.AF_CACHE_DIR = previous;
		if (previousConfig === undefined) delete process.env.AF_CONFIG_DIR;
		else process.env.AF_CONFIG_DIR = previousConfig;
	});
}
