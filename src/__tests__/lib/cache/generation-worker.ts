import { readFileSync, writeFileSync } from "node:fs";
import type { ApiResponse } from "../../../lib/api/types";
import { rebuild, refresh } from "../../../lib/cache";

const [operation, blockedResource, marker] = process.argv.slice(2);
if (!marker) throw new Error("Missing worker marker path");
let blockDuringWrite = false;
if (operation?.endsWith("-write")) {
	const modulePath = "../../../lib/cache/atomic";
	try {
		const { setAtomicWriteHook } = await import(modulePath);
		setAtomicWriteHook((path: string, temporaryPath: string) => {
			if (!path.endsWith("events.jsonl")) return;
			if (!readFileSync(temporaryPath, "utf8").includes("events-replacement"))
				return;
			writeFileSync(marker, "temporary-file-written");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		});
		blockDuringWrite = true;
	} catch {
		// Baseline regression verification still blocks at a page boundary.
	}
}
const client = {
	async get<T>(path: string): Promise<ApiResponse<T[]>> {
		const resource = path.slice("/v5/".length);
		if (!blockDuringWrite && resource === blockedResource) {
			writeFileSync(marker, "entered");
			await new Promise(() => {});
		}
		return {
			success: true,
			message: null,
			data: [{ id: `${resource}-replacement`, deleted_at: null }] as T[],
			sync_token: `replacement-${resource}`,
			has_next_page: false,
		};
	},
};
// Keep the fake server alive while a requested page is deliberately blocked.
const keepalive = setInterval(() => {}, 1000);
try {
	await (operation?.startsWith("refresh") ? refresh(client) : rebuild(client));
} finally {
	clearInterval(keepalive);
}
