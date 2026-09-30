/**
 * Provider router (Workstream J): identity resolution and capability gating
 * for recurrence operations.
 *
 * Routes instance-level edits to the correct provider:
 * - If Akiflow exception writes are capability-confirmed → Akiflow path.
 * - Else if Google adapter is configured → Google fallback (Akiflow sync
 *   reported as pending separately).
 * - Else → clean refusal (no guessing, no silent no-op).
 */

import type { Event } from "../api/types";
import { editInstance, isGoogleConfigured, resolveGoogleIdentity } from "./google";
import type {
	IdentityResolution,
	InstanceEdit,
	ProviderEditOutcome,
	ProviderIdentity,
	RecurrenceCapabilities,
} from "./types";
import { defaultRecurrenceCapabilities } from "./types";

export function getCapabilities(): RecurrenceCapabilities {
	const caps = defaultRecurrenceCapabilities();
	// Capability confirmation lives behind explicit env opt-in, validated on
	// disposable fixtures only. Never default true.
	if (process.env.AF_AKIFLOW_EXCEPTION_WRITES === "1") {
		caps.akiflowExceptionWrites = true;
	}
	if (isGoogleConfigured()) {
		caps.googleDirectEdits = true;
	}
	return caps;
}

/** Resolve an event to its provider identity for instance edits. */
export function resolveIdentity(event: Event): IdentityResolution {
	const google = resolveGoogleIdentity({
		id: event.id,
		origin_id: (event as { origin_id?: string | null }).origin_id ?? null,
		calendar_id: event.calendar_id ?? null,
		account_id: null,
		connector_id: null,
	});
	if ("refused" in google) {
		return { ok: false, reason: google.refused };
	}
	const identity: ProviderIdentity = google;
	return { ok: true, identity };
}

/**
 * Perform a scoped instance edit, routing to the capable provider.
 *
 * The occurrence anchor MUST be the instance's `original_start_time`
 * (never the current `start_time`, which moves with edits).
 */
export async function editRecurrenceInstance(
	event: Event,
	originalStartTime: string,
	edit: Omit<InstanceEdit, "originalStartTime">,
	caps: RecurrenceCapabilities = getCapabilities(),
): Promise<ProviderEditOutcome> {
	if (!originalStartTime) {
		return { ok: false, reason: "no-identity", detail: "missing original_start_time anchor" };
	}
	if (caps.akiflowExceptionWrites) {
		// Future: Akiflow exception write path once capability is confirmed
		// on disposable fixtures. Not implemented; refuse rather than guess.
		return {
			ok: false,
			reason: "unsupported-operation",
			detail: "Akiflow exception writes capability-flagged but not implemented",
		};
	}
	const resolution = resolveIdentity(event);
	if (!resolution.ok) {
		const reason =
			resolution.reason === "ambiguous-provider-identity"
				? "ambiguous-identity"
				: resolution.reason === "unsupported-provider"
					? "unsupported-operation"
					: "no-identity";
		return { ok: false, reason, detail: resolution.reason };
	}
	if (!caps.googleDirectEdits) {
		return {
			ok: false,
			reason: "no-credentials",
			detail:
				"Per-instance edits need the Google fallback adapter (AF_GOOGLE_ACCESS_TOKEN). " +
				"Akiflow API does not support recurrence exceptions.",
		};
	}
	return editInstance(resolution.identity, { ...edit, originalStartTime });
}
