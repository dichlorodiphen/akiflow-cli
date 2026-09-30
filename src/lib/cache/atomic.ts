import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let writeHook: ((path: string, temporaryPath: string) => void) | undefined;

/** Fault-injection seam; production callers leave this unset. */
export function setAtomicWriteHook(
	hook?: (path: string, temporaryPath: string) => void,
): void {
	writeHook = hook;
}

/**
 * Same-directory rename makes publication crash-atomic for readers. This does
 * not promise power-loss durability: neither the file nor directory is fsynced.
 */
export function atomicWrite(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(temporaryPath, contents, "utf8");
		writeHook?.(path, temporaryPath);
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}
