import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { AkiflowClient } from "../../lib/api/client";
import { AuthError, HttpError, NetworkError } from "../../lib/api/types";
import * as extraction from "../../lib/auth/extract-token";
import { refreshAccessToken } from "../../lib/auth/refresh";
import { loadCredentials, saveCredentials } from "../../lib/auth/storage";
import { FakeAkiflowServer } from "./helpers/fake-server";
import { localCliSession } from "./helpers/run-local-cli";

let server: FakeAkiflowServer;
let session: ReturnType<typeof localCliSession>;
let scan: ReturnType<typeof spyOn<typeof extraction, "scanBrowsers">>;
let priorTimeout: string | undefined;
beforeEach(() => {
	server = new FakeAkiflowServer();
	server.respondTo("GET", "/v5/user/settings", {
		success: true,
		data: {},
		message: null,
	});
	session = localCliSession(server);
	scan = spyOn(extraction, "scanBrowsers").mockResolvedValue([]);
	priorTimeout = process.env.AF_REQUEST_TIMEOUT_MS;
});
afterEach(() => {
	scan.mockRestore();
	session.cleanup();
	if (priorTimeout === undefined) delete process.env.AF_REQUEST_TIMEOUT_MS;
	else process.env.AF_REQUEST_TIMEOUT_MS = priorTimeout;
});
const refreshCount = () =>
	server.requests.filter((r) => r.url.pathname === "/oauth/refreshToken")
		.length;
async function rotateServer() {
	const result = await refreshAccessToken({
		refreshToken: "fake-refresh",
		clientId: "10",
	});
	expect(result).not.toBeNull();
	server.requests.length = 0;
	if (!result) throw new Error("fake refresh failed");
	return result;
}

