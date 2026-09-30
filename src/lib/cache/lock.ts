import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

const STALE_AFTER_MS = 60_000;
const HEARTBEAT_MS = 10_000;
/** Bound on waiting for a live owner; wedged holders must not hang callers forever. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5 * 60 * 1000;

/** Internal override for tests; production default is five minutes. */
function acquireTimeoutMs(): number {
	const raw = process.env.AF_LOCK_TIMEOUT_MS;
	const parsed = raw == null || raw === "" ? NaN : Number(raw);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_ACQUIRE_TIMEOUT_MS;
}

// Bun's compiled release targets are Linux and Darwin. A persistent sibling
// guard uses kernel flock so owner death releases it without userspace stale
// deletion races. Never unlink this guard: all contenders must share its inode.
function loadNative() {
	return dlopen(
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
		{
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		},
	);
}
let native: ReturnType<typeof loadNative> | undefined;

async function guarded<T>(lockPath: string, fn: () => T): Promise<T> {
	native ??= loadNative();
	const fd = openSync(`${lockPath}.reclaim`, "a", 0o600);
	try {
		// LOCK_EX | LOCK_NB; waiting must not block the Bun event loop.
		while (native.symbols.flock(fd, 2 | 4) !== 0) await Bun.sleep(10);
		return fn();
	} finally {
		// close releases the kernel lock, including when the process is killed.
		closeSync(fd);
	}
}

interface Owner {
	pid: number;
	nonce: string;
	timestamp: number;
}

interface HeldLock {
	fd: number;
	owner: Owner;
}

/**
 * Hold an exclusive, process-owned lock. Live owners are never evicted for age;
 * dead owners are reclaimed immediately. Callers wait until the owner releases.
 * Keep lockPath outside any directory the critical section replaces.
 */
export async function withLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	mkdirSync(dirname(lockPath), { recursive: true });
	const held = await acquire(lockPath);
	const heartbeat = setInterval(() => {
		// Write through the acquired descriptor: a replaced pathname must never
		// let this holder overwrite a new owner's identity.
		held.owner.timestamp = Date.now();
		const contents = JSON.stringify(held.owner);
		writeSync(held.fd, contents, 0, "utf8");
		ftruncateSync(held.fd, Buffer.byteLength(contents));
	}, HEARTBEAT_MS);
	heartbeat.unref();
	try {
		return await fn();
	} finally {
		clearInterval(heartbeat);
		await guarded(lockPath, () => release(lockPath, held));
	}
}

function release(lockPath: string, held: HeldLock): void {
	try {
		const owner = readOwner(lockPath);
		const heldStat = fstatSync(held.fd);
		const pathStat = statSync(lockPath);
		if (
			owner?.nonce === held.owner.nonce &&
			pathStat.ino === heldStat.ino &&
			pathStat.dev === heldStat.dev
		) {
			unlinkSync(lockPath);
		}
	} catch (err) {
		if (!isCode(err, "ENOENT")) throw err;
	} finally {
		closeSync(held.fd);
	}
}

async function acquire(lockPath: string): Promise<HeldLock> {
	const timeoutMs = acquireTimeoutMs();
	const deadline = Date.now() + timeoutMs;
	let holderPid: number | undefined;
	for (;;) {
		const acquired = await guarded(lockPath, () => {
			try {
				const fd = openSync(lockPath, "wx", 0o600);
				const owner = {
					pid: process.pid,
					nonce: randomUUID(),
					timestamp: Date.now(),
				};
				try {
					writeSync(fd, JSON.stringify(owner), 0, "utf8");
				} catch (err) {
					closeSync(fd);
					throw err;
				}
				return { fd, owner };
			} catch (err) {
				if (!isCode(err, "EEXIST")) throw err;
				try {
					const contents = readFileSync(lockPath, "utf8");
					const owner = parseOwner(contents);
					if (owner) holderPid = owner.pid;
					const stale = owner
						? !isAlive(owner.pid)
						: Date.now() - statSync(lockPath).mtimeMs > STALE_AFTER_MS;
					if (stale && readFileSync(lockPath, "utf8") === contents)
						unlinkSync(lockPath);
				} catch (err) {
					if (!isCode(err, "ENOENT")) throw err;
				}
				return undefined;
			}
		});
		if (acquired) return acquired;
		if (Date.now() >= deadline) {
			throw new Error(
				`could not acquire ${lockPath} within ${timeoutMs}ms` +
					(holderPid ? ` (held by pid ${holderPid})` : ""),
			);
		}
		await new Promise((resolve) =>
			setTimeout(resolve, 50 + Math.random() * 50),
		);
	}
}

function readOwner(path: string): Owner | undefined {
	return parseOwner(readFileSync(path, "utf8"));
}

function parseOwner(contents: string): Owner | undefined {
	try {
		const owner = JSON.parse(contents) as Owner;
		if (
			Number.isInteger(owner.pid) &&
			owner.pid > 0 &&
			typeof owner.nonce === "string" &&
			Number.isFinite(owner.timestamp)
		) {
			return owner;
		}
	} catch {
		// Adopt old pid/timestamp lock files as well, without stealing live ones.
		const [pid, timestamp] = contents.split("\n").map(Number);
		if (pid && Number.isInteger(pid) && pid > 0 && timestamp) {
			return { pid, nonce: "legacy", timestamp };
		}
	}
	return undefined;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to another user. Only
		// ESRCH proves death; uncertainty must not permit stealing a lock.
		return !isCode(err, "ESRCH");
	}
}

function isCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: string }).code === code
	);
}
