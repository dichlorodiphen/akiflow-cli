import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";

let directory: string;
let env: Record<string, string>;
let server: Server<undefined>;
let labels: Record<string, unknown>[];
let messages: Record<string, unknown>[];
let writes: string[];
let chatQueries: number;
let linkedSlot: string | undefined;
const chatToken = `header.${Buffer.from(JSON.stringify({ user_id: "123", exp: 9999999999 })).toString("base64url")}.signature`;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "af-project-aki-cli-"));
	labels = [];
	messages = [];
	writes = [];
	chatQueries = 0;
	linkedSlot = undefined;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/v5/labels") {
				if (request.method === "PATCH") {
					writes.push(path);
					const payloads = (await request.json()) as Record<string, unknown>[];
					for (const payload of payloads) {
						const previous = labels.find((row) => row.id === payload.id);
						if (previous) Object.assign(previous, payload);
						else labels.push({ user_id: 123, ...payload });
					}
					return Response.json({ success: true, message: "", data: payloads });
				}
				return Response.json({
					success: true,
					message: "",
					data: labels,
					has_next_page: false,
				});
			}
			if (path === "/v5/tasks")
				return Response.json({
					success: true,
					message: "",
					data: [],
					has_next_page: false,
				});
			if (path === "/v5/time_slots")
				return Response.json({
					success: true,
					message: "",
					data: linkedSlot ? [{ id: "slot", label_id: linkedSlot }] : [],
					has_next_page: false,
				});
			if (path === "/chat/token") return Response.json({ token: chatToken });
			if (path.endsWith("/query")) {
				chatQueries++;
				const id = path.split("/")[3];
				return Response.json({
					channel: { id },
					members: [{ user_id: "123" }, { user_id: "aki" }],
					messages,
				});
			}
			if (path.endsWith("/message")) {
				writes.push(path);
				const body = (await request.json()) as {
					message: Record<string, unknown>;
				};
				const sent = { ...body.message, user: { id: "123" } };
				messages.push(sent, {
					id: "reply",
					user: { id: "aki" },
					text: "Fixture response",
				});
				return Response.json({ message: sent });
			}
			return new Response("unexpected", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	env = {
		...process.env,
		AF_PROFILE: "default",
		AF_CONFIG_DIR: join(directory, "config"),
		AF_CACHE_DIR: join(directory, "cache"),
		AF_API_BASE: base,
		AF_AKI_BASE: base,
		AF_AKI_STREAM_BASE: base,
		AF_REFRESH_URL: `${base}/oauth/refreshToken`,
		AF_NO_AUTO_SYNC: "1",
	} as Record<string, string>;
	mkdirSync(env.AF_CONFIG_DIR as string, { recursive: true });
	writeFileSync(
		join(env.AF_CONFIG_DIR as string, "credentials.json"),
		JSON.stringify({
			token: "fake-access",
			clientId: "fake-client",
			expiryTimestamp: Date.now() + 3600000,
		}),
	);
});
afterEach(() => {
	server.stop(true);
	rmSync(directory, { recursive: true, force: true });
});
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
test("project create/update/delete use fresh verification and preserve tasks", async () => {
	const created = await cli(
		"project",
		"create",
		"Fixture project",
		"--verify",
		"--json",
	);
	expect(created.code).toBe(0);
	const result = JSON.parse(created.stdout);
	expect(result.status).toBe("verified");
	const id = result.result.id;
	const updated = await cli(
		"project",
		"update",
		id,
		"--title",
		"Renamed fixture",
		"--icon",
		"🌙",
		"--verify",
		"--json",
	);
	expect(updated.code).toBe(0);
	expect(JSON.parse(updated.stdout).status).toBe("verified");
	expect(labels[0]?.title).toBe("Renamed fixture");
	expect(labels[0]?.icon).toBe("🌙");
	const preview = await cli("project", "delete", id, "--dry-run", "--json");
	expect(JSON.parse(preview.stdout).effects.tasks_preserved).toBe(true);
	expect(writes).toHaveLength(2);
	linkedSlot = id;
	const guarded = await cli("project", "delete", id, "--yes", "--json");
	expect(guarded.code).not.toBe(0);
	expect(guarded.stderr).toContain("time slots");
	expect(writes).toHaveLength(2);
	linkedSlot = undefined;
	const deleted = await cli(
		"project",
		"delete",
		id,
		"--yes",
		"--verify",
		"--json",
	);
	expect(deleted.code).toBe(0);
	expect(JSON.parse(deleted.stdout).status).toBe("verified");
	expect(writes).toEqual(["/v5/labels", "/v5/labels", "/v5/labels"]);
});
test("Aki blocks implicit actions and --no-wait submits exactly once without polling", async () => {
	const blocked = await cli(
		"aki",
		"send",
		"Fixture prompt",
		"--conversation",
		"aki-123-test",
		"--json",
	);
	expect(blocked.code).not.toBe(0);
	expect(writes).toHaveLength(0);
	expect(chatQueries).toBe(0);
	const sent = await cli(
		"aki",
		"send",
		"Fixture prompt",
		"--conversation",
		"aki-123-test",
		"--allow-actions",
		"--no-wait",
		"--json",
	);
	expect(sent.code).toBe(0);
	expect(JSON.parse(sent.stdout).status).toBe("accepted");
	expect(writes).toHaveLength(1);
	expect(chatQueries).toBe(1);
});
test("Aki returns a posted reply and explicitly avoids claiming turn completion", async () => {
	const sent = await cli(
		"aki",
		"send",
		"Fixture prompt",
		"--conversation",
		"aki-123-test",
		"--allow-actions",
		"--timeout",
		"2",
		"--json",
	);
	expect(sent.code).toBe(0);
	const output = JSON.parse(sent.stdout);
	expect(output.status).toBe("reply_received");
	expect(output.result.replies[0].text).toBe("Fixture response");
	expect(output.warnings.join(" ")).toContain("turn-completion");
	expect(writes).toHaveLength(1);
});
