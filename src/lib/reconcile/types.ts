export type RecordTime =
	| { kind: "timed"; start: string; end: string | null }
	| { kind: "all_day"; start_date: string; end_date_exclusive: string }
	| { kind: "unknown" };

export interface ReconcileWindow {
	start: string;
	end: string;
	timezone: string;
	end_exclusive: true;
}

export interface ReconcileRecord {
	ref: string;
	side: "akiflow" | "google";
	observation: "server" | "cache";
	id: string;
	calendar: {
		key: string | null;
		source_id: string;
		akiflow_id: string | null;
		google_id: string | null;
		account_id: string | null;
		title: string | null;
		timezone: string | null;
	};
	title: string | null;
	time: RecordTime;
	/** Unmodified source timing fields, including original occurrence anchors. */
	source_time: Record<string, string | null>;
	state:
		| "active"
		| "cancelled"
		| "deleted"
		| "declined"
		| "hidden"
		| "excluded";
	exclusion_reason: string | null;
	in_window: boolean | null;
	identity: {
		origin_id: string | null;
		series_id: string | null;
		anchor: string | null;
		anchor_kind: "instant" | "date" | null;
		provisional_anchor: boolean;
	};
	is_series_master: boolean;
	read_only: boolean | null;
	event_type: string | null;
	observed_at: string | null;
}

export interface Diagnostic {
	code: string;
	message: string;
	refs: string[];
	calendar?: string;
}

export interface Match {
	akiflow_ref: string;
	google_ref: string;
	akiflow_id: string;
	google_id: string;
	calendar: string;
	method: "provider_id" | "occurrence_anchor" | "title_start";
	confidence: "confirmed" | "probable";
	differences: Array<{ field: string; akiflow: unknown; google: unknown }>;
}

export interface MatchResult {
	matches: Match[];
	collisions: GroupFinding[];
	possible_counterparts: Array<{ akiflow_ref: string; google_refs: string[] }>;
	/** Identity presence, including collisions for which no unique pair exists. */
	linked: Map<string, string[]>;
}

export type Presence = "present" | "absent" | "excluded" | "unavailable";
export interface GoogleGap {
	google_ref: string;
	server_presence: Presence;
	cache_presence: Presence;
	reason:
		| "server_gap"
		| "cache_gap"
		| "both_gap"
		| "calendar_not_connected"
		| "excluded";
	server_refs: string[];
	cache_refs: string[];
}
export interface AkiflowGap {
	akiflow_ref: string;
	reason: string;
	google_evidence_ref: string | null;
	possible_phantom: boolean;
	possible_counterpart_refs: string[];
}
export interface GroupFinding {
	kind: "duplicate" | "overlap" | "identity_collision" | "possible-reshape";
	side: "akiflow" | "google" | "combined";
	calendar: string;
	member_refs: string[];
	edges: Array<{
		refs: [string, string];
		shared_tokens?: number;
		jaccard?: number;
		gap_minutes?: number;
	}>;
	possible_counterpart_refs?: string[];
}
export interface Coverage {
	read_start: string;
	read_end: string | null;
	complete: boolean;
	pages: number;
	error?: string;
}
export interface Sources {
	atomic: false;
	akiflow: {
		mode: "fresh_full";
		read_start: string;
		read_end: string | null;
		pages: { events: number; calendars: number };
		complete: boolean;
		error?: string;
	};
	cache: {
		availability: "available" | "unavailable";
		generation: string | null;
		captured_at: string;
		resource_timestamps: { events: string | null; calendars: string | null };
		events_age_seconds: number | null;
	};
	google: Array<Coverage & { calendar_id: string; identity_probes: number }>;
}
export interface CacheDiagnostic extends Diagnostic {
	presence?: Presence;
	google_state?: string;
	differences?: Match["differences"];
}
export interface ReconcileReport {
	schema_version: 1;
	complete: boolean;
	generated_at: string;
	window: ReconcileWindow | null;
	sources: Sources;
	records: ReconcileRecord[];
	matches: Match[];
	tiers: {
		google_missing: GoogleGap[];
		akiflow_missing_or_cancelled: AkiflowGap[];
		duplicates_or_overlaps: GroupFinding[];
		possible_reshapes: GroupFinding[];
	} | null;
	cancelled_evidence: ReconcileRecord[];
	cache_diagnostics: CacheDiagnostic[];
	diagnostics: Diagnostic[];
	counts: {
		records_by_source: { server: number; cache: number; google: number };
		unique_matches: number;
		findings_by_tier: Record<string, number>;
		unique_involved_records: number;
		cancelled_evidence: number;
		excluded_records: number;
	};
}

export class ReconcileError extends Error {
	constructor(
		message: string,
		readonly exitCode: 2 | 3 | 5 = 5,
		readonly code = "provider_failure",
	) {
		super(message);
		this.name = "ReconcileError";
	}
}