describe("K auth and transport", () => {
	test("dispatch: status/logout/refresh never scan; bare auth helps and login scans", async () => {
		for (const args of [
			["auth", "status"],
			["auth", "refresh"],
			["auth", "logout"],
			["auth"],
		]) {
			const result = await session.run(args);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Scanning browsers");
		}
		expect(scan).not.toHaveBeenCalled();
		const result = await session.run(["auth", "login"]);
		expect(result.stdout).toContain("Scanning browsers");
		expect(scan).toHaveBeenCalledTimes(1);
	});
	test("refresh success rotates and saves tokens without scanning", async () => {
		const previous = await loadCredentials();
		const result = await session.run(["auth", "refresh"]);
		const stored = await loadCredentials();
		expect(result.exitCode).toBe(0);
		expect(stored?.token).not.toBe(previous?.token);
		expect(stored?.token).toContain(".refreshed");
		expect(stored?.clientId).toBe(previous?.clientId);
		expect(stored?.refreshToken).toBe("fake-refresh");
		expect(stored?.expiryTimestamp).toBeGreaterThan(Date.now());
		expect(refreshCount()).toBe(1);
		expect(JSON.parse(server.requests[0]?.body ?? "")).toEqual({
			client_id: "10",
			refresh_token: "fake-refresh",
		});
		expect(scan).not.toHaveBeenCalled();
	});
	test("refresh retention: failed refresh preserves byte-identical credentials", async () => {
		await saveCredentials("old", "test", 123, "wrong-refresh");
		const before = await readFile(session.env.credentialsPath);
		const result = await session.run(["auth", "refresh"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Existing credentials retained.");
		expect(await readFile(session.env.credentialsPath)).toEqual(before);
		expect(result.stdout).not.toContain("Scanning browsers");
	});
	test("refresh without saved refresh token falls back to login", async () => {
		await saveCredentials("old");
		expect((await session.run(["auth", "refresh"])).stdout).toContain(
			"Scanning browsers",
		);
		expect(scan).toHaveBeenCalledTimes(1);
	});
	test("shared refresh: concurrent 401s produce exactly one refresh and all succeed", async () => {
		await rotateServer();
		server.schedule({ path: "/oauth/refreshToken", type: "latency", ms: 30 });
		const client = new AkiflowClient();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => client.get("/v5/tasks")),
		);
		expect(results.every((r) => r.success)).toBe(true);
		expect(refreshCount()).toBe(1);
	});
	test("timeout: API latency throws a NetworkError naming timeout/method/path", async () => {
		process.env.AF_REQUEST_TIMEOUT_MS = "5";
		server.schedule({ path: "/v5/tasks", type: "latency", ms: 50 });
		try {
			await new AkiflowClient().get("/v5/tasks");
			throw new Error("expected timeout");
		} catch (error) {
			expect(error).toBeInstanceOf(NetworkError);
			expect((error as Error).message).toBe(
				"API request timed out after 5ms: GET /v5/tasks",
			);
		}
	});
	test("timeout: refresh latency is bounded and diagnosed by the client", async () => {
		await rotateServer();
		process.env.AF_REQUEST_TIMEOUT_MS = "5";
		server.schedule({ path: "/oauth/refreshToken", type: "latency", ms: 50 });
		await expect(new AkiflowClient().get("/v5/tasks")).rejects.toThrow(
			"API request timed out after 5ms: POST /oauth/refreshToken",
		);
	});
	test("structured HTTP errors preserve status/path/raw body and readable message", async () => {
		server.schedule({ path: "/v5/tasks", type: "rate-limit", retryAfter: 3 });
		try {
			await new AkiflowClient().get("/v5/tasks");
			throw new Error("expected HTTP error");
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			expect(error).toBeInstanceOf(NetworkError);
			const http = error as HttpError;
			expect(http.status).toBe(429);
			expect(http.path).toBe("/v5/tasks");
			expect(http.responseBody).toBeTruthy();
			expect(http.message).toContain("API request failed with status 429:");
		}
		await expect(
			new AkiflowClient().get("/v3/events/modifiers"),
		).rejects.toBeInstanceOf(HttpError);
	});
	test("cross-process rotation reloads disk after failed refresh and retries once", async () => {
		const rotated = await rotateServer();
		const client = new AkiflowClient({
			credentials: { token: "stale", clientId: "test", refreshToken: "bad" },
		});
		const gate = server.gate({ path: "/oauth/refreshToken" });
		const request = client.get("/v5/tasks");
		await gate.entered;
		await saveCredentials(
			rotated.accessToken,
			"test",
			rotated.expiresAtMs,
			rotated.refreshToken,
		);
		gate.release();
		expect((await request).success).toBe(true);
		expect(refreshCount()).toBe(1);
		expect(
			server.requests.filter((r) => r.url.pathname === "/v5/tasks"),
		).toHaveLength(2);
	});
	test("disk rotation also recovers from a timed-out refresh", async () => {
		const rotated = await rotateServer();
		process.env.AF_REQUEST_TIMEOUT_MS = "10";
		const client = new AkiflowClient({
			credentials: { token: "stale", clientId: "test", refreshToken: "bad" },
		});
		server.schedule({ path: "/oauth/refreshToken", type: "latency", ms: 50 });
		await saveCredentials(
			rotated.accessToken,
			"test",
			rotated.expiresAtMs,
			rotated.refreshToken,
		);
		expect((await client.get("/v5/tasks")).success).toBe(true);
		expect(refreshCount()).toBe(1);
		expect(
			server.requests.filter((r) => r.url.pathname === "/v5/tasks"),
		).toHaveLength(2);
	});

	test("retry guard refuses a second 401", async () => {
		await rotateServer();
		server.respondTo(
			"GET",
			"/v5/tasks",
			{ message: "always unauthorized" },
			401,
		);
		await expect(new AkiflowClient().get("/v5/tasks")).rejects.toBeInstanceOf(
			AuthError,
		);
		expect(refreshCount()).toBe(1);
		expect(
			server.requests.filter((r) => r.url.pathname === "/v5/tasks"),
		).toHaveLength(2);
	});
	test("doctor strict missing credentials is critical with recovery and skips API", async () => {
		await unlink(session.env.credentialsPath);
		const result = await session.run(["doctor", "--strict", "--json"]);
		expect(result.exitCode).not.toBe(0);
		const report = JSON.parse(result.stdout);
		expect(
			report.checks.find((c: { check: string }) => c.check === "credentials"),
		).toMatchObject({ severity: "critical", recovery: "af auth login" });
		expect(
			report.checks.find((c: { check: string }) => c.check === "api"),
		).toMatchObject({
			severity: "warning",
			message: "not checked — no credentials",
		});
		expect(server.requests).toHaveLength(0);
	});
	test("doctor strict expired-with-refresh is a warning; without refresh is critical", async () => {
		await saveCredentials("old", "test", 1, "fake-refresh");
		let result = await session.run(["doctor", "--strict", "--json"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).checks[0]).toMatchObject({
			severity: "warning",
			recovery: "af auth refresh",
		});
		await saveCredentials("old", "test", 1);
		result = await session.run(["doctor", "--strict"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			"critical: credentials: token expired. Recovery: af auth login",
		);
	});
	test("doctor strict unreachable API is critical", async () => {
		// The isolated base is a closed port. The fake drop models its connection failure.
		server.schedule({ path: "/v5/user/settings", type: "drop" });
		const result = await session.run(["doctor", "--strict", "--json"]);
		expect(result.exitCode).toBe(1);
		expect(
			JSON.parse(result.stdout).checks.find(
				(c: { check: string }) => c.check === "api",
			),
		).toMatchObject({
			severity: "critical",
			recovery: "check network / AF_API_BASE",
		});
	});
	test("doctor default retains legacy JSON keys without severity additions", async () => {
		const result = await session.run(["doctor", "--json"]);
		expect(Object.keys(JSON.parse(result.stdout))).toEqual([
			"credentials",
			"browsers",
			"cache",
			"api",
		]);
		expect(result.exitCode).toBe(0);
	});
});
