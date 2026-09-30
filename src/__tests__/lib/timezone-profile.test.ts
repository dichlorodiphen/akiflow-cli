import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getProfileTimezone,
	readProfile,
	resolveEffectiveTimezone,
	writeProfile,
} from "../../lib/timezone-profile";

let testConfigDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
	testConfigDir = mkdtempSync(join(tmpdir(), "af-profile-test-"));
	originalConfigDir = process.env.AF_CONFIG_DIR;
	process.env.AF_CONFIG_DIR = testConfigDir;
});

afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.AF_CONFIG_DIR;
	} else {
		process.env.AF_CONFIG_DIR = originalConfigDir;
	}
	rmSync(testConfigDir, { recursive: true, force: true });
});

describe("timezone-profile", () => {
	test("returns empty profile when no config exists", async () => {
		const profile = await readProfile();
		expect(profile).toEqual({});
	});

	test("writes and reads timezone", async () => {
		await writeProfile({ timezone: "America/Los_Angeles" });
		const profile = await readProfile();
		expect(profile.timezone).toBe("America/Los_Angeles");
	});

	test("getProfileTimezone returns null when unset", async () => {
		expect(await getProfileTimezone()).toBeNull();
	});

	test("getProfileTimezone returns set timezone", async () => {
		await writeProfile({ timezone: "Asia/Tokyo" });
		expect(await getProfileTimezone()).toBe("Asia/Tokyo");
	});

	test("resolveEffectiveTimezone prefers explicit flag", async () => {
		await writeProfile({ timezone: "Asia/Tokyo" });
		const result = await resolveEffectiveTimezone("Europe/London");
		expect(result).toBe("Europe/London");
	});

	test("resolveEffectiveTimezone uses profile when no explicit flag", async () => {
		await writeProfile({ timezone: "Asia/Tokyo" });
		const result = await resolveEffectiveTimezone();
		expect(result).toBe("Asia/Tokyo");
	});

	test("resolveEffectiveTimezone falls back to local when no profile", async () => {
		const result = await resolveEffectiveTimezone();
		// Should be a valid timezone (system local)
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("resolveEffectiveTimezone rejects invalid explicit timezone", async () => {
		await expect(resolveEffectiveTimezone("Invalid/Zone")).rejects.toThrow();
	});
});
