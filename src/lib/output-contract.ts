import { writeSync } from "node:fs";
import { EXIT_CODES } from "./exit-codes";

export const ENVELOPE_MIGRATION_WARNING =
	"JSON schema_version: 1 will become the default in a future release; opt in now with --envelope or AF_JSON_ENVELOPE=1.";
export interface JsonEnvelope {
	schema_version: 1;
	command: string;
	status: "ok" | "error" | "partial";
	result: unknown;
	errors: unknown[];
	warnings: string[];
	meta: Record<string, unknown>;
}
let outputCommand = "af";
const outputWarnings: string[] = [];
const outputMeta: Record<string, unknown> = {};
export function setOutputCommand(command: string): void {
	outputCommand = command;
}
export function addOutputWarning(warning: string): void {
	outputWarnings.push(warning);
}
export function addOutputMeta(meta: Record<string, unknown>): void {
	Object.assign(outputMeta, meta);
}

/** Retain legacy results as a whole unless they already use a result/errors wrapper. */
export function toEnvelope(
	command: string,
	payload: unknown,
	code: number,
	warnings: string[] = [],
	errors: string[] = [],
	meta: Record<string, unknown> = {},
): JsonEnvelope {
	const record =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: {};
	const wrapped = Object.hasOwn(record, "result");
	const itemErrors = Array.isArray(record.items)
		? record.items
				.filter(
					(item) =>
						item && typeof item === "object" && item.action === "failed",
				)
				.map((item) => ({
					id: item.id,
					message: item.reason ?? "Operation failed",
				}))
		: [];
	const payloadErrors = Array.isArray(record.errors)
		? record.errors
		: itemErrors;
	const payloadWarnings = Array.isArray(record.warnings)
		? record.warnings.map(String)
		: [];
	const legacyMeta = wrapped
		? Object.fromEntries(
				Object.entries(record).filter(
					([key]) => !["result", "errors", "warnings", "meta"].includes(key),
				),
			)
		: {};
	return {
		schema_version: 1,
		command,
		status:
			code === EXIT_CODES.partialSuccess ? "partial" : code ? "error" : "ok",
		result: wrapped ? record.result : payload,
		errors: [...payloadErrors, ...errors],
		warnings: [
			...new Set([ENVELOPE_MIGRATION_WARNING, ...warnings, ...payloadWarnings]),
		],
		meta: {
			...legacyMeta,
			...(record.meta && typeof record.meta === "object" ? record.meta : {}),
			...meta,
			exit_code: code,
		},
	};
}

/** Upgrade only unmistakable existing errors; unrelated legacy failures retain code 1. */
export function classifyExit(
	code: number,
	errors: string[],
	payloads: unknown[],
): number {
	if (code !== 1) return code;
	const reports = payloads.filter(
		(value): value is Record<string, unknown> =>
			!!value && typeof value === "object" && !Array.isArray(value),
	);
	if (reports.some((r) => Number(r.failed) > 0 && Number(r.changed) > 0))
		return EXIT_CODES.partialSuccess;
	const message = errors.join("\n");
	if (
		/authentication|no credentials|AuthError|token (?:has )?expired|unauthorized/i.test(
			message,
		)
	)
		return EXIT_CODES.auth;
	if (
		/not found|status 404|HTTP 404|no task (?:matches|matching)|unknown (?:task|event|slot) (?:id|identifier)|could not find/i.test(
			message,
		)
	)
		return EXIT_CODES.notFound;
	if (
		/Invalid --\w+ selector|UsageError|SelectorError|Unknown command|Unknown (?:flag|option)|Unexpected positional/i.test(
			message,
		)
	)
		return EXIT_CODES.validation;
	if (
		/API error|API request failed|Failed to connect to Akiflow API|Failed to parse API response|HTTP [45]\d\d|NetworkError|fetch failed|Failed to fetch/i.test(
			message,
		)
	)
		return EXIT_CODES.upstream;
	return code;
}

export function outputMode(
	argv: string[],
	envEnvelope = process.env.AF_JSON_ENVELOPE,
): { enabled: boolean; requestedJson: boolean } {
	let enabled = envEnvelope === "1";
	let requestedJson = false;
	for (const token of argv) {
		if (token === "--") break;
		if (token === "--envelope" || token === "--envelope=true") enabled = true;
		if (token === "--no-envelope" || token === "--envelope=false")
			enabled = false;
		if (/^--(?:json|raw)(?:=true)?$/.test(token)) requestedJson = true;
	}
	return { enabled, requestedJson };
}

/** Install once at the executable boundary so direct command helpers retain their legacy API. */
export function installOutputContract(argv: string[], command = "af"): void {
	setOutputCommand(command);
	const { enabled, requestedJson } = outputMode(argv);
	const originalWrite = process.stdout.write.bind(process.stdout);
	const originalError = console.error.bind(console);
	const originalLog = console.log.bind(console);
	const originalWarn = console.warn.bind(console);
	const originalExit = process.exit.bind(process);
	const payloads: unknown[] = [];
	const errors: string[] = [];
	let flushed = false;
	let announced = false;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
		originalError(...args);
	};
	console.warn = (...args: unknown[]) => {
		addOutputWarning(args.map(String).join(" "));
		originalWarn(...args);
	};
	process.stdout.write = ((
		chunk: unknown,
		encodingOrCallback?: unknown,
		callback?: unknown,
	) => {
		const text =
			typeof chunk === "string"
				? chunk
				: Buffer.isBuffer(chunk)
					? chunk.toString()
					: "";
		let parsed: unknown;
		let json = false;
		if (/^\s*[[{]/.test(text)) {
			try {
				parsed = JSON.parse(text);
				json = true;
			} catch {
				/* ordinary text */
			}
		}
		if (!json)
			return (originalWrite as (...args: unknown[]) => boolean)(
				chunk,
				encodingOrCallback,
				callback,
			);
		payloads.push(parsed);
		if (!enabled) {
			if (!announced) {
				originalError(ENVELOPE_MIGRATION_WARNING);
				announced = true;
			}
			return (originalWrite as (...args: unknown[]) => boolean)(
				chunk,
				encodingOrCallback,
				callback,
			);
		}
		const cb =
			typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (typeof cb === "function") queueMicrotask(() => cb());
		return true;
	}) as typeof process.stdout.write;
	console.log = (...args: unknown[]) => {
		if (
			args.length === 1 &&
			typeof args[0] === "string" &&
			/^\s*[[{]/.test(args[0])
		) {
			try {
				JSON.parse(args[0]);
				process.stdout.write(`${args[0]}\n`);
				return;
			} catch {
				/* ordinary text */
			}
		}
		originalLog(...args);
	};
	function finish(code: number): number {
		const mapped = classifyExit(code, errors, payloads);
		if (flushed) return mapped;
		flushed = true;
		if (enabled && (payloads.length || requestedJson || mapped)) {
			const payload = payloads.length <= 1 ? (payloads[0] ?? null) : payloads;
			// Use a synchronous write: process.exit must not truncate the JSON contract.
			const envelope = toEnvelope(
				outputCommand,
				payload,
				mapped,
				outputWarnings,
				mapped ? errors : [],
				outputMeta,
			);
			const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
			writeSync(1, bytes);
		}
		return mapped;
	}
	process.exit = ((code?: number | string | null) =>
		originalExit(
			finish(Number(code ?? process.exitCode ?? 0)),
		)) as typeof process.exit;
	process.on("beforeExit", (code) => {
		process.exitCode = finish(code);
	});
}
