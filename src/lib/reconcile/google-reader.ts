import { accessSync, constants } from "node:fs";
import type { ReconcileRecord, ReconcileWindow, Sources } from "./types";
import { ReconcileError } from "./types";

export interface GoogleTime {
	dateTime?: string;
	date?: string;
	timeZone?: string;
}
export interface GoogleEvent {
	id: string;
	status?: string;
	summary?: string;
	start?: GoogleTime;
	end?: GoogleTime;
	originalStartTime?: GoogleTime;
	recurringEventId?: string;
	recurrence?: string[];
	eventType?: string;
	attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}
export interface GoogleObservation {
	calendar_id: string;
	timezone: string | null;
	events: GoogleEvent[];
	metadata: Sources["google"][number];
	not_found_ids: string[];
}

export function resolveGoogleExecutable(
	override?: string,
	env = process.env,
): string {
	const name = override ?? env.HATCH_GWS_CLI ?? "hatch_gws_cli";
	const executable = Bun.which(name, { PATH: env.PATH });
	try {
		if (!executable) throw new Error("missing");
		accessSync(executable, constants.X_OK);
		return executable;
	} catch {
		throw new ReconcileError(
			`Google reader '${name}' was not found or is not executable.\nInstall the helper used by the schedule watcher, or select a compatible\nexecutable with --google-cmd /path/to/helper or HATCH_GWS_CLI.`,
			2,
			"helper_missing",
		);
	}
}

/** Fixed whitelist. Each executable/path/JSON payload is exactly one argv entry. */
export function googleArgv(
	executable: string,
	verb: "list" | "get",
	params: Record<string, unknown>,
): string[] {
	if (verb !== "list" && verb !== "get")
		throw new ReconcileError("Google reader permits only list/get");
	const allowed =
		verb === "list"
			? [
					"calendarId",
					"timeMin",
					"timeMax",
					"singleEvents",
					"showDeleted",
					"orderBy",
					"maxResults",
					"pageToken",
				]
			: ["calendarId", "eventId"];
	if (Object.keys(params).some((key) => !allowed.includes(key)))
		throw new ReconcileError("Unsupported Google read parameter");
	return [
		executable,
		"calendar",
		"events",
		verb,
		"--params",
		JSON.stringify(params),
	];
}

export function googleError(
	value: unknown,
): { status: number | null; message: string } | null {
	if (!value || typeof value !== "object" || !("error" in value)) return null;
	const error = (value as { error: unknown }).error;
	if (!error) return null;
	if (typeof error !== "object")
		return { status: null, message: String(error) };
	const detail = error as { code?: unknown; message?: unknown };
	return {
		status: typeof detail.code === "number" ? detail.code : null,
		message:
			typeof detail.message === "string"
				? detail.message
				: "Google structured error",
	};
}

export async function invokeGoogle(
	executable: string,
	verb: "list" | "get",
	params: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<unknown> {
	let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		process = Bun.spawn(googleArgv(executable, verb, params), {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		const unavailable =
			code === "ENOENT" || code === "EACCES" || code === "ENOEXEC";
		throw new ReconcileError(
			`Google reader could not start: ${error instanceof Error ? error.message : error}`,
			unavailable ? 2 : 5,
			unavailable ? "helper_unexecutable" : "google_process",
		);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			process.kill("SIGKILL");
			reject(
				new ReconcileError(
					`Google reader timed out after ${timeoutMs}ms`,
					5,
					"google_timeout",
				),
			);
		}, timeoutMs);
	});
	try {
		// Drain both streams while waiting; a verbose failure must not deadlock.
		// Race the entire capture as a wrapper's descendants may retain pipe FDs.
		const [stdout, stderr, exit] = await Promise.race([
			Promise.all([
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
				process.exited,
			]),
			timeout,
		]);
		let value: unknown;
		try {
			value = JSON.parse(stdout);
		} catch {
			throw new ReconcileError(
				`Google reader returned invalid API JSON (exit ${exit})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
				5,
				"google_parse",
			);
		}
		const failure = googleError(value);
		if (failure) {
			if (verb === "get" && (failure.status === 404 || failure.status === 410))
				return value;
			throw new ReconcileError(
				`Google reader: ${failure.message}${stderr.trim() ? `; ${stderr.trim()}` : ""}`,
				failure.status === 401 ? 3 : 5,
				"google_failure",
			);
		}
		if (exit !== 0)
			throw new ReconcileError(
				`Google reader failed (exit ${exit})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
				5,
				"google_process",
			);
		return value;
	} finally {
		clearTimeout(timer);
	}
}

