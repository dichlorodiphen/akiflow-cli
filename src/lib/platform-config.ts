import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Cache directory root for af.
 * Default: ~/.cache/af
 * Override: $AF_CACHE_DIR (used by tests + advanced users).
 */
export function cachePath(): string {
	return process.env.AF_CACHE_DIR ?? join(homedir(), ".cache", "af");
}

export function cacheFile(name: string): string {
	const pointer = join(cachePath(), "current");
	// Preserve root state paths while existing diagnostic consumers find resources.
	if (
		/^(tasks|events|time_slots|labels|tags|calendars|accounts|contacts)\.jsonl$|^(tokens|manifest)\.json$/.test(
			name,
		) &&
		existsSync(pointer)
	) {
		const generation = readFileSync(pointer, "utf8").trim();
		if (!/^gen-[a-zA-Z0-9-]+$/.test(generation))
			throw new Error("invalid cache generation pointer");
		return join(cachePath(), generation, name);
	}
	return join(cachePath(), name);
}

/** Sibling lock survives rebuilds and staging cleanup. */
export function cacheLockPath(): string {
	return `${resolve(cachePath())}.lock`;
}
