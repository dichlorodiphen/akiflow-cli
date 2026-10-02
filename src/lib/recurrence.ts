/**
 * Recurrence utilities (Workstream J): RRULE validation and bounded
 * occurrence preview in the event's owner timezone.
 *
 * Uses the `rrule` package for parsing/validation — never regex.
 */

import { RRule, rrulestr } from "rrule";

export interface RRulePreview {
	/** Normalized RRULE string as it will be serialized. */
	rrule: string;
	/** First N occurrence start times in the owner timezone (ISO strings). */
	occurrences: string[];
}

/**
 * Validate an RRULE string and normalize it.
 *
 * Accepts with or without the `RRULE:` prefix. Returns the normalized rule
 * string (without prefix; callers serialize as `recurrence: ['RRULE:...']`).
 * Throws a descriptive Error on invalid input.
 */
export function validateRRule(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("RRULE must not be empty");
	}
	const body = trimmed.startsWith("RRULE:")
		? trimmed.slice("RRULE:".length)
		: trimmed;
	let rule: RRule;
	try {
		rule = rrulestr(body, { forceset: false }) as RRule;
	} catch (error) {
		throw new Error(
			`Invalid RRULE: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!(rule instanceof RRule)) {
		throw new Error("Invalid RRULE: could not parse as a recurrence rule");
	}
	// Round-trip through toString for normalization; reject rules that lose
	// meaning (e.g. unsupported properties dropped silently).
	let normalized = rule.toString();
	if (normalized.startsWith("RRULE:")) {
		normalized = normalized.slice("RRULE:".length);
	}
	if (!normalized.includes("FREQ=")) {
		throw new Error("Invalid RRULE: missing FREQ component");
	}
	return normalized;
}

/** Serialize a validated RRULE for the Akiflow event payload. */
export function serializeRecurrence(normalizedRule: string): string[] {
	return [`RRULE:${normalizedRule}`];
}

/**
 * Preview the first `count` occurrences of a rule starting at `dtstart`,
 * rendered in the owner timezone.
 *
 * `dtstart` is the event's start instant. Timezone rendering uses the Intl API
 * with the owner IANA zone — occurrence instants are exact; only the display
 * string is zoned.
 */
export function previewOccurrences(
	normalizedRule: string,
	dtstart: Date,
	timeZone: string,
	count = 5,
): RRulePreview {
	let rule: RRule;
	try {
		rule = new RRule({
			...RRule.parseString(normalizedRule),
			dtstart,
		});
	} catch (error) {
		throw new Error(
			`Invalid RRULE for preview: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const dates = rule.all((_, i) => i < count);
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const occurrences = dates.map((d) => {
		// Render zoned wall time plus the exact instant for auditability.
		const parts = formatter.formatToParts(d);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
		return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${timeZone} (${d.toISOString()})`;
	});
	return { rrule: normalizedRule, occurrences };
}

/**
 * Truncate a recurring series by setting RRULE UNTIL.
 *
 * Returns the new recurrence array for the series master. The UNTIL value is
 * the exact instant (UTC) — RRULE UNTIL semantics are inclusive.
 */
export function truncateSeriesUntil(
	existingRecurrence: string[] | null,
	until: Date,
): string[] {
	const raw = (existingRecurrence ?? []).find((r) =>
		r.toUpperCase().startsWith("RRULE:"),
	);
	if (!raw) {
		throw new Error("Cannot truncate: series master has no RRULE");
	}
	const normalized = validateRRule(raw);
	const options = RRule.parseString(normalized);
	// UNTIL must be a UTC instant per RFC 5545.
	const untilUtc = new Date(until.toISOString());
	const rule = new RRule({ ...options, until: untilUtc });
	return serializeRecurrence(rule.toString());
}
