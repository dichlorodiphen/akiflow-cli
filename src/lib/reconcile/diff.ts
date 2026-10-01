import {
	detectDuplicateRecords,
	detectReshapeRecords,
} from "../event-duplicates";
import type { TimedRecord } from "../timed-record";
import { matchRecords, normalizedTitle } from "./match";
import type {
	CacheDiagnostic,
	Diagnostic,
	GroupFinding,
	MatchResult,
	Presence,
	ReconcileRecord,
	ReconcileReport,
	ReconcileWindow,
	Sources,
} from "./types";

export function timedProjection(record: ReconcileRecord): TimedRecord {
	return {
		id: record.ref,
		calendar: record.calendar.key ?? record.calendar.source_id,
		title: record.title,
		start: record.time.kind === "timed" ? record.time.start : null,
		end: record.time.kind === "timed" ? record.time.end : null,
	};
}

function overlap(a: TimedRecord, b: TimedRecord): boolean {
	if (!a.start || !b.start) return false;
	const as = Date.parse(a.start),
		ae = Date.parse(a.end ?? a.start),
		bs = Date.parse(b.start),
		be = Date.parse(b.end ?? b.start);
	return (as < be && bs < ae) || (as === ae && bs === be && as === bs);
}

function reshapeEdge(
	a: TimedRecord,
	b: TimedRecord,
): GroupFinding["edges"][number] | null {
	if (
		!a.start ||
		!b.start ||
		a.id === b.id ||
		normalizedTitle(a.title) === normalizedTitle(b.title)
	)
		return null;
	const tokens = (title: string | null) =>
		new Set(
			(title ?? "")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter(Boolean),
		);
	const ta = tokens(a.title),
		tb = tokens(b.title);
	const shared = [...ta].filter((token) => tb.has(token)).length;
	const jaccard = shared / (ta.size + tb.size - shared);
	const gap = overlap(a, b)
		? 0
		: Math.min(
				Math.abs(Date.parse(a.start) - Date.parse(b.end ?? b.start)),
				Math.abs(Date.parse(b.start) - Date.parse(a.end ?? a.start)),
			) / 60000;
	return shared >= 2 && jaccard >= 0.5 && gap <= 30
		? { refs: [a.id, b.id], shared_tokens: shared, jaccard, gap_minutes: gap }
		: null;
}

function sourceGroups(
	records: ReconcileRecord[],
	side: "akiflow" | "google",
): GroupFinding[] {
	const projection = records.map(timedProjection);
	const duplicates: GroupFinding[] = detectDuplicateRecords(projection).map(
		(group) => ({
			kind: "duplicate",
			side,
			calendar: group.calendar_id,
			member_refs: group.event_ids,
			edges: [],
		}),
	);
	for (let i = 0; i < projection.length; i++) {
		const a = projection[i];
		if (!a) continue;
		for (const b of projection.slice(i + 1)) {
			if (a.calendar !== b.calendar || !overlap(a, b)) continue;
			const duplicate = duplicates.find(
				(group) =>
					group.member_refs.includes(a.id) && group.member_refs.includes(b.id),
			);
			if (duplicate) {
				duplicate.edges.push({ refs: [a.id, b.id] });
				continue;
			}
			duplicates.push({
				kind: "overlap",
				side,
				calendar: a.calendar,
				member_refs: [a.id, b.id],
				edges: [{ refs: [a.id, b.id] }],
			});
		}
	}
	return duplicates;
}

/** Collapse unique active mirrors, retaining both source references. */
export function detectLogicalReshapes(
	server: ReconcileRecord[],
	google: ReconcileRecord[],
	matched: MatchResult,
): GroupFinding[] {
	const aliases = new Map<string, string[]>();
	const removed = new Set<string>();
	for (const match of matched.matches) {
		if (
			server.some((record) => record.ref === match.akiflow_ref) &&
			google.some((record) => record.ref === match.google_ref)
		) {
			aliases.set(match.google_ref, [match.akiflow_ref, match.google_ref]);
			aliases.set(match.akiflow_ref, [match.akiflow_ref, match.google_ref]);
			removed.add(match.akiflow_ref);
		}
	}
	const inventories: Array<{
		side: GroupFinding["side"];
		records: ReconcileRecord[];
	}> = [
		{ side: "akiflow", records: server },
		{ side: "google", records: google },
		{
			side: "combined",
			records: [
				...server.filter((record) => !removed.has(record.ref)),
				...google,
			],
		},
	];
	const merged = new Map<string, GroupFinding>();
	for (const inventory of inventories) {
		const projection = inventory.records.map(timedProjection);
		for (const group of detectReshapeRecords(projection)) {
			const members = [
				...new Set(group.event_ids.flatMap((ref) => aliases.get(ref) ?? [ref])),
			].sort();
			const edges: GroupFinding["edges"] = [];
			const inputs = projection.filter((record) =>
				group.event_ids.includes(record.id),
			);
			for (let i = 0; i < inputs.length; i++) {
				const a = inputs[i];
				if (!a) continue;
				for (const b of inputs.slice(i + 1)) {
					const edge = reshapeEdge(a, b);
					if (edge) edges.push(edge);
				}
			}
			const key = members.join("|");
			const existing = merged.get(key);
			if (existing) {
				existing.side =
					existing.side === inventory.side ? existing.side : "combined";
				existing.edges = [
					...new Map(
						[...existing.edges, ...edges].map((edge) => [
							edge.refs.slice().sort().join("|"),
							edge,
						]),
					).values(),
				];
			} else
				merged.set(key, {
					kind: "possible-reshape",
					side: inventory.side,
					calendar: group.calendar_id,
					member_refs: members,
					edges,
				});
		}
	}
	for (const group of merged.values()) {
		group.possible_counterpart_refs = [
			...new Set(
				matched.possible_counterparts
					.filter(
						(candidate) =>
							group.member_refs.includes(candidate.akiflow_ref) ||
							candidate.google_refs.some((ref) =>
								group.member_refs.includes(ref),
							),
					)
					.flatMap((candidate) => [
						candidate.akiflow_ref,
						...candidate.google_refs,
					]),
			),
		].sort();
	}
	return [...merged.values()];
}

