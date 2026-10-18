/**
 * Recurrence utilities (Workstream J): RRULE validation and bounded
 * occurrence preview in the event's owner timezone.
 *
 * Uses the `rrule` package for parsing/validation — never regex.
 */

import { RRule, RRuleSet, rrulestr } from "rrule";
import {
	DSTGapError,
	formatInTimezone,
	validateTimezone,
	zonedTimeToUtc,
} from "./timezone";

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
	if (/[\r\n]/.test(trimmed)) {
		throw new Error(
			"Invalid RRULE: expected a single RRULE, without DTSTART or other properties",
		);
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
	const options = rule.origOptions;
	for (const field of ["interval", "count"] as const) {
		const value = options[field];
		if (value != null && (!Number.isSafeInteger(value) || value < 1))
			throw new Error(
				`Invalid RRULE: ${field.toUpperCase()} must be a positive integer`,
			);
	}
	const bounds = {
		bymonth: [1, 12],
		bymonthday: [-31, 31],
		byyearday: [-366, 366],
		byweekno: [-53, 53],
		bysetpos: [-366, 366],
		byhour: [0, 23],
		byminute: [0, 59],
		bysecond: [0, 59],
	} as const;
	for (const field of Object.keys(bounds) as (keyof typeof bounds)[]) {
		const value = options[field];
		const values = value == null ? [] : Array.isArray(value) ? value : [value];
		const [min, max] = bounds[field];
		if (
			values.some(
				(v) =>
					!Number.isInteger(v) || v < min || v > max || (min < 0 && v === 0),
			)
		)
			throw new Error(`Invalid RRULE: invalid ${field.toUpperCase()} value`);
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
	if (!Number.isInteger(count) || count < 0 || count > 1000)
		throw new Error("Preview count must be an integer from 0 to 1000");
	validateTimezone(timeZone);
	const wall = formatInTimezone(dtstart.toISOString(), timeZone);
	const floatingStart = new Date(
		Date.UTC(
			wall.year,
			wall.month - 1,
			wall.day,
			wall.hours,
			wall.minutes,
			dtstart.getUTCSeconds(),
			dtstart.getUTCMilliseconds(),
		),
	);
	const options = RRule.parseString(validateRRule(normalizedRule));
	const until = options.until
		? formatInTimezone(options.until.toISOString(), timeZone)
		: null;
	const rule = new RRule({
		...options,
		dtstart: floatingStart,
		...(until
			? {
					until: new Date(
						Date.UTC(
							until.year,
							until.month - 1,
							until.day,
							until.hours,
							until.minutes,
							options.until!.getUTCSeconds(),
						),
					),
				}
			: {}),
	});
	const dates: Date[] = [];
	rule.all((candidate) => {
		if (dates.length >= count) return false;
		try {
			const instant = new Date(
				Date.parse(
					zonedTimeToUtc(
						candidate.toISOString().slice(0, 10),
						candidate.getUTCHours(),
						candidate.getUTCMinutes(),
						timeZone,
						"first",
					),
				) +
					candidate.getUTCSeconds() * 1000 +
					candidate.getUTCMilliseconds(),
			);
			dates.push(instant);
		} catch (error) {
			if (!(error instanceof DSTGapError)) throw error;
		}
		return dates.length < count;
	});
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
	dtstart?: Date,
	timeZone = "UTC",
): string[] {
	const raw = (existingRecurrence ?? []).find((r) =>
		r.toUpperCase().startsWith("RRULE:"),
	);
	if (!raw) {
		throw new Error("Cannot truncate: series master has no RRULE");
	}
	// Preserve exception dates and explicit dates while limiting every inclusion.
	const parsed = rrulestr(existingRecurrence!.join("\n"), {
		forceset: true,
	}) as RRuleSet;
	const result = new RRuleSet();
	if (parsed.tzid()) result.tzid(parsed.tzid());
	for (const rule of parsed.rrules()) {
		const options = rule.origOptions;
		let limit = options.until && options.until < until ? options.until : until;
		if (options.count != null) {
			const anchor = dtstart ?? options.dtstart;
			if (!anchor)
				throw new Error(
					"Cannot truncate a COUNT-based series without its start time",
				);
			const floating = (date: Date) => {
				const wall = formatInTimezone(date.toISOString(), timeZone);
				return new Date(
					Date.UTC(
						wall.year,
						wall.month - 1,
						wall.day,
						wall.hours,
						wall.minutes,
						date.getUTCSeconds(),
						date.getUTCMilliseconds(),
					),
				);
			};
			const normalized = validateRRule(
				rule
					.toString()
					.split("\n")
					.find((line) => line.startsWith("RRULE:")) ?? "",
			);
			let last: Date | undefined;
			let visited = 0;
			new RRule({
				...RRule.parseString(normalized),
				dtstart: floating(anchor),
				tzid: null,
				until: floating(limit),
			}).all((wall) => {
				if (++visited > 100000) return false;
				try {
					const instant = new Date(
						Date.parse(
							zonedTimeToUtc(
								wall.toISOString().slice(0, 10),
								wall.getUTCHours(),
								wall.getUTCMinutes(),
								timeZone,
								"first",
							),
						) +
							wall.getUTCSeconds() * 1000 +
							wall.getUTCMilliseconds(),
					);
					if (instant <= limit) last = instant;
				} catch (error) {
					if (!(error instanceof DSTGapError)) throw error;
				}
				return true;
			});
			if (visited > 100000)
				throw new Error(
					"Cannot truncate: recurrence exceeds the safe expansion limit",
				);
			if (!last)
				throw new Error(
					"Cannot truncate before the first occurrence; delete the series instead",
				);
			limit = last;
		}
		result.rrule(new RRule({ ...options, count: null, until: limit }));
	}
	for (const rule of parsed.exrules()) result.exrule(rule);
	for (const date of parsed.exdates()) result.exdate(date);
	for (const date of parsed.rdates()) if (date <= until) result.rdate(date);
	return result.valueOf();
}
