import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;
let env: Record<string, string>;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "af-profile-cli-"));
	env = {
		...process.env,
		AF_PROFILE: "default",
		AF_CONFIG_DIR: join(directory, "config"),
		AF_CACHE_DIR: join(directory, "cache"),
		AF_API_BASE: "http://127.0.0.1:1",
		AF_REFRESH_URL: "http://127.0.0.1:1/oauth/refreshToken",
		AF_NO_AUTO_SYNC: "1",
	} as Record<string, string>;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
async function cli(...args: string[]) {
	const child = Bun.spawn(
		[process.execPath, resolve("src/index.ts"), ...args],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}
test("real CLI handles global flag placement and switching without authenticating or touching legacy data", async () => {
	expect((await cli("profile", "create", "work", "--json")).code).toBe(0);
	for (const args of [
		["--profile", "work", "profile", "status", "--json"],
		["profile", "status", "--profile=work", "--json"],
	]) {
		const result = await cli(...args);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).name).toBe("work");
	}
	const auth = await cli("--profile", "work", "auth", "status", "--json");
	expect(JSON.parse(auth.stdout).authenticated).toBe(false);
	expect(JSON.parse(auth.stdout).profile.name).toBe("work");
	expect((await cli("profile", "use", "work")).code).toBe(0);
	delete env.AF_PROFILE;
	expect(
		JSON.parse((await cli("profile", "status", "--json")).stdout).name,
	).toBe("work");
	expect(
		JSON.parse(
			(await cli("--profile", "default", "profile", "status", "--json")).stdout,
		).name,
	).toBe("default");
});
test("real CLI rejects unknown and traversal profile before any command effect", async () => {
	for (const name of ["missing", "../other"]) {
		const result = await cli(
			"--profile",
			name,
			"task",
			"create",
			"Never submitted",
			"--json",
		);
		expect(result.code).toBe(2);
		expect(result.stderr).not.toContain("Failed to connect");
	}
});
