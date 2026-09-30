/**
 * Google Calendar direct adapter (Workstream J).
 *
 * This is a minimal, explicitly-scoped adapter for operations the Akiflow API
 * cannot express — notably per-instance edits of recurring series. It is NOT
 * a general Google Calendar client.
 *
 * Safety rules:
 * - Identity comes from the event's observed provider identity only. Never
 *   title search. Ambiguous identity refuses to mutate.
 * - All writes use `sendUpdates: "none"` (silent; David's guest policy).
 * - Verification is a fresh Google GET after the write. Akiflow-side sync is
 *   reported as "pending" separately — never claim Akiflow is updated until
 *   its sync pulls the change.
 * - Without explicit Google credentials, every operation refuses cleanly with
 *   `no-credentials`. No guessing, no silent failure.
 *
 * Current status: STUB. The interface and refusal paths are implemented;
 * actual Google API calls are behind `isConfigured()`. Wiring real credentials
 * and HTTP is future work and must go through David's explicit auth flow.
 */

import type {
	IdentityRefusalReason,
	InstanceEdit,
	ProviderEditOutcome,
	ProviderIdentity,
} from "./types";

export interface GoogleAdapterConfig {
	/** OAuth access token for Google Calendar API. */
	accessToken: string | null;
}

function readConfig(): GoogleAdapterConfig {
	// Explicit opt-in only. No ambient browser-session scanning (K's policy).
	return {
		accessToken: process.env.AF_GOOGLE_ACCESS_TOKEN ?? null,
	};
}

export function isGoogleConfigured(): boolean {
	return readConfig().accessToken !== null;
}

/**
 * Resolve an Akiflow event to its Google provider identity.
 *
 * Uses only the event's observed origin/provider fields. Returns a refusal
 * when identity is missing or ambiguous — never falls back to title search.
 */
export function resolveGoogleIdentity(event: {
	id: string;
	origin_id?: string | null;
	calendar_id?: string | null;
	account_id?: string | null;
	connector_id?: string | null;
}): ProviderIdentity | { refused: IdentityRefusalReason } {
	const originId = event.origin_id ?? null;
	if (!originId) {
		return { refused: "no-provider-identity" };
	}
	// A Google event ID is expected here; Akiflow-native UUIDs without a
	// provider mapping are not Google identities.
	// Heuristic: Google IDs are opaque strings, not UUIDs. This is intentionally
	// conservative — ambiguous cases refuse rather than guess.
	const uuidPattern =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (uuidPattern.test(originId)) {
		return { refused: "no-provider-identity" };
	}
	return {
		kind: "google",
		providerEventId: originId,
		providerCalendarId: event.calendar_id ?? null,
		accountId: event.account_id ?? null,
	};
}

/**
 * Edit a single instance of a recurring series via Google Calendar API.
 *
 * Instance is addressed by its occurrence anchor (`originalStartTime`), which
 * Google addresses as `<eventId>_<originalStartTimestamp>`.
 */
export async function editInstance(
	identity: ProviderIdentity,
	edit: InstanceEdit,
): Promise<ProviderEditOutcome> {
	if (!isGoogleConfigured()) {
		return { ok: false, reason: "no-credentials" };
	}
	// Stub: real HTTP wiring is future work behind explicit auth.
	// The refusal above is the load-bearing behavior for now.
	return {
		ok: false,
		reason: "unsupported-operation",
		detail:
			"Google direct edits are not yet wired. Set AF_GOOGLE_ACCESS_TOKEN and implement the Calendar API PATCH. " +
			`Would edit instance ${identity.providerEventId} anchored at ${edit.originalStartTime} with sendUpdates=none.`,
	};
}

/**
 * Verify an instance edit with a fresh Google GET.
 */
export async function verifyInstance(
	_identity: ProviderIdentity,
	_originalStartTime: string,
): Promise<boolean> {
	if (!isGoogleConfigured()) return false;
	// Stub: see editInstance.
	return false;
}
