import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AkiflowClient } from "../../lib/api/client";
import {
	bindVerifiedIdentity,
	boundIdentity,
	tokenUserId,
	verifyAuthenticatedIdentity,
} from "../../lib/auth/identity";
import { loadCredentials, saveCredentials } from "../../lib/auth/storage";
import { cacheFile, cachePath } from "../../lib/platform-config";
import {
	configPath,
	createProfile,
	defaultProfile,
	listProfiles,
	selectedProfile,
	selectProfile,
	useProfile,
	validateProfileName,
} from "../../lib/profiles";
import { readProfile, writeProfile } from "../../lib/timezone-profile";

let directory: string;
let old: Record<string, string | undefined>;
beforeEach(() => {
	old = {
		AF_CONFIG_DIR: process.env.AF_CONFIG_DIR,
		AF_CACHE_DIR: process.env.AF_CACHE_DIR,
		AF_PROFILE: process.env.AF_PROFILE,
	};
	directory = mkdtempSync(join(tmpdir(), "af-profiles-"));
	process.env.AF_CONFIG_DIR = join(directory, "config");
	process.env.AF_CACHE_DIR = join(directory, "cache");
	delete process.env.AF_PROFILE;
});
afterEach(() => {
	for (const [key, value] of Object.entries(old)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(directory, { recursive: true, force: true });
});
test("legacy default retains existing credentials, timezone, IDs and journal paths", async () => {
	expect(selectedProfile()).toBe("default");
	expect(configPath()).toBe(join(directory, "config"));
	expect(cachePath()).toBe(join(directory, "cache"));
	await saveCredentials("legacy", "client");
	await writeProfile({ timezone: "America/Los_Angeles" });
	expect((await loadCredentials())?.token).toBe("legacy");
	expect(cacheFile("last-list.json")).toBe(
		join(join(directory, "cache"), "last-list.json"),
	);
});
test("profile switching isolates credentials, config, numbered IDs and mutation journals", async () => {
	await saveCredentials("legacy", "legacy-client");
	await writeProfile({ timezone: "UTC" });
	const legacyCache = cachePath();
	createProfile("work");
	selectProfile("work");
	expect(await loadCredentials()).toBeNull();
	expect(await readProfile()).toEqual({});
	expect(cachePath()).not.toBe(legacyCache);
	for (const name of [
		"last-list.json",
		"pending-tasks.json",
		"event-creations.json",
		"conversion-journal.json",
		"provider-google.json",
	])
		expect(cacheFile(name)).toStartWith(join(legacyCache, "profiles", "work"));
	await saveCredentials("work-token", "work-client");
	await writeProfile({ timezone: "Asia/Tokyo" });
	selectProfile("default");
	expect((await loadCredentials())?.token).toBe("legacy");
	expect((await readProfile()).timezone).toBe("UTC");
	selectProfile("work");
	expect((await loadCredentials())?.token).toBe("work-token");
	expect((await readProfile()).timezone).toBe("Asia/Tokyo");
});
test("saved default changes future selection while explicit current process remains pinned", () => {
	createProfile("work");
	selectProfile("default");
	useProfile("work");
	expect(defaultProfile()).toBe("work");
	expect(selectedProfile()).toBe("default");
	delete process.env.AF_PROFILE;
	expect(selectedProfile()).toBe("work");
	expect(selectProfile("default")).toBe("default");
	expect(listProfiles()).toEqual(["default", "work"]);
});
test("invalid names, missing profiles and corrupt default refuse before storage use", () => {
	for (const value of [
		"",
		".",
		"..",
		"../other",
		"a/b",
		"a\\b",
		"bad name",
		"x".repeat(65),
	])
		expect(() => validateProfileName(value)).toThrow();
	expect(() => selectProfile("missing")).toThrow("does not exist");
	createProfile("work");
	expect(() => createProfile("work")).toThrow("already exists");
	writeFileSync(join(join(directory, "config"), "default-profile"), "../other");
	expect(() => selectedProfile()).toThrow();
});

test("clients pin profiles and concurrent clients share one refresh-token rotation", async () => {
	createProfile("work");
	await saveCredentials("default-old", "default-client", 1, "default-refresh");
	const first = new AkiflowClient();
	const second = new AkiflowClient();
	selectProfile("work");
	await saveCredentials("work-old", "work-client", 1, "work-refresh");
	const work = new AkiflowClient();
	const rotations: string[] = [];
	const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		if (String(input).includes("refreshToken")) {
			const body = JSON.parse(String(init?.body));
			rotations.push(body.refresh_token);
			await Bun.sleep(10);
			return new Response(
				JSON.stringify({
					access_token: body.refresh_token.replace("refresh", "new"),
					refresh_token: `${body.refresh_token}-rotated`,
					expires_in: 3600,
				}),
			);
		}
		const token = new Headers(init?.headers).get("Authorization") ?? "";
		return token.endsWith("old")
			? new Response("{}", { status: 401 })
			: new Response(
					JSON.stringify({ success: true, data: token, message: null }),
				);
	}) as typeof globalThis.fetch);
	try {
		const results = await Promise.all([
			first.get<string>("/v5/user/settings"),
			second.get<string>("/v5/user/settings"),
			work.get<string>("/v5/user/settings"),
		]);
		expect(results.map((r) => r.data)).toEqual([
			"Bearer default-new",
			"Bearer default-new",
			"Bearer work-new",
		]);
		expect(rotations.sort()).toEqual(["default-refresh", "work-refresh"]);
		expect((await loadCredentials())?.token).toBe("work-new");
		selectProfile("default");
		expect((await loadCredentials())?.token).toBe("default-new");
	} finally {
		fetch.mockRestore();
	}
});

