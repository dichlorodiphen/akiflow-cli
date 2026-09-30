import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLocalTimezone } from "./date-parser";
import { validateTimezone } from "./timezone";

export interface AfProfile {
	/** Default IANA timezone for scheduling (e.g., "America/Los_Angeles"). */
	timezone?: string;
}

function getConfigPath(): string {
	return process.env.AF_CONFIG_DIR ?? join(homedir(), ".config", "af");
}

function getProfilePath(): string {
	return join(getConfigPath(), "config.json");
}

/**
 * Read the user's profile (cached; re-read on each call to support tests
 * that change AF_CONFIG_DIR).
 */
export async function readProfile(): Promise<AfProfile> {
	const path = getProfilePath();
	if (!existsSync(path)) return {};
	try {
		const content = await readFile(path, "utf-8");
		const parsed = JSON.parse(content) as AfProfile;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Write profile fields (merges with existing).
 */
export async function writeProfile(patch: AfProfile): Promise<void> {
	const dir = getConfigPath();
	await mkdir(dir, { recursive: true });
	const existing = await readProfile();
	const merged = { ...existing, ...patch };
	const path = getProfilePath();
	const tmp = `${path}.${crypto.randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
	const { rename } = await import("node:fs/promises");
	await rename(tmp, path);
}

/**
 * Get the profile's default timezone, if set and valid.
 */
export async function getProfileTimezone(): Promise<string | null> {
	const profile = await readProfile();
	if (!profile.timezone) return null;
	try {
		return validateTimezone(profile.timezone);
	} catch {
		return null;
	}
}

/**
 * Resolve the effective timezone for a scheduling operation.
 *
 * Precedence: explicit --timezone flag > profile setting > system local timezone.
 *
 * @param explicit - Value of --timezone flag, if provided
 * @returns IANA timezone name
 */
export async function resolveEffectiveTimezone(
	explicit?: string | null,
): Promise<string> {
	if (explicit) {
		return validateTimezone(explicit);
	}
	const profileTz = await getProfileTimezone();
	if (profileTz) return profileTz;
	return getLocalTimezone();
}

/**
 * Synchronous version for contexts where async is unavailable.
 * Uses explicit flag > AF_TIMEZONE env > system local.
 * (Profile file read is async; use resolveEffectiveTimezone when possible.)
 */
export function resolveEffectiveTimezoneSync(explicit?: string | null): string {
	if (explicit) {
		return validateTimezone(explicit);
	}
	const envTz = process.env.AF_TIMEZONE;
	if (envTz) {
		try {
			return validateTimezone(envTz);
		} catch {
			// Fall through to local
		}
	}
	return getLocalTimezone();
}
