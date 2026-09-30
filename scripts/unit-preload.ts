import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit mocks assert canonical URL strings. Keep those strings while blocking
// accidental external requests, and never read the user's config or cache.
delete process.env.AF_API_BASE;
delete process.env.AF_REFRESH_URL;
const directory = mkdtempSync(join(tmpdir(), "af-unit-"));
process.env.AF_CONFIG_DIR = join(directory, "config");
process.env.AF_CACHE_DIR = join(directory, "cache");
process.env.AF_NO_AUTO_SYNC = "1";

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof fetch>) => {
		const input = args[0];
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
			throw new Error(`Unit test blocked an unmocked external request: ${url}`);
		}
		return originalFetch(...args);
	},
	{ preconnect: originalFetch.preconnect },
);

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});
