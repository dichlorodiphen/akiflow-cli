import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../../../lib/cache/lock";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "af-lock-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("withLock", () => {
	test("runs the critical section + releases on success", async () => {
		const result = await withLock(join(dir, ".lock"), async () => 42);
		expect(result).toBe(42);
	});

	test("releases lock even if callback throws", async () => {
		await expect(
			withLock(join(dir, ".lock"), async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// Subsequent acquire should succeed
		const result = await withLock(join(dir, ".lock"), async () => "ok");
		expect(result).toBe("ok");
	});

	test("serializes concurrent calls", async () => {
		const order: number[] = [];
		const slow = (n: number) =>
			withLock(join(dir, ".lock"), async () => {
				order.push(n);
				await new Promise((r) => setTimeout(r, 30));
				order.push(-n);
			});
		await Promise.all([slow(1), slow(2)]);
		// Order is [a, -a, b, -b] for some a/b — never interleaved
		expect(order.length).toBe(4);
		expect(order[0]! + order[1]!).toBe(0);
		expect(order[2]! + order[3]!).toBe(0);
	});
});

describe("lock ownership and recovery", () => {
	test("identity-checked release preserves a replacement owner's lock", async () => {
		const path = join(dir, ".lock");
		const replacement = {
			pid: process.pid,
			nonce: "new-owner",
			timestamp: Date.now(),
		};
		await withLock(path, async () => {
			const original = JSON.parse(readFileSync(path, "utf8"));
			expect(original.pid).toBe(process.pid);
			expect(typeof original.nonce).toBe("string");
			unlinkSync(path);
			writeFileSync(path, JSON.stringify(replacement));
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
	});

	test("a live owner older than 60 seconds is never stolen", async () => {
		const path = join(dir, ".lock");
		let entered = false;
		let contender: Promise<void> | undefined;
		await withLock(path, async () => {
			const owner = JSON.parse(readFileSync(path, "utf8"));
			owner.timestamp = Date.now() - 120_000;
			writeFileSync(path, JSON.stringify(owner));
			contender = withLock(path, async () => {
				entered = true;
			});
			await Bun.sleep(200);
			expect(entered).toBe(false);
		});
		await contender;
		expect(entered).toBe(true);
	});

	test("dead process locks are reclaimed even with a recent heartbeat", async () => {
		const path = join(dir, ".lock");
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		await child.exited;
		writeFileSync(
			path,
			JSON.stringify({
				pid: child.pid,
				nonce: "dead-owner",
				timestamp: Date.now(),
			}),
		);
		expect(await withLock(path, async () => "recovered")).toBe("recovered");
		expect(existsSync(path)).toBe(false);
	});

	test("legacy live pid locks are not stolen by age", async () => {
		const path = join(dir, ".lock");
		writeFileSync(path, `${process.pid}\n${Date.now() - 120_000}\n`);
		let entered = false;
		const contender = withLock(path, async () => {
			entered = true;
		});
		await Bun.sleep(150);
		expect(entered).toBe(false);
		unlinkSync(path);
		await contender;
		expect(entered).toBe(true);
	});

	test("a second process waits for a live old owner", async () => {
		const path = join(dir, ".lock");
		const marker = join(dir, "entered");
		const modulePath = new URL("../../../lib/cache/lock.ts", import.meta.url)
			.pathname;
		let child: ReturnType<typeof Bun.spawn> | undefined;
		await withLock(path, async () => {
			const owner = JSON.parse(readFileSync(path, "utf8"));
			owner.timestamp = Date.now() - 120_000;
			writeFileSync(path, JSON.stringify(owner));
			child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { withLock } from ${JSON.stringify(modulePath)}; import { writeFileSync } from "node:fs"; await withLock(${JSON.stringify(path)}, async () => writeFileSync(${JSON.stringify(marker)}, "entered"));`,
				],
				{ stdout: "ignore", stderr: "pipe" },
			);
			await Bun.sleep(300);
			expect(existsSync(marker)).toBe(false);
		});
		if (!child) throw new Error("child not spawned");
		expect(await child.exited).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	test("SIGKILL holder is reclaimed by the waiting process", async () => {
		const path = join(dir, ".lock");
		const ready = join(dir, "ready");
		const modulePath = new URL("../../../lib/cache/lock.ts", import.meta.url)
			.pathname;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { withLock } from ${JSON.stringify(modulePath)}; import { writeFileSync } from "node:fs"; await withLock(${JSON.stringify(path)}, async () => { writeFileSync(${JSON.stringify(ready)}, "ready"); await Bun.sleep(60000); });`,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		try {
			for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++)
				await Bun.sleep(10);
			expect(existsSync(ready)).toBe(true);
			let entered = false;
			const waiting = withLock(path, async () => {
				entered = true;
			});
			await Bun.sleep(100);
			expect(entered).toBe(false);
			child.kill("SIGKILL");
			await child.exited;
			await waiting;
			expect(entered).toBe(true);
			expect(existsSync(path)).toBe(false);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("dead-lock reclamation contenders serialize across processes", async () => {
		const path = join(dir, ".lock");
		const sentinel = join(dir, "critical-section");
		const modulePath = new URL("../../../lib/cache/lock.ts", import.meta.url)
			.pathname;
		const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		await dead.exited;
		writeFileSync(
			path,
			JSON.stringify({ pid: dead.pid, nonce: "dead", timestamp: Date.now() }),
		);
		const children = Array.from({ length: 8 }, () =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { withLock } from ${JSON.stringify(modulePath)}; import { writeFileSync, unlinkSync } from "node:fs"; await withLock(${JSON.stringify(path)}, async () => { writeFileSync(${JSON.stringify(sentinel)}, "held", { flag: "wx" }); await Bun.sleep(30); unlinkSync(${JSON.stringify(sentinel)}); });`,
				],
				{ stdout: "ignore", stderr: "pipe" },
			),
		);
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				stderr: await new Response(child.stderr).text(),
			})),
		);
		for (const result of results) {
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
		}
		expect(existsSync(path)).toBe(false);
	});

	test("SIGKILL releases the kernel reclamation guard", async () => {
		const path = join(dir, ".lock");
		const ready = join(dir, "guard-ready");
		const library =
			process.platform === "darwin"
				? "/usr/lib/libSystem.B.dylib"
				: "libc.so.6";
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { dlopen, FFIType } from "bun:ffi"; import { openSync, writeFileSync } from "node:fs"; const native = dlopen(${JSON.stringify(library)}, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); const fd = openSync(${JSON.stringify(`${path}.reclaim`)}, "a"); if (native.symbols.flock(fd, 2) !== 0) throw new Error("flock failed"); writeFileSync(${JSON.stringify(ready)}, "ready"); await Bun.sleep(60000);`,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		try {
			for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++)
				await Bun.sleep(10);
			expect(existsSync(ready)).toBe(true);
			let entered = false;
			const waiting = withLock(path, async () => {
				entered = true;
			});
			await Bun.sleep(100);
			expect(entered).toBe(false);
			child.kill("SIGKILL");
			await child.exited;
			await waiting;
			expect(entered).toBe(true);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("holder heartbeats during a long critical section", async () => {
		const path = join(dir, ".lock");
		await withLock(path, async () => {
			const before = JSON.parse(readFileSync(path, "utf8"));
			await Bun.sleep(10_100);
			const after = JSON.parse(readFileSync(path, "utf8"));
			expect(after.nonce).toBe(before.nonce);
			expect(after.timestamp).toBeGreaterThan(before.timestamp);
		});
	}, 15_000);

	test("waiter gives up after the configured timeout instead of hanging", async () => {
		const path = join(dir, ".lock");
		const modulePath = new URL("../../../lib/cache/lock.ts", import.meta.url)
			.pathname;
		process.env.AF_LOCK_TIMEOUT_MS = "400";
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { withLock } from ${JSON.stringify(modulePath)}; await withLock(${JSON.stringify(path)}, async () => { await Bun.sleep(60000); });`,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		try {
			for (let i = 0; i < 100 && !existsSync(path); i++)
				await Bun.sleep(10);
			expect(existsSync(path)).toBe(true);
			const start = Date.now();
			await expect(withLock(path, async () => {})).rejects.toThrow(
				"could not acquire",
			);
			expect(Date.now() - start).toBeLessThan(30_000);
		} finally {
			delete process.env.AF_LOCK_TIMEOUT_MS;
			child.kill("SIGKILL");
			await child.exited;
		}
	});
});
