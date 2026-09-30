import { afterEach, beforeEach, expect, test } from "bun:test";
import { open, readdir, stat, writeFile } from "node:fs/promises";
import { refreshAccessToken, requestTimeoutMs } from "../../lib/auth/refresh";
import { saveCredentials } from "../../lib/auth/storage";
import { FakeAkiflowServer } from "../integration/helpers/fake-server";
import { localCliSession } from "../integration/helpers/run-local-cli";

let server: FakeAkiflowServer;
let session: ReturnType<typeof localCliSession>;
let priorTimeout: string | undefined;
beforeEach(() => {
	server = new FakeAkiflowServer();
	session = localCliSession(server);
	priorTimeout = process.env.AF_REQUEST_TIMEOUT_MS;
});
afterEach(() => {
	session.cleanup();
	if (priorTimeout === undefined) delete process.env.AF_REQUEST_TIMEOUT_MS;
	else process.env.AF_REQUEST_TIMEOUT_MS = priorTimeout;
});
test("refresh module returns null on rejection, malformed payload, drop, and timeout", async () => {
	const options = { refreshToken: "bad", clientId: "10" };
	expect(await refreshAccessToken(options)).toBeNull();
	for (const payload of [
		null,
		{},
		{ access_token: "a", refresh_token: "b" },
		{ access_token: "a", refresh_token: "b", expires_in: "1" },
		{ access_token: 4, refresh_token: "b", expires_in: 1 },
	]) {
		server.respondTo("POST", "/oauth/refreshToken", payload);
		expect(await refreshAccessToken(options)).toBeNull();
	}
	server.schedule({ path: "/oauth/refreshToken", type: "drop" });
	expect(await refreshAccessToken(options)).toBeNull();
	server.schedule({ path: "/oauth/refreshToken", type: "latency", ms: 40 });
	expect(await refreshAccessToken({ ...options, timeoutMs: 5 })).toBeNull();
});
test("timeout override follows lock convention with a bounded positive default", () => {
	for (const value of ["", "garbage", "0", "-1", "Infinity"]) {
		process.env.AF_REQUEST_TIMEOUT_MS = value;
		expect(requestTimeoutMs()).toBe(30000);
	}
	process.env.AF_REQUEST_TIMEOUT_MS = "17";
	expect(requestTimeoutMs()).toBe(17);
});
test("atomic credential write: concurrent raw reads always see complete JSON and mode 0600", async () => {
	const token = "x".repeat(128 * 1024);
	await saveCredentials(token, "test", 42, "fake-refresh");
	// Pin the original inode: replacement must publish a new file, and the
	// old reader must retain its complete snapshot. Holding it prevents inode reuse.
	const oldReader = await open(session.env.credentialsPath, "r");
	const oldInode = (await oldReader.stat()).ino;
	const ready = `${session.env.configDir}/reader-ready`;
	const stop = `${session.env.configDir}/reader-stop`;
	const worker = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
		const fs = require("node:fs");
		const [target, ready, stop] = process.argv.slice(1);
		let reads = 0;
		fs.writeFileSync(ready, "ready");
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(stop) && Date.now() < deadline) {
			const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
			if (parsed.token.length !== 128 * 1024 || parsed.clientId !== "test") throw new Error("torn credentials");
			reads++;
		}
		console.log(reads);
	`,
			session.env.credentialsPath,
			ready,
			stop,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	try {
		for (let i = 0; !(await Bun.file(ready).exists()); i++) {
			if (i > 500) throw new Error("reader failed to start");
			await Bun.sleep(5);
		}
		for (let i = 0; i < 100; i++)
			await saveCredentials(token, "test", i + 1, "fake-refresh");
	} finally {
		await writeFile(stop, "stop");
		await worker.exited;
	}
	const finalInode = (await stat(session.env.credentialsPath)).ino;
	const pinned = JSON.parse(await oldReader.readFile("utf8"));
	await oldReader.close();
	expect(finalInode).not.toBe(oldInode);
	expect(pinned.expiryTimestamp).toBe(42);
	const output = await new Response(worker.stdout).text();
	const errors = await new Response(worker.stderr).text();
	expect(errors).toBe("");
	expect(worker.exitCode).toBe(0);
	expect(Number(output)).toBeGreaterThan(1);
	expect((await stat(session.env.credentialsPath)).mode & 0o777).toBe(0o600);
	expect(await readdir(session.env.env.AF_CONFIG_DIR ?? "")).toEqual([
		"credentials.json",
	]);
});
