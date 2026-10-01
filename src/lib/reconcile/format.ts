import { formatInTimezone } from "../timezone";
import type { ReconcileRecord, ReconcileReport } from "./types";

export function stableLabels(records: ReconcileRecord[]): Map<string, string> {
	const counters = { A: 0, C: 0, G: 0 };
	const labels = new Map<string, string>();
	for (const record of [...records].sort((a, b) =>
		a.ref.localeCompare(b.ref),
	)) {
		const prefix =
			record.side === "google"
				? "G"
				: record.observation === "cache"
					? "C"
					: "A";
		labels.set(record.ref, `${prefix}${++counters[prefix]}`);
	}
	return labels;
}

export function reportWarnings(
	report: ReconcileReport,
	cacheWarnings: string[] = [],
): string[] {
	const warnings = [...cacheWarnings];
	for (const diagnostic of report.diagnostics)
		warnings.push(diagnostic.message);
	for (const match of report.matches) {
		if (match.differences.length)
			warnings.push(
				`Matched records ${match.akiflow_id} / ${match.google_id} differ in ${match.differences.map((difference) => difference.field).join(", ")}.`,
			);
	}
	for (const collision of report.tiers?.duplicates_or_overlaps ?? []) {
		if (collision.kind === "identity_collision")
			warnings.push(
				`Identity collision on ${collision.calendar}: multiplicity remains unresolved.`,
			);
	}
	return [...new Set(warnings)].sort();
}

export function formatReconcileReport(report: ReconcileReport): string {
	const labels = stableLabels(report.records);
	const byRef = new Map(report.records.map((record) => [record.ref, record]));
	const label = (ref: string) => `[${labels.get(ref) ?? ref}]`;
	const zone = report.window?.timezone ?? "UTC";
	const clock = (iso: string) => {
		const civil = formatInTimezone(iso, zone);
		return `${String(civil.hours).padStart(2, "0")}:${String(civil.minutes).padStart(2, "0")}`;
	};
	const recordLine = (ref: string): string => {
		const record = byRef.get(ref);
		if (!record) return label(ref);
		const time =
			record.time.kind === "timed"
				? `${clock(record.time.start)}${record.time.end ? `–${clock(record.time.end)}` : ""}`
				: record.time.kind === "all_day"
					? `${record.time.start_date} (all day, until ${record.time.end_date_exclusive} exclusive)`
					: "time unknown";
		return `${label(ref)} ${record.calendar.title ?? record.calendar.key ?? record.calendar.source_id} · ${record.title ?? "title unknown"} · ${time}`;
	};
	const ids = (refs: string[]): string[] =>
		refs.map((ref) => {
			const record = byRef.get(ref);
			return `       ${record?.side === "google" ? "Google" : record?.observation === "cache" ? "Cache Akiflow" : "Akiflow"} ID: ${record?.id ?? ref}${record?.side === "akiflow" && record.identity.origin_id ? ` · provider ID: ${record.identity.origin_id}` : ""}`;
		});
	const day = report.window
		? (() => {
				const civil = formatInTimezone(report.window.start, zone);
				const endCivil = formatInTimezone(
					new Date(Date.parse(report.window.end) - 1).toISOString(),
					zone,
				);
				const first = `${civil.year}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`;
				const last = `${endCivil.year}-${String(endCivil.month).padStart(2, "0")}-${String(endCivil.day).padStart(2, "0")}`;
				return first === last ? first : `${first}–${last}`;
			})()
		: "unresolved window";
	const cache = report.sources.cache;
	const lines = [
		`Reconcile — ${day} · ${zone}`,
		`Fresh Akiflow + Google · cache generation ${cache.generation ?? "unavailable"}, ${cache.events_age_seconds === null ? "age unknown" : `${Math.round(cache.events_age_seconds)}s old`}`,
		"",
	];
	if (!report.complete || !report.tiers) {
		lines.push(
			"Incomplete report; discrepancy tiers were not computed.",
			...report.diagnostics.map(
				(diagnostic) => `  ${diagnostic.code}: ${diagnostic.message}`,
			),
		);
		return lines.join("\n");
	}
	const section = (title: string, count: number) => {
		lines.push(`${title} (${count})`);
		if (!count) lines.push("  none");
	};
	section("Google missing from Akiflow", report.tiers.google_missing.length);
	for (const finding of report.tiers.google_missing) {
		lines.push(
			`  ${recordLine(finding.google_ref)}`,
			`       Fresh Akiflow: ${finding.server_presence} · CLI cache: ${finding.cache_presence} · ${finding.reason}`,
			...ids([
				finding.google_ref,
				...finding.server_refs,
				...finding.cache_refs,
			]),
		);
	}
	lines.push("");
	section(
		"Akiflow missing/cancelled on Google",
		report.tiers.akiflow_missing_or_cancelled.length,
	);
	for (const finding of report.tiers.akiflow_missing_or_cancelled) {
		lines.push(
			`  ${recordLine(finding.akiflow_ref)}`,
			`       ${finding.reason}${finding.possible_phantom ? " · possible phantom (suspicion)" : ""}`,
			...ids([
				finding.akiflow_ref,
				...(finding.google_evidence_ref ? [finding.google_evidence_ref] : []),
			]),
		);
	}
	for (const [title, findings] of [
		["Duplicates / overlaps", report.tiers.duplicates_or_overlaps],
		["Possible reshape leftovers", report.tiers.possible_reshapes],
	] as const) {
		lines.push("");
		section(title, findings.length);
		for (const finding of findings) {
			lines.push(
				`  ${finding.side === "google" ? "Google" : finding.side === "akiflow" ? "Akiflow" : "Combined"} · ${finding.calendar} · ${finding.kind === "duplicate" ? "possible duplicate" : finding.kind}`,
				...finding.member_refs.map((ref) => `    ${recordLine(ref)}`),
				...ids(finding.member_refs),
			);
		}
	}
	if (report.cancelled_evidence.length) {
		lines.push(
			"",
			`Cancellation evidence (${report.cancelled_evidence.length})`,
		);
		for (const record of report.cancelled_evidence)
			lines.push(
				`  ${recordLine(record.ref)} · ${record.state}`,
				...ids([record.ref]),
			);
	}
	if (report.cache_diagnostics.length) {
		lines.push("", `Cache diagnostics (${report.cache_diagnostics.length})`);
		for (const diagnostic of report.cache_diagnostics)
			lines.push(
				`  ${diagnostic.code}: ${diagnostic.refs.map(label).join(", ")} · ${diagnostic.message}${diagnostic.google_state ? ` Google: ${diagnostic.google_state}.` : ""}`,
			);
	}
	const differences = report.matches.filter(
		(match) => match.differences.length,
	);
	if (differences.length) {
		lines.push("", `Matched field differences (${differences.length})`);
		for (const match of differences) {
			lines.push(
				`  ${recordLine(match.akiflow_ref)}`,
				`  ${recordLine(match.google_ref)}`,
				...ids([match.akiflow_ref, match.google_ref]),
				...match.differences.map(
					(difference) =>
						`       ${difference.field}: ${JSON.stringify(difference.akiflow)} → ${JSON.stringify(difference.google)}`,
				),
			);
		}
	}
	const findings = Object.values(report.counts.findings_by_tier).reduce(
		(sum, count) => sum + count,
		0,
	);
	lines.push(
		"",
		`Matches: ${report.counts.unique_matches} · findings: ${findings} · unique records involved: ${report.counts.unique_involved_records}`,
	);
	return lines.join("\n");
}
