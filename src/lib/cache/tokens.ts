import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheLockPath, cachePath } from "../platform-config";
import { atomicWrite } from "./atomic";
import {
	ensureGeneration,
	pinGeneration,
	publishGeneration,
	stageGeneration,
} from "./generation";
import { withLock } from "./lock";

export interface Tokens {
	/** Explicit task tombstone confirmations, published with the observation generation. */
	deleted_tasks?: Record<string, string>;
	tasks?: string;
	events?: string;
	time_slots?: string;
	labels?: string;
	tags?: string;
	calendars?: string;
	accounts?: string;
	contacts?: string;
	last_full_sync_at?: string;
	/** Last successful server sync for each resource, independent of other ages. */
	last_success_at?: Partial<Record<string, string>>;
	user_id?: number;
}

export async function readTokens(directory?: string): Promise<Tokens> {
	const path = join(directory ?? pinGeneration() ?? cachePath(), "tokens.json");
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as Tokens;
}

/** Pass a staging directory to commit tokens together with resource files. */
export async function writeTokens(
	tokens: Tokens,
	directory?: string,
): Promise<void> {
	if (directory) {
		atomicWrite(
			join(directory, "tokens.json"),
			JSON.stringify(tokens, null, 2),
		);
		return;
	}
	await withLock(cacheLockPath(), async () => {
		if (!pinGeneration()) {
			atomicWrite(
				join(cachePath(), "tokens.json"),
				JSON.stringify(tokens, null, 2),
			);
			return;
		}
		const stage = stageGeneration(await ensureGeneration());
		atomicWrite(join(stage, "tokens.json"), JSON.stringify(tokens, null, 2));
		publishGeneration(stage);
	});
}
