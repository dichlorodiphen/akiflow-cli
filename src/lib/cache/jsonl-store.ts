import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic";

/** Read synchronously so a pinned generation is consumed before yielding. */
export function readAllRecordsSync<T>(filePath: string): T[] {
	if (!existsSync(filePath)) return [];
	const text = readFileSync(filePath, "utf8");
	const records: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch {
			console.warn(`[jsonl-store] skipping malformed line in ${filePath}`);
		}
	}
	return records;
}

/** Read records; legacy malformed lines are skipped with a warning. */
export async function readAllRecords<T>(filePath: string): Promise<T[]> {
	return readAllRecordsSync<T>(filePath);
}

/** Append via an atomic replacement; no reader sees a partial appended line. */
export async function appendRecords<T>(
	filePath: string,
	records: T[],
): Promise<void> {
	if (records.length === 0) return;
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
	const separator = existing && !existing.endsWith("\n") ? "\n" : "";
	atomicWrite(
		filePath,
		`${existing}${separator}${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

/** Upsert by key with one crash-atomic replacement of the file. */
export async function upsertRecords<T>(
	filePath: string,
	newRecords: T[],
	keyOf: (r: T) => string,
): Promise<void> {
	const existing = readAllRecordsSync<T>(filePath);
	const newKeys = new Set(newRecords.map(keyOf));
	const kept = existing.filter((r) => !newKeys.has(keyOf(r)));
	await rewriteRecords(filePath, [...kept, ...newRecords]);
}

/** Replace contents atomically against readers (without fsync durability). */
export async function rewriteRecords<T>(
	filePath: string,
	records: T[],
): Promise<void> {
	atomicWrite(
		filePath,
		records.length
			? `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
			: "",
	);
}