function presence(
	refs: string[],
	byRef: Map<string, ReconcileRecord>,
	available: boolean,
): Presence {
	if (!available) return "unavailable";
	if (!refs.length) return "absent";
	return refs.some((ref) => byRef.get(ref)?.state === "active")
		? "present"
		: "excluded";
}

export interface BuildReportInput {
	records: ReconcileRecord[];
	window: ReconcileWindow;
	sources: Sources;
	selected: string[];
	now: Date;
	notFound?: Array<{ calendar: string; id: string }>;
}

export function buildReconcileReport(input: BuildReportInput): ReconcileReport {
	const records = [...input.records].sort((a, b) => a.ref.localeCompare(b.ref));
	const byRef = new Map(records.map((record) => [record.ref, record]));
	const server = records.filter(
		(record) => record.side === "akiflow" && record.observation === "server",
	);
	const cache = records.filter((record) => record.observation === "cache");
	const google = records.filter((record) => record.side === "google");
	const matched = matchRecords(
		server.filter((record) => !record.ref.endsWith(":cancellation-evidence")),
		google,
	);
	const cacheMatched = matchRecords(cache, google);
	const active = (items: ReconcileRecord[]) =>
		items.filter((record) => record.state === "active" && record.in_window);
	const tiers: NonNullable<ReconcileReport["tiers"]> = {
		google_missing: [],
		akiflow_missing_or_cancelled: [],
		duplicates_or_overlaps: [],
		possible_reshapes: [],
	};
	const diagnostics: Diagnostic[] = [];
	const cacheDiagnostics: CacheDiagnostic[] = [];
	for (const calendar of input.selected) {
		if (
			!google.some(
				(record) =>
					record.calendar.key === calendar && record.calendar.akiflow_id,
			) &&
			!server.some(
				(record) =>
					record.calendar.key === calendar &&
					record.exclusion_reason !== "deleted_calendar",
			)
		) {
			// Empty mapped calendars are resolved via caller coverage diagnostics below.
			if (
				google.some(
					(record) =>
						record.calendar.key === calendar && !record.calendar.akiflow_id,
				)
			)
				diagnostics.push({
					code: "calendar_not_connected",
					calendar,
					refs: [],
					message: `Google calendar ${calendar} has no active Akiflow mapping.`,
				});
		}
	}
	for (const g of active(google)) {
		const serverRefs = matched.linked.get(g.ref) ?? [];
		const cacheRefs = cacheMatched.linked.get(g.ref) ?? [];
		const sp = presence(serverRefs, byRef, true);
		const cp = presence(
			cacheRefs,
			byRef,
			input.sources.cache.availability === "available",
		);
		if (sp === "present" && (cp === "present" || cp === "unavailable"))
			continue;
		tiers.google_missing.push({
			google_ref: g.ref,
			server_presence: sp,
			cache_presence: cp,
			reason: !g.calendar.akiflow_id
				? "calendar_not_connected"
				: sp === "excluded" || cp === "excluded"
					? "excluded"
					: sp === "absent" && cp === "absent"
						? "both_gap"
						: sp === "absent"
							? "server_gap"
							: "cache_gap",
			server_refs: serverRefs,
			cache_refs: cacheRefs,
		});
	}
	for (const a of active(server)) {
		const refs = matched.linked.get(a.ref) ?? [];
		if (!refs.length && !a.identity.origin_id && !a.identity.series_id)
			diagnostics.push({
				code: "identity_unresolved",
				refs: [a.ref],
				message: `Akiflow record ${a.id} has no provider identity and no unique title/start counterpart.`,
			});
		if (refs.some((ref) => byRef.get(ref)?.state === "active")) continue;
		const evidence = refs.map((ref) => byRef.get(ref)).find((record) => record);
		if (evidence?.state === "declined" || evidence?.state === "excluded") {
			diagnostics.push({
				code: "counterpart_excluded",
				refs: [a.ref, evidence.ref],
				message: `Google counterpart is ${evidence.state}${evidence.exclusion_reason ? ` (${evidence.exclusion_reason})` : ""}.`,
			});
			continue;
		}
		const notFound = input.notFound?.some(
			(entry) =>
				entry.calendar === a.calendar.key && entry.id === a.identity.origin_id,
		);
		const seriesPresent = google.some(
			(g) =>
				g.is_series_master &&
				g.calendar.key === a.calendar.key &&
				g.id === a.identity.series_id,
		);
		tiers.akiflow_missing_or_cancelled.push({
			akiflow_ref: a.ref,
			reason:
				evidence?.state === "cancelled" || evidence?.state === "deleted"
					? "cancelled_on_google"
					: notFound
						? "provider_id_not_found"
						: seriesPresent
							? "series_present_occurrence_unobserved"
							: "not_observed_in_window",
			google_evidence_ref: evidence?.ref ?? null,
			possible_phantom: a.read_only === true,
			possible_counterpart_refs:
				matched.possible_counterparts.find(
					(candidate) => candidate.akiflow_ref === a.ref,
				)?.google_refs ?? [],
		});
	}
	for (const match of cacheMatched.matches)
		cacheDiagnostics.push({
			code: "cache_match",
			message: "Pinned cache counterpart comparison.",
			refs: [match.akiflow_ref, match.google_ref],
			presence: presence([match.akiflow_ref], byRef, true),
			differences: match.differences,
		});
	for (const c of active(cache)) {
		const gRefs = cacheMatched.linked.get(c.ref) ?? [];
		const freshRecord = server.find(
			(a) => a.calendar.key === c.calendar.key && a.id === c.id,
		);
		if (freshRecord && freshRecord.state !== c.state)
			cacheDiagnostics.push({
				code: "cache_obsolete_state",
				message: `Cached active record is ${freshRecord.state} in fresh Akiflow.`,
				refs: [c.ref, freshRecord.ref, ...gRefs],
				google_state:
					gRefs.map((ref) => byRef.get(ref)?.state).join(",") || "unobserved",
			});
		const serverPresent =
			server.some((a) => a.calendar.key === c.calendar.key && a.id === c.id) ||
			gRefs.some((ref) => matched.linked.has(ref));
		if (!serverPresent)
			cacheDiagnostics.push({
				code: "cache_only_record",
				message: "Record exists only in the captured CLI cache.",
				refs: [c.ref, ...gRefs],
				google_state:
					gRefs.map((ref) => byRef.get(ref)?.state).join(",") || "unobserved",
			});
	}
	for (const collision of cacheMatched.collisions)
		cacheDiagnostics.push({
			code: "cache_identity_collision",
			message: "Cache identity multiplicity is unresolved.",
			refs: collision.member_refs,
		});
	for (const record of records) {
		if (record.exclusion_reason === "unmapped_calendar")
			diagnostics.push({
				code: "unmapped_calendar",
				refs: [record.ref],
				message: `Akiflow calendar ${record.calendar.source_id} has no Google mapping; excluded from absence claims.`,
			});
	}
	for (const candidate of matched.possible_counterparts)
		diagnostics.push({
			code: "possible_counterpart",
			refs: [candidate.akiflow_ref, ...candidate.google_refs],
			message:
				"Title/start candidates remain unresolved; provider identity is contradictory or ambiguous.",
		});
	tiers.duplicates_or_overlaps = [
		...matched.collisions.filter((group) =>
			group.member_refs.some((ref) => byRef.get(ref)?.in_window),
		),
		...sourceGroups(active(server), "akiflow"),
		...sourceGroups(active(google), "google"),
	];
	tiers.possible_reshapes = detectLogicalReshapes(
		active(server),
		active(google),
		matched,
	);
	const involved = new Set([
		...tiers.google_missing.flatMap((finding) => [
			finding.google_ref,
			...finding.server_refs,
			...finding.cache_refs,
		]),
		...tiers.akiflow_missing_or_cancelled.flatMap((finding) => [
			finding.akiflow_ref,
			...(finding.google_evidence_ref ? [finding.google_evidence_ref] : []),
		]),
		...tiers.duplicates_or_overlaps.flatMap((finding) => finding.member_refs),
		...tiers.possible_reshapes.flatMap((finding) => finding.member_refs),
	]);
	const cancelled = records.filter(
		(record) => record.state === "cancelled" || record.state === "deleted",
	);
	return {
		schema_version: 1,
		complete: true,
		generated_at: input.now.toISOString(),
		window: input.window,
		sources: input.sources,
		records,
		matches: matched.matches,
		tiers,
		cancelled_evidence: cancelled,
		cache_diagnostics: cacheDiagnostics,
		diagnostics,
		counts: {
			records_by_source: {
				server: server.length,
				cache: cache.length,
				google: google.length,
			},
			unique_matches: matched.matches.length,
			findings_by_tier: Object.fromEntries(
				Object.entries(tiers).map(([name, findings]) => [
					name,
					findings.length,
				]),
			),
			unique_involved_records: involved.size,
			cancelled_evidence: cancelled.length,
			excluded_records: records.filter((record) =>
				["hidden", "declined", "excluded"].includes(record.state),
			).length,
		},
	};
}
