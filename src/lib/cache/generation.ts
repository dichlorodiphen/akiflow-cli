import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { cachePath } from "../platform-config";
import { atomicWrite } from "./atomic";

export const RESOURCES = [
	"tasks",
	"events",
	"time_slots",
	"labels",
	"tags",
	"calendars",
	"accounts",
	"contacts",
] as const;
export type Resource = (typeof RESOURCES)[number];

interface FileMetadata {
	count: number;
	sha256: string;
}
export interface GenerationManifest {
	generation: string;
	created_at: string;
	resources: Record<Resource, FileMetadata>;
	tokens: { sha256: string };
}

let beforePublishHook: ((directory: string) => void) | undefined;
/** Fault-injection seam, invoked after manifest creation, before validation. */
export function setBeforePublishHook(hook?: (directory: string) => void): void {
	beforePublishHook = hook;
}

/** Read the pointer exactly once; callers pin this path for their entire read. */
export function pinGeneration(): string | undefined {
	const pointer = join(cachePath(), "current");
	if (!existsSync(pointer)) return undefined;
	const name = readFileSync(pointer, "utf8").trim();
	if (!/^gen-\d+$/.test(name))
		throw new Error("Invalid cache generation pointer");
	return join(cachePath(), name);
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function resourceMetadata(directory: string, resource: Resource): FileMetadata {
	const text = readFileSync(join(directory, `${resource}.jsonl`), "utf8");
	let count = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const record: unknown = JSON.parse(line);
		if (
			record === null ||
			typeof record !== "object" ||
			Array.isArray(record)
		) {
			throw new Error(`Invalid ${resource} cache record`);
		}
		count++;
	}
	return { count, sha256: digest(text) };
}

function tokensMetadata(directory: string): { sha256: string } {
	const text = readFileSync(join(directory, "tokens.json"), "utf8");
	const tokens: unknown = JSON.parse(text);
	if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
		throw new Error("Invalid cache tokens");
	}
	return { sha256: digest(text) };
}

function writeManifest(directory: string, generation: string): void {
	const resources = {} as Record<Resource, FileMetadata>;
	for (const resource of RESOURCES) {
		resources[resource] = resourceMetadata(directory, resource);
	}
	const manifest: GenerationManifest = {
		generation,
		created_at: new Date().toISOString(),
		resources,
		tokens: tokensMetadata(directory),
	};
	atomicWrite(
		join(directory, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);
}

/** Strictly validate every required resource, the tokens and their manifest. */
export function validateGeneration(directory: string): void {
	const manifest = JSON.parse(
		readFileSync(join(directory, "manifest.json"), "utf8"),
	) as GenerationManifest;
	if (
		!/^gen-\d+$/.test(manifest.generation) ||
		!Number.isFinite(Date.parse(manifest.created_at))
	) {
		throw new Error("Invalid cache manifest");
	}
	const directoryName = basename(directory);
	if (
		/^gen-\d+$/.test(directoryName) &&
		manifest.generation !== directoryName
	) {
		throw new Error("Cache manifest generation mismatch");
	}
	for (const resource of RESOURCES) {
		const actual = resourceMetadata(directory, resource);
		const expected = manifest.resources?.[resource];
		if (
			!expected ||
			actual.count !== expected.count ||
			actual.sha256 !== expected.sha256
		) {
			throw new Error(`Cache manifest mismatch for ${resource}`);
		}
	}
	if (tokensMetadata(directory).sha256 !== manifest.tokens?.sha256) {
		throw new Error("Cache manifest mismatch for tokens");
	}
}

/** Create an unpublished complete snapshot. Caller must hold the cache lock. */
export function stageGeneration(base?: string): string {
	const directory = join(
		cachePath(),
		`.staging-${process.pid}-${randomUUID()}`,
	);
	mkdirSync(directory, { recursive: true });
	try {
		for (const resource of RESOURCES) {
			const source = base && join(base, `${resource}.jsonl`);
			atomicWrite(
				join(directory, `${resource}.jsonl`),
				source && existsSync(source) ? readFileSync(source, "utf8") : "",
			);
		}
		const sourceTokens = base && join(base, "tokens.json");
		atomicWrite(
			join(directory, "tokens.json"),
			sourceTokens && existsSync(sourceTokens)
				? readFileSync(sourceTokens, "utf8")
				: "{}",
		);
		return directory;
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

function nextGenerationName(): string {
	let highest = -1;
	for (const name of readdirSync(cachePath())) {
		if (/^gen-\d+$/.test(name))
			highest = Math.max(highest, Number(name.slice(4)));
	}
	return `gen-${highest + 1}`;
}

/** Build, validate, then publish resources and tokens in one pointer rename. */
export function publishGeneration(stage: string): string {
	const name = nextGenerationName();
	writeManifest(stage, name);
	beforePublishHook?.(stage);
	validateGeneration(stage);
	const destination = join(cachePath(), name);
	renameSync(stage, destination);
	atomicWrite(join(cachePath(), "current"), `${name}\n`);
	try {
		collectOldGenerations(name);
	} catch {
		// A cleanup failure must never turn a committed generation into a failure.
	}
	return destination;
}

function collectOldGenerations(current: string): void {
	const old = readdirSync(cachePath())
		.filter((name) => /^gen-\d+$/.test(name) && name !== current)
		.sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
	for (const name of old.slice(2)) {
		const directory = join(cachePath(), name);
		// Leave recent generations to readers in other processes. Readers also
		// retry a reclaimed pin; synchronous snapshots never mix generations.
		if (Date.now() - statSync(directory).mtimeMs < 5 * 60 * 1000) continue;
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Publication already succeeded; forensic cleanup is best effort.
		}
	}
}

/**
 * Adopt a flat cache without discarding tokens or non-resource state. Copy first
 * so a crash before pointer publication leaves all legacy files recoverable.
 * The external cache lock must be held by the caller.
 */
export async function ensureGeneration(): Promise<string> {
	mkdirSync(cachePath(), { recursive: true });
	// The caller owns the lock, so unfinished stages cannot belong to a live writer.
	for (const name of readdirSync(cachePath())) {
		if (name.startsWith(".staging-") || name.startsWith("current.tmp-")) {
			rmSync(join(cachePath(), name), { recursive: true, force: true });
		}
	}
	const current = pinGeneration();
	if (current) return current;
	const stage = stageGeneration(cachePath());
	const destination = publishGeneration(stage);
	for (const resource of RESOURCES)
		rmSync(join(cachePath(), `${resource}.jsonl`), { force: true });
	rmSync(join(cachePath(), "tokens.json"), { force: true });
	return destination;
}
