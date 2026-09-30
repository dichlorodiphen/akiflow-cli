import type { AkiflowClient } from "./api/client";
import type { Event, Task, TimeSlot } from "./api/types";

export interface VerificationOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	/** Return after one scan, allowing callers to manage pending polling. */
	singlePoll?: boolean;
	maxPages?: number;
}

export interface VerificationResult<T> {
	status: "verified" | "pending" | "mismatch" | "timeout";
	observed: T | null;
	differingFields: string[];
	error?: string;
}

export type ExpectedEventFields = Partial<
	Pick<
		Event,
		| "title"
		| "description"
		| "start_time"
		| "end_time"
		| "start_datetime_tz"
		| "end_datetime_tz"
	>
> & { location?: string | null };

export type ExpectedTaskFields = Partial<
	Pick<
		Task,
		| "title"
		| "description"
		| "date"
		| "datetime"
		| "datetime_tz"
		| "duration"
		| "done"
		| "status"
		| "calendar_id"
		| "time_slot_id"
	>
>;

type VerificationClient = Pick<AkiflowClient, "get">;

function equalField(
	field: string,
	actual: unknown,
	expected: unknown,
): boolean {
	if (
		["start_time", "end_time", "datetime"].includes(field) &&
		typeof actual === "string" &&
		typeof expected === "string"
	) {
		// Require explicit offsets: parsing local wall times depends on the host zone.
		const offset = /(?:Z|[+-]\d{2}:\d{2})$/i;
		return (
			offset.test(actual) &&
			offset.test(expected) &&
			Number.isFinite(Date.parse(actual)) &&
			Date.parse(actual) === Date.parse(expected)
		);
	}
	if (
		actual !== null &&
		expected !== null &&
		typeof actual === "object" &&
		typeof expected === "object"
	) {
		if (Array.isArray(actual) !== Array.isArray(expected)) return false;
		const left = Object.entries(actual);
		const right = Object.entries(expected);
		return (
			left.length === right.length &&
			left.every(
				([key, value]) =>
					Object.hasOwn(expected, key) &&
					equalField(key, value, (expected as Record<string, unknown>)[key]),
			)
		);
	}
	return actual === expected;
}

async function verifyFields<T extends { id: string }>(
	client: VerificationClient,
	path: string,
	id: string,
	expected: Record<string, unknown>,
	opts: VerificationOptions,
	deletion = false,
): Promise<VerificationResult<T>> {
	const timeoutMs = opts.timeoutMs ?? 15000;
	const pollIntervalMs = opts.pollIntervalMs ?? 1500;
	const maxPages = opts.maxPages ?? 100;
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs < 0 ||
		!Number.isFinite(pollIntervalMs) ||
		pollIntervalMs <= 0 ||
		!Number.isInteger(maxPages) ||
		maxPages <= 0
	) {
		throw new RangeError("Invalid verification bounds");
	}
	const deadline = performance.now() + timeoutMs;
	let observed: T | null = null;
	let differingFields: string[] = [];
	let error: string | undefined;
	const result = (
		status: VerificationResult<T>["status"],
	): VerificationResult<T> => ({
		status,
		observed,
		differingFields,
		...(error ? { error } : {}),
	});
	while (performance.now() < deadline) {
		let cursor: string | undefined;
		const seen = new Set<string>();
		const records = new Map<string, T>();
		let complete = false;
		for (
			let page = 0;
			page < maxPages && performance.now() < deadline;
			page++
		) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				// Client GET goes directly to HTTP; never use the local cache or a
				// previous scan's sync token. Bound even a hung transport by the deadline.
				const response = await Promise.race([
					client.get<T[]>(path, { limit: 2500, sync_token: cursor }),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Verification deadline exceeded")),
							Math.max(0, deadline - performance.now()),
						);
					}),
				]);
				if (performance.now() >= deadline) return result("timeout");
				if (response.success !== true || !Array.isArray(response.data))
					throw new Error(response.message ?? "Invalid verification response");
				for (const record of response.data) records.set(record.id, record);
				if (response.has_next_page !== true) {
					complete = true;
					break;
				}
				if (!response.sync_token || seen.has(response.sync_token))
					throw new Error("Verification pagination did not advance");
				seen.add(response.sync_token);
				cursor = response.sync_token;
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
				break;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}
		if (complete) {
			error = undefined;
			observed = records.get(id) ?? null;
			differingFields = [];
			if (observed) {
				const record = observed as T & Record<string, unknown>;
				if (deletion) {
					if (record.deleted_at != null) return result("verified");
					differingFields = ["deleted_at"];
				} else
					for (const [field, value] of Object.entries(expected)) {
						const actual =
							field === "location"
								? ((record.content as Record<string, unknown> | null)
										?.location ?? null)
								: record[field];
						if (!equalField(field, actual, value)) differingFields.push(field);
					}
				if (!deletion && record.deleted_at != null)
					differingFields.push("deleted_at");
				if (differingFields.length === 0) return result("verified");
				// Only an explicit async marker makes an observed difference pending.
				// Mismatch describes this uncached observation, not provider causality.
				if (!deletion && record.status !== "pending") return result("mismatch");
			}
		} else if (!error) error = "Verification page limit exceeded";
		if (performance.now() >= deadline) return result("timeout");
		if (opts.singlePoll) return result("pending");
		await new Promise((resolve) =>
			setTimeout(
				resolve,
				Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())),
			),
		);
	}
	return result("timeout");
}

/** Fresh paginated Akiflow observation; does not prove Google/provider state. */
export function verifyEventFields(
	client: VerificationClient,
	eventId: string,
	expected: ExpectedEventFields,
	opts: VerificationOptions = {},
): Promise<VerificationResult<Event>> {
	return verifyFields<Event>(client, "/v5/events", eventId, expected, opts);
}

export function verifyTaskFields(
	client: VerificationClient,
	taskId: string,
	expected: ExpectedTaskFields,
	opts: VerificationOptions = {},
): Promise<VerificationResult<Task>> {
	return verifyFields<Task>(client, "/v5/tasks", taskId, expected, opts);
}

/** A fresh tombstone proves deletion; mere absence does not. */
export function verifyEventDeleted(
	client: VerificationClient,
	eventId: string,
	opts: VerificationOptions = {},
): Promise<VerificationResult<Event>> {
	return verifyFields<Event>(client, "/v5/events", eventId, {}, opts, true);
}

export function verifyTaskDeleted(
	client: VerificationClient,
	taskId: string,
	opts: VerificationOptions = {},
): Promise<VerificationResult<Task>> {
	return verifyFields<Task>(client, "/v5/tasks", taskId, {}, opts, true);
}

export function verifyTimeSlotFields(
	client: VerificationClient,
	slotId: string,
	expected: Partial<TimeSlot>,
	opts: VerificationOptions = {},
): Promise<VerificationResult<TimeSlot>> {
	return verifyFields<TimeSlot>(
		client,
		"/v5/time_slots",
		slotId,
		expected,
		opts,
	);
}
