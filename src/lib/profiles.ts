import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configRoot(): string {
	return process.env.AF_CONFIG_DIR ?? join(homedir(), ".config", "af");
}
export function cacheRoot(): string {
	return process.env.AF_CACHE_DIR ?? join(homedir(), ".cache", "af");
}
export function validateProfileName(name: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
		throw new Error(
			"Profile names must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit",
		);
	return name;
}
export function defaultProfile(): string {
	const path = join(configRoot(), "default-profile");
	return existsSync(path)
		? validateProfileName(readFileSync(path, "utf8").trim())
		: "default";
}
export function selectedProfile(): string {
	return validateProfileName(process.env.AF_PROFILE ?? defaultProfile());
}
export function configPath(profile = selectedProfile()): string {
	validateProfileName(profile);
	return profile === "default"
		? configRoot()
		: join(configRoot(), "profiles", profile);
}
export function profileCachePath(profile = selectedProfile()): string {
	validateProfileName(profile);
	return profile === "default"
		? cacheRoot()
		: join(cacheRoot(), "profiles", profile);
}
export function profileExists(profile: string): boolean {
	return (
		profile === "default" ||
		existsSync(join(configPath(profile), "profile.json"))
	);
}
export function selectProfile(explicit?: string): string {
	const name = validateProfileName(explicit ?? selectedProfile());
	if (!profileExists(name))
		throw new Error(
			`Profile '${name}' does not exist. Run 'af profile create ${name}' first.`,
		);
	// Pin for the whole process, including commands that await a token refresh.
	process.env.AF_PROFILE = name;
	return name;
}
export function createProfile(name: string): void {
	validateProfileName(name);
	if (profileExists(name)) throw new Error(`Profile '${name}' already exists`);
	mkdirSync(configPath(name), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(configPath(name), "profile.json"),
		JSON.stringify({ schema_version: 1, name }),
		{ flag: "wx", mode: 0o600 },
	);
}
export function useProfile(name: string): void {
	if (!profileExists(name)) throw new Error(`Profile '${name}' does not exist`);
	mkdirSync(configRoot(), { recursive: true, mode: 0o700 });
	const path = join(configRoot(), "default-profile");
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	writeFileSync(temporary, `${name}\n`, { mode: 0o600, flag: "wx" });
	renameSync(temporary, path);
}
export function listProfiles(): string[] {
	const root = join(configRoot(), "profiles");
	return [
		"default",
		...(existsSync(root)
			? readdirSync(root)
					.filter((name) => {
						try {
							return name !== "default" && profileExists(name);
						} catch {
							return false;
						}
					})
					.sort()
			: []),
	];
}
export function profileStatus() {
	return {
		name: selectedProfile(),
		default: defaultProfile(),
		config_path: configPath(),
		cache_path: profileCachePath(),
	};
}