export function validateGooglePage(value: unknown): {
	events: GoogleEvent[];
	next: string | null;
	timezone: string | null;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ReconcileError("Malformed Google collection");
	const page = value as Record<string, unknown>;
	// Native Calendar API collection envelope, not flattened helper output.
	if (
		page.kind !== "calendar#events" ||
		!Array.isArray(page.items) ||
		(page.nextPageToken !== undefined &&
			(typeof page.nextPageToken !== "string" || !page.nextPageToken))
	)
		throw new ReconcileError(
			"Incomplete Google collection: expected calendar#events with items and pagination metadata",
		);
	for (const event of page.items) {
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			typeof event.id !== "string" ||
			!event.id
		)
			throw new ReconcileError("Malformed Google event identity");
	}
	return {
		events: page.items as GoogleEvent[],
		next: typeof page.nextPageToken === "string" ? page.nextPageToken : null,
		timezone: typeof page.timeZone === "string" ? page.timeZone : null,
	};
}

export async function readGoogleCalendar(
	executable: string,
	window: ReconcileWindow,
	metadata: Sources["google"][number],
): Promise<GoogleObservation> {
	const events = new Map<string, GoogleEvent>();
	const seen = new Set<string>();
	let pageToken: string | undefined;
	let timezone: string | null = null;
	try {
		for (let page = 0; page < 1000; page++) {
			const value = await invokeGoogle(executable, "list", {
				calendarId: metadata.calendar_id,
				timeMin: window.start,
				timeMax: window.end,
				singleEvents: true,
				showDeleted: true,
				orderBy: "startTime",
				maxResults: 2500,
				...(pageToken ? { pageToken } : {}),
			});
			metadata.pages++;
			const validated = validateGooglePage(value);
			timezone = validated.timezone ?? timezone;
			for (const event of validated.events) {
				if (events.get(event.id)?.status !== "cancelled")
					events.set(event.id, event);
			}
			if (!validated.next) {
				metadata.complete = true;
				return {
					calendar_id: metadata.calendar_id,
					timezone,
					events: [...events.values()],
					metadata,
					not_found_ids: [],
				};
			}
			if (seen.has(validated.next))
				throw new ReconcileError("Repeated Google page token");
			seen.add(validated.next);
			pageToken = validated.next;
		}
		throw new ReconcileError(
			"Google pagination exceeded the 1000-page safety limit",
		);
	} catch (error) {
		metadata.complete = false;
		metadata.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		metadata.read_end = new Date().toISOString();
	}
}

/** Only IDs actually observed on Akiflow; never manufacture occurrence IDs. */
export async function probeGoogleIdentities(
	executable: string,
	records: ReconcileRecord[],
	observations: GoogleObservation[],
	linkedRefs: Set<string>,
): Promise<void> {
	for (const source of observations) {
		const ids = new Set(
			records
				.filter(
					(record) =>
						record.calendar.key === source.calendar_id &&
						record.state === "active" &&
						record.in_window &&
						!linkedRefs.has(record.ref),
				)
				.map((record) => record.identity.origin_id)
				.filter((id): id is string => !!id),
		);
		try {
			for (const id of ids) {
				if (source.events.some((event) => event.id === id)) continue;
				source.metadata.identity_probes++;
				const value = await invokeGoogle(executable, "get", {
					calendarId: source.calendar_id,
					eventId: id,
				});
				if (googleError(value)) {
					source.not_found_ids.push(id);
					continue;
				}
				if (
					!value ||
					typeof value !== "object" ||
					Array.isArray(value) ||
					!("id" in value) ||
					value.id !== id
				)
					throw new ReconcileError("Malformed Google identity response");
				source.events.push(value as GoogleEvent);
			}
		} catch (error) {
			source.metadata.complete = false;
			source.metadata.error =
				error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			source.metadata.read_end = new Date().toISOString();
		}
	}
}
