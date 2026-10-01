import type {
	GroupFinding,
	Match,
	MatchResult,
	ReconcileRecord,
} from "./types";

export function normalizedTitle(title: string | null): string {
	return (title ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

function startKey(record: ReconcileRecord): string | null {
	return record.time.kind === "timed"
		? record.time.start
		: record.time.kind === "all_day"
			? record.time.start_date
			: null;
}

export function compareFields(
	akiflow: ReconcileRecord,
	google: ReconcileRecord,
): Match["differences"] {
	const differences: Match["differences"] = [];
	for (const field of ["title", "time", "state"] as const) {
		// Sparse cancellation fields stay unknown instead of inventing changes.
		if (field === "title" && google.title === null) continue;
		if (field === "time" && google.time.kind === "unknown") continue;
		if (JSON.stringify(akiflow[field]) !== JSON.stringify(google[field]))
			differences.push({
				field,
				akiflow: akiflow[field],
				google: google[field],
			});
	}
	return differences;
}

function exact(a: ReconcileRecord, g: ReconcileRecord): boolean {
	return (
		!!a.identity.origin_id &&
		a.identity.origin_id === g.id &&
		!g.is_series_master
	);
}

function occurrence(a: ReconcileRecord, g: ReconcileRecord): boolean {
	return (
		!g.is_series_master &&
		!!a.identity.series_id &&
		a.identity.series_id === g.identity.series_id &&
		!!a.identity.anchor &&
		a.identity.anchor_kind === g.identity.anchor_kind &&
		a.identity.anchor === g.identity.anchor
	);
}

function fallback(a: ReconcileRecord, g: ReconcileRecord): boolean {
	return (
		a.state === "active" &&
		g.state === "active" &&
		!g.is_series_master &&
		a.time.kind === g.time.kind &&
		!!normalizedTitle(a.title) &&
		normalizedTitle(a.title) === normalizedTitle(g.title) &&
		startKey(a) !== null &&
		startKey(a) === startKey(g)
	);
}

/** Calendar-scoped matching before window filtering; never infer missing instances. */
export function matchRecords(
	akiflow: ReconcileRecord[],
	google: ReconcileRecord[],
): MatchResult {
	const matches: Match[] = [];
	const collisions: GroupFinding[] = [];
	const possible = new Map<string, Set<string>>();
	const linked = new Map<string, string[]>();
	const consumed = new Set<string>();
	const blocked = new Set<string>();
	const scoped = (a: ReconcileRecord, g: ReconcileRecord) =>
		!!a.calendar.key && a.calendar.key === g.calendar.key;
	const link = (a: ReconcileRecord, g: ReconcileRecord) => {
		linked.set(a.ref, [...new Set([...(linked.get(a.ref) ?? []), g.ref])]);
		linked.set(g.ref, [...new Set([...(linked.get(g.ref) ?? []), a.ref])]);
	};
	for (const method of [
		"provider_id",
		"occurrence_anchor",
		"title_start",
	] as const) {
		const eligibleA = akiflow.filter(
			(record) => !consumed.has(record.ref) && !blocked.has(record.ref),
		);
		const eligibleG = google.filter(
			(record) => !consumed.has(record.ref) && !blocked.has(record.ref),
		);
		const aCandidates = new Map<string, ReconcileRecord[]>();
		const gCandidates = new Map<string, ReconcileRecord[]>();
		for (const a of eligibleA) {
			for (const g of eligibleG) {
				if (!scoped(a, g)) continue;
				const qualifies =
					method === "provider_id"
						? exact(a, g)
						: method === "occurrence_anchor"
							? occurrence(a, g)
							: fallback(a, g);
				if (!qualifies) continue;
				aCandidates.set(a.ref, [...(aCandidates.get(a.ref) ?? []), g]);
				gCandidates.set(g.ref, [...(gCandidates.get(g.ref) ?? []), a]);
			}
		}
		if (method !== "title_start") {
			const collisionKeys = new Set<string>();
			for (const g of eligibleG) {
				const claimants = gCandidates.get(g.ref) ?? [];
				if (claimants.length < 2) continue;
				const refs = [...claimants.map((record) => record.ref), g.ref].sort();
				const key = refs.join("|");
				if (!collisionKeys.has(key)) {
					collisions.push({
						kind: "identity_collision",
						side: "akiflow",
						calendar: g.calendar.key ?? "",
						member_refs: refs,
						edges: [],
					});
					collisionKeys.add(key);
				}
				for (const a of claimants) {
					link(a, g);
					blocked.add(a.ref);
				}
				blocked.add(g.ref);
			}
		}
		for (const a of eligibleA) {
			const candidates = aCandidates.get(a.ref) ?? [];
			if (method === "title_start" && candidates.length)
				possible.set(a.ref, new Set(candidates.map((record) => record.ref)));
			if (candidates.length !== 1 || blocked.has(a.ref)) continue;
			const g = candidates[0];
			if (!g || blocked.has(g.ref) || gCandidates.get(g.ref)?.length !== 1)
				continue;
			if (
				method === "title_start" &&
				a.identity.origin_id &&
				a.identity.origin_id !== g.id
			)
				continue;
			link(a, g);
			consumed.add(a.ref);
			consumed.add(g.ref);
			possible.delete(a.ref);
			matches.push({
				akiflow_ref: a.ref,
				google_ref: g.ref,
				akiflow_id: a.id,
				google_id: g.id,
				calendar: a.calendar.key ?? "",
				method,
				confidence:
					method === "title_start" ||
					(method === "occurrence_anchor" && a.identity.provisional_anchor)
						? "probable"
						: "confirmed",
				differences: compareFields(a, g),
			});
		}
	}
	return {
		matches,
		collisions,
		possible_counterparts: [...possible].map(([akiflow_ref, refs]) => ({
			akiflow_ref,
			google_refs: [...refs].sort(),
		})),
		linked,
	};
}
