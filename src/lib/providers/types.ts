/**
 * Provider capability types for the recurrence/provider layer (Workstream J).
 *
 * Akiflow is the scheduling source of truth. Google Calendar is an optional
 * direct provider used only as a fallback for operations Akiflow cannot express
 * (notably per-instance edits of recurring series, which the Akiflow API does
 * not support as of this writing).
 *
 * Design rules:
 * - Never guess provider IDs from title search. Identity must come from the
 *   event's observed provider identity (origin_id / provider mapping).
 * - Ambiguous mapping refuses to mutate (returns a typed refusal, never throws
 *   a bare error that could be misread as success).
 * - Guest notifications default to silent (`sendUpdates: "none"`).
 */

export type ProviderKind = "akiflow" | "google";

/** Observed provider identity for an event, derived from cached records. */
export interface ProviderIdentity {
	kind: ProviderKind;
	/** Provider-native event ID (Google event ID, or Akiflow UUID). */
	providerEventId: string;
	/** Provider-native calendar ID, if known. */
	providerCalendarId: string | null;
	/** Account/connector the identity was observed on, if known. */
	accountId: string | null;
}

/** Outcome of resolving an Akiflow event to a provider identity. */
export type IdentityResolution =
	| { ok: true; identity: ProviderIdentity }
	| { ok: false; reason: IdentityRefusalReason };

export type IdentityRefusalReason =
	| "no-provider-identity"
	| "ambiguous-provider-identity"
	| "unsupported-provider";

export interface InstanceEdit {
	/** The occurrence anchor: the instance's original start (never current start_time). */
	originalStartTime: string;
	title?: string;
	description?: string | null;
	location?: string | null;
	startTime?: string;
	endTime?: string;
}

export interface ProviderEditResult {
	provider: ProviderKind;
	providerEventId: string;
	/** True when a fresh provider GET confirmed the edit. */
	verified: boolean;
	/** Akiflow-side sync state: Akiflow pulls provider changes asynchronously. */
	akiflowSync: "pending" | "not-applicable";
}

export type ProviderEditOutcome =
	| { ok: true; result: ProviderEditResult }
	| { ok: false; reason: ProviderRefusalReason; detail?: string };

export type ProviderRefusalReason =
	| "no-credentials"
	| "ambiguous-identity"
	| "no-identity"
	| "unsupported-operation"
	| "verification-failed";

/** Capability flags for recurrence operations. */
export interface RecurrenceCapabilities {
	/**
	 * Whether Akiflow supports recurrence-exception writes (per-instance edits
	 * via the Akiflow API). Unknown until confirmed on disposable fixtures.
	 * Instance edits must refuse unless this is true.
	 */
	akiflowExceptionWrites: boolean;
	/** Whether the Google fallback adapter is configured and usable. */
	googleDirectEdits: boolean;
}

export function defaultRecurrenceCapabilities(): RecurrenceCapabilities {
	return {
		akiflowExceptionWrites: false,
		googleDirectEdits: false,
	};
}
