import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

// Standalone packaging check: no integration helpers or fake credentials.
const root = join(import.meta.dir, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "af-compiled-smoke-"));
const binary = join(temporaryDirectory, "af");
const env = {
	...process.env,
	AF_CONFIG_DIR: join(temporaryDirectory, "config"),
	AF_CACHE_DIR: join(temporaryDirectory, "cache"),
	AF_API_BASE: "http://127.0.0.1:1",
	AF_REFRESH_URL: "http://127.0.0.1:1/oauth/refreshToken",
	AF_NO_AUTO_SYNC: "1",
	NO_COLOR: "1",
};

function run(command: string, args: string[], timeout = 10_000) {
	const result = spawnSync(command, args, {
		cwd: root,
		env,
		encoding: "utf8",
		timeout,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, `Process terminated: ${result.signal}`);
	return result;
}

try {
	const build = run(
		process.execPath,
		["build", "src/index.ts", "--compile", "--outfile", binary],
		120_000,
	);
	assert.equal(build.status, 0, `Compilation failed: ${build.stderr}`);

	const help = run(binary, ["--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Akiflow CLI/);
	assert.match(help.stdout, /task/);

	const version = run(binary, ["--version"]);
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), pkg.version);

	const unauthenticated = run(binary, ["project", "list"]);
	assert.equal(unauthenticated.status, 1);
	assert.match(
		unauthenticated.stderr,
		/Error: No credentials found\. Please login first\./,
	);
	assert.doesNotMatch(
		unauthenticated.stderr,
		/panic|segmentation fault|\n\s+at\s/i,
	);
	console.log(
		"Compiled binary smoke passed (--help, --version, missing auth).",
	);
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