function jwt(user: number) {
	return `header.${Buffer.from(JSON.stringify({ user_id: user })).toString("base64url")}.signature`;
}
test("verified identity is server-derived, rejects invalid response and conflicting token claims", async () => {
	let value: unknown = { id: 42 };
	const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
		input,
		init,
	) => {
		expect(String(input)).toBe("https://web.akiflow.com/api/v2/user");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			`Bearer ${jwt(42)}`,
		);
		return new Response(JSON.stringify(value));
	}) as typeof globalThis.fetch);
	try {
		expect(await verifyAuthenticatedIdentity(jwt(42), "client")).toBe(42);
		for (const invalid of [
			{ id: "42" },
			{ data: { id: 42 } },
			null,
			{ id: 99 },
		]) {
			value = invalid;
			await expect(
				verifyAuthenticatedIdentity(jwt(42), "client"),
			).rejects.toThrow();
		}
	} finally {
		fetch.mockRestore();
	}
});
test("identity binding refuses credential replacement, mismatched cache and manually copied credentials", async () => {
	await saveCredentials(jwt(42), "client");
	bindVerifiedIdentity(42, jwt(42));
	expect(boundIdentity()).toBe(42);
	await expect(saveCredentials(jwt(99), "other")).rejects.toThrow(
		"do not match",
	);
	expect((await loadCredentials())?.token).toBe(jwt(42));
	expect(() => bindVerifiedIdentity(99, jwt(42))).toThrow(
		"another Akiflow identity",
	);
	writeFileSync(
		join(configPath(), "credentials.json"),
		JSON.stringify({
			token: jwt(99),
			clientId: "other",
			expiryTimestamp: Date.now() + 60000,
		}),
	);
	expect(await loadCredentials()).toBeNull();
	createProfile("other");
	selectProfile("other");
	expect(() => bindVerifiedIdentity(99, jwt(42))).toThrow(
		"Existing credentials",
	);
	mkdirSync(cachePath(), { recursive: true });
	writeFileSync(
		cacheFile("events.jsonl"),
		`${JSON.stringify({ id: "foreign-event", user_id: 42 })}\n`,
	);
	expect(() => bindVerifiedIdentity(99)).toThrow("Existing cache");
});

test("real OAuth numeric string sub is recognized without treating arbitrary subjects as identities", () => {
	const token = (value: unknown) =>
		`header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
	expect(tokenUserId(token({ sub: "424242", resource: "*" }))).toBe(424242);
	for (const sub of ["", "424242junk", "1.2", "-1", "9007199254740993", 424242])
		expect(tokenUserId(token({ sub }))).toBeNull();
});

test("explicit credential clients never adopt an ambient profile after rejection", async () => {
	await saveCredentials("ambient-token", "ambient-client");
	const observed: string[] = [];
	const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
		_input,
		init,
	) => {
		observed.push(new Headers(init?.headers).get("Authorization") ?? "");
		return new Response("{}", { status: 401 });
	}) as typeof globalThis.fetch);
	try {
		const client = new AkiflowClient({
			credentials: { token: "explicit-other", clientId: "other-client" },
		});
		await expect(client.get("/v5/tasks")).rejects.toThrow(
			"Authentication failed",
		);
		expect(observed).toEqual(["Bearer explicit-other"]);
	} finally {
		fetch.mockRestore();
	}
});
