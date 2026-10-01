import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import { AuthError } from "../lib/api/types";
import { readFreshAkiflow } from "../lib/reconcile/akiflow-reader";
import { captureCacheSnapshot } from "../lib/reconcile/cache-snapshot";
import { buildReconcileReport } from "../lib/reconcile/diff";
import { formatReconcileReport, reportWarnings } from "../lib/reconcile/format";
import {
	type GoogleObservation,
	probeGoogleIdentities,
	readGoogleCalendar,
	resolveGoogleExecutable,
} from "../lib/reconcile/google-reader";
import { matchRecords } from "../lib/reconcile/match";
import {
	alignCalendarTimezones,
	normalizeAkiflow,
	normalizeGoogle,
	selectCalendars,
} from "../lib/reconcile/normalize";
import {
	type Diagnostic,
	ReconcileError,
	type ReconcileReport,
} from "../lib/reconcile/types";
import {
	resolveReconcileWindow,
	type WindowArgs,
} from "../lib/reconcile/window";
import { resolveEffectiveTimezone } from "../lib/timezone-profile";

export interface ReconcileArgs extends WindowArgs {
	timezone?: string;
	calendar?: string;
	"google-cmd"?: string;
	json?: boolean;
}

/** Orchestration returns a reviewable result; only the command boundary renders/exits. */
export async function runReconcile(args: ReconcileArgs) {
	const now = new Date();
	let report: ReconcileReport = {
		schema_version: 1,
		complete: false,
		generated_at: now.toISOString(),
		window: null,
		sources: {
			atomic: false,
			akiflow: {
				mode: "fresh_full",
				read_start: now.toISOString(),
				read_end: null,
				pages: { events: 0, calendars: 0 },
				complete: false,
			},
			cache: {
				availability: "unavailable",
				generation: null,
				captured_at: now.toISOString(),
				resource_timestamps: { events: null, calendars: null },
				events_age_seconds: null,
			},
			google: [],
		},
		records: [],
		matches: [],
		tiers: null,
		cancelled_evidence: [],
		cache_diagnostics: [],
		diagnostics: [],
		counts: {
			records_by_source: { server: 0, cache: 0, google: 0 },
			unique_matches: 0,
			findings_by_tier: {},
			unique_involved_records: 0,
			cancelled_evidence: 0,
			excluded_records: 0,
		},
	};
	const warnings: string[] = [];
	let stage: "validation" | "akiflow" | "google" | "comparison" = "validation";
	try {
		const timezone = await resolveEffectiveTimezone(args.timezone);
		const window = resolveReconcileWindow(args, now, timezone);
		report.window = window;
		const executable = resolveGoogleExecutable(args["google-cmd"]);
		const cache = captureCacheSnapshot(now);
		report.sources.cache = cache.metadata;
		warnings.push(...cache.warnings);
		stage = "akiflow";
		report.sources.akiflow.read_start = new Date().toISOString();
		const fresh = await readFreshAkiflow(
			createClient({ readOnly: true }),
			report.sources.akiflow,
		);
		stage = "validation";
		const selected = selectCalendars(fresh.calendars, args.calendar);
		stage = "akiflow";
		let server = normalizeAkiflow(
			fresh.events,
			fresh.calendars,
			window,
			selected,
			"server",
			report.sources.akiflow.read_end,
			!!args.calendar,
		);
		// Retain superseded cancellation evidence without overwriting current state.
		const historical = fresh.evidence.filter(
			(event) =>
				!fresh.events.some(
					(current) =>
						current.id === event.id &&
						(current.deleted_at != null ||
							current.status === "cancelled" ||
							current.recurrence_exception_delete),
				),
		);
		const evidence = normalizeAkiflow(
			historical,
			fresh.calendars,
			window,
			selected,
			"server",
			report.sources.akiflow.read_end,
			!!args.calendar,
			fresh.events,
		).map((record) => ({
			...record,
			ref: `${record.ref}:cancellation-evidence`,
		}));
		report.records.push(...server, ...evidence);
		let cached: ReturnType<typeof normalizeAkiflow> = [];
		if (cache.metadata.availability === "available") {
			try {
				const calendars = [
					...cache.calendars.filter(
						(calendar) =>
							!fresh.calendars.some((current) => current.id === calendar.id),
					),
					...fresh.calendars,
				];
				cached = normalizeAkiflow(
					cache.events,
					calendars,
					window,
					selected,
					"cache",
					cache.metadata.resource_timestamps.events,
					!!args.calendar,
					fresh.events,
				);
			} catch (error) {
				report.sources.cache.availability = "unavailable";
				warnings.push(
					`CLI cache is unavailable: ${error instanceof Error ? error.message : error}`,
				);
			}
		}
		report.records.push(...cached);
		stage = "google";
		const observations: GoogleObservation[] = [];
		report.sources.google = selected.map((calendar_id) => ({
			calendar_id,
			read_start: new Date().toISOString(),
			read_end: null,
			pages: 0,
			identity_probes: 0,
			complete: false,
		}));
		for (const coverage of report.sources.google) {
			coverage.read_start = new Date().toISOString();
			observations.push(await readGoogleCalendar(executable, window, coverage));
		}
		let google = normalizeGoogle(observations, fresh.calendars, window);
		server = alignCalendarTimezones(server, observations, window);
		report.records = alignCalendarTimezones(
			report.records,
			observations,
			window,
		);
		const initial = matchRecords(server, google);
		await probeGoogleIdentities(
			executable,
			server,
			observations,
			new Set(initial.linked.keys()),
		);
		google = normalizeGoogle(observations, fresh.calendars, window);
		report.records.push(...google);
		stage = "comparison";
		report = buildReconcileReport({
			records: report.records,
			sources: report.sources,
			selected,
			window,
			now: new Date(),
			notFound: observations.flatMap((source) =>
				source.not_found_ids.map((id) => ({
					calendar: source.calendar_id,
					id,
				})),
			),
		});
		for (const calendar of selected) {
			if (
				!fresh.calendars.some(
					(value) =>
						value.origin_id === calendar &&
						value.connector_id === "google" &&
						value.deleted_at == null,
				) &&
				!report.diagnostics.some(
					(diagnostic) =>
						diagnostic.code === "calendar_not_connected" &&
						diagnostic.calendar === calendar,
				)
			)
				report.diagnostics.push({
					code: "calendar_not_connected",
					calendar,
					refs: [],
					message: `Google calendar ${calendar} has no active Akiflow mapping.`,
				});
		}
		return {
			report,
			warnings: reportWarnings(report, warnings),
			errors: [] as Diagnostic[],
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const exitCode =
			error instanceof AuthError
				? 3
				: error instanceof ReconcileError
					? error.exitCode
					: stage === "validation"
						? 2
						: 5;
		if (stage === "akiflow") {
			report.sources.akiflow.complete = false;
			report.sources.akiflow.error = message;
		}
		if (stage === "google")
			for (const source of report.sources.google) {
				source.complete = false;
				source.error ??= message;
			}
		const diagnostic = {
			code:
				error instanceof ReconcileError
					? error.code
					: exitCode === 3
						? "authentication"
						: "provider_failure",
			message,
			refs: [],
		};
		report.complete = false;
		report.tiers = null;
		report.diagnostics.push(diagnostic);
		report.counts.records_by_source = {
			server: report.records.filter(
				(record) =>
					record.side === "akiflow" && record.observation === "server",
			).length,
			cache: report.records.filter((record) => record.observation === "cache")
				.length,
			google: report.records.filter((record) => record.side === "google")
				.length,
		};
		report.cancelled_evidence = report.records.filter(
			(record) => record.state === "cancelled" || record.state === "deleted",
		);
		report.counts.cancelled_evidence = report.cancelled_evidence.length;
		report.counts.excluded_records = report.records.filter((record) =>
			["hidden", "declined", "excluded"].includes(record.state),
		).length;
		report.generated_at = new Date().toISOString();
		return { report, warnings, errors: [diagnostic], exitCode };
	}
}

export const reconcileCommand = defineCommand({
	meta: {
		name: "reconcile",
		description:
			"Read-only comparison of fresh Akiflow, Google, and the existing CLI cache",
	},
	args: {
		today: { type: "boolean", description: "Audit today (default)" },
		tomorrow: { type: "boolean", description: "Audit tomorrow" },
		date: { type: "string", description: "Local day selector" },
		from: { type: "string", description: "First local day (requires --to)" },
		to: {
			type: "string",
			description: "Last local day, inclusive (requires --from)",
		},
		timezone: {
			type: "string",
			description: "IANA timezone; defaults to profile, then host",
		},
		calendar: {
			type: "string",
			description:
				"Akiflow ID, Google origin ID, or unique title; replaces personal/work defaults",
		},
		"google-cmd": {
			type: "string",
			description:
				"Google helper executable; overrides HATCH_GWS_CLI and PATH hatch_gws_cli",
		},
		json: {
			type: "boolean",
			description: "Versioned reconciliation report as JSON",
		},
	},
	async run({ args }) {
		const outcome = await runReconcile(args);
		if (args.json)
			console.log(
				JSON.stringify(
					{
						result: outcome.report,
						next_cursor: null,
						errors: outcome.errors,
						warnings: outcome.warnings,
					},
					null,
					2,
				),
			);
		else {
			console.log(formatReconcileReport(outcome.report));
			for (const warning of outcome.warnings)
				console.warn(`Warning: ${warning}`);
			for (const error of outcome.errors)
				console.error(`Error: ${error.message}`);
		}
		if (outcome.exitCode) process.exit(outcome.exitCode);
	},
});
