/**
 * Timezone-aware date/time primitives for scheduling.
 *
 * All scheduling inputs (dates, times) are interpreted in an explicit IANA
 * timezone. This module provides:
 *
 * - Validation of IANA timezone names
 * - Conversion of wall-clock times to UTC instants with DST gap/fold detection
 * - Calendar-date validation (rejects 2026-02-30 instead of rolling over)
 * - Timezone-aware date arithmetic for snooze/plan operations
 *
 * Design principles:
 * - Never silently shift times across DST transitions
 * - DST gaps (nonexistent times) are rejected with clear errors
 * - DST folds (ambiguous times) require an explicit choice
 * - UTC host and LA host produce identical instants for identical inputs
 */

export class InvalidTimezoneError extends Error {
	constructor(timezone: string) {
		super(
			`Invalid timezone "${timezone}". Expected a valid IANA timezone name (e.g., "America/Los_Angeles", "UTC").`,
		);
		this.name = "InvalidTimezoneError";
	}
}

export class InvalidCalendarDateError extends Error {
	constructor(dateStr: string) {
		super(
			`Invalid calendar date "${dateStr}". Expected a real date in YYYY-MM-DD format (e.g., 2026-02-30 does not exist).`,
		);
		this.name = "InvalidCalendarDateError";
	}
}

export class DSTGapError extends Error {
	constructor(dateStr: string, timeStr: string, timezone: string) {
		super(
			`The local time ${timeStr} on ${dateStr} does not exist in ${timezone} ` +
				`(DST spring-forward gap). Please choose a different time, e.g., ` +
				`--at 03:30 instead of --at 02:30 on this date.`,
		);
		this.name = "DSTGapError";
	}
}

export class DSTFoldError extends Error {
	constructor(dateStr: string, timeStr: string, timezone: string) {
		super(
			`The local time ${timeStr} on ${dateStr} is ambiguous in ${timezone} ` +
				`(DST fall-back fold; it occurs twice). ` +
				`Please specify --fold first (before the transition) or --fold second (after the transition).`,
		);
		this.name = "DSTFoldError";
	}
}

/**
 * Validate that a string is a valid IANA timezone name.
 * Throws InvalidTimezoneError if invalid.
 */
export function validateTimezone(timezone: string): string {
	try {
		// This will throw RangeError for invalid timezones
		Intl.DateTimeFormat(undefined, { timeZone: timezone });
		return timezone;
	} catch {
		throw new InvalidTimezoneError(timezone);
	}
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDate {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
}

/**
 * Parse and validate a YYYY-MM-DD date string.
 * Rejects nonexistent dates like 2026-02-30 (no rollover).
 * Throws InvalidCalendarDateError if invalid.
 */
export function parseCalendarDate(dateStr: string): CalendarDate {
	const match = dateStr.match(ISO_DATE_RE);
	if (!match) {
		throw new InvalidCalendarDateError(dateStr);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);

	// Validate month
	if (month < 1 || month > 12) {
		throw new InvalidCalendarDateError(dateStr);
	}

	// Validate day against month length (handles leap years)
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (day < 1 || day > daysInMonth) {
		throw new InvalidCalendarDateError(dateStr);
	}

	return { year, month, day };
}

/**
 * Get the UTC offset in minutes for a given UTC instant in a timezone.
 * Uses Intl.DateTimeFormat to compute the offset.
 */
function getOffsetMinutes(utcMillis: number, timeZone: string): number {
	const date = new Date(utcMillis);
	// Format the UTC time in the target timezone, then parse back
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = formatter.formatToParts(date);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");

	// Note: hour can be "24" for midnight in some locales; normalize
	let hour = get("hour");
	if (hour === 24) hour = 0;

	const wallMillis = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		hour,
		get("minute"),
		get("second"),
	);
	return Math.round((wallMillis - utcMillis) / 60000);
}

/**
 * Format a UTC instant as wall-clock time in a timezone.
 * Returns {year, month, day, hours, minutes}.
 */
export function formatInTimezone(
	utcIso: string,
	timeZone: string,
): {
	year: number;
	month: number;
	day: number;
	hours: number;
	minutes: number;
} {
	validateTimezone(timeZone);
	const utcMillis = new Date(utcIso).getTime();
	if (Number.isNaN(utcMillis)) {
		throw new Error(`Invalid UTC datetime: "${utcIso}"`);
	}
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const parts = formatter.formatToParts(new Date(utcMillis));
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	let hours = get("hour");
	if (hours === 24) hours = 0;
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hours,
		minutes: get("minute"),
	};
}

/**
 * Convert a wall-clock date/time in an IANA timezone to a UTC ISO string.
 *
 * DST handling:
 * - If the local time does not exist (spring-forward gap), throws DSTGapError.
 * - If the local time is ambiguous (fall-back fold), throws DSTFoldError
 *   unless `fold` is specified ("first" = before transition, "second" = after).
 *
 * This function is host-timezone independent: UTC host and LA host produce
 * identical results for identical inputs.
 *
 * @param dateStr - YYYY-MM-DD date (validated, no rollover)
 * @param hours - 0-23
 * @param minutes - 0-59
 * @param timeZone - IANA timezone name
 * @param fold - Required if the time is ambiguous ("first"|"second")
 * @returns UTC ISO datetime string
 */
export function zonedTimeToUtc(
	dateStr: string,
	hours: number,
	minutes: number,
	timeZone: string,
	fold?: "first" | "second",
): string {
	validateTimezone(timeZone);
	const { year, month, day } = parseCalendarDate(dateStr);

	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
		throw new Error(
			`Invalid time ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}. ` +
				`Expected HH:MM with hours 0-23 and minutes 0-59.`,
		);
	}

	const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

	// Find all valid UTC instants for this wall time.
	// During a fold, there are two; normally one; during a gap, zero.
	const candidates = findUtcCandidates(
		year,
		month,
		day,
		hours,
		minutes,
		timeZone,
	);

	if (candidates.length === 0) {
		throw new DSTGapError(dateStr, timeStr, timeZone);
	}

	if (candidates.length === 2) {
		if (!fold) {
			throw new DSTFoldError(dateStr, timeStr, timeZone);
		}
		// "first" = earlier UTC instant (before the transition)
		// "second" = later UTC instant (after the transition)
		const sorted = [...candidates].sort((a, b) => a - b);
		const chosen = fold === "first" ? sorted[0]! : sorted[1]!;
		return new Date(chosen).toISOString();
	}

	return new Date(candidates[0]!).toISOString();
}

/**
 * Find all UTC instants (in millis) that correspond to a wall-clock time.
 * Returns 0 (gap), 1 (normal), or 2 (fold) candidates.
 */
function findUtcCandidates(
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes: number,
	timeZone: string,
): number[] {
	const candidates: number[] = [];

	// Sample offsets around the target date to find possible offsets.
	// We check noon UTC on the target date and adjacent days to catch transitions.
	const samplePoints = [
		Date.UTC(year, month - 1, day, 12, 0, 0),
		Date.UTC(year, month - 1, day - 1, 12, 0, 0),
		Date.UTC(year, month - 1, day + 1, 12, 0, 0),
	];
	const offsets = new Set<number>();
	for (const point of samplePoints) {
		offsets.add(getOffsetMinutes(point, timeZone));
	}

	// For each possible offset, compute the UTC candidate and verify it.
	for (const offset of offsets) {
		// wall time = UTC + offset  =>  UTC = wall time - offset
		const wallAsUtc = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
		const utcCandidate = wallAsUtc - offset * 60000;

		// Verify: format the candidate back in the timezone and check it matches
		const formatted = formatInTimezone(
			new Date(utcCandidate).toISOString(),
			timeZone,
		);
		if (
			formatted.year === year &&
			formatted.month === month &&
			formatted.day === day &&
			formatted.hours === hours &&
			formatted.minutes === minutes
		) {
			// Deduplicate (same instant found via different offsets)
			if (!candidates.some((c) => Math.abs(c - utcCandidate) < 60000)) {
				candidates.push(utcCandidate);
			}
		}
	}

	return candidates.sort((a, b) => a - b);
}

/**
 * Add calendar days to a UTC instant, preserving wall-clock time in a timezone.
 * Used for snooze with day/week units (wall-day basis).
 *
 * For example: 2026-03-07 09:00 America/Los_Angeles + 1 day =
 *              2026-03-08 09:00 America/Los_Angeles
 * (which is 23 hours later in UTC due to spring-forward, but 09:00 wall-clock
 * is preserved).
 *
 * @param utcIso - UTC ISO datetime string
 * @param days - Number of calendar days to add (can be negative)
 * @param timeZone - IANA timezone for wall-clock arithmetic
 * @param fold - Fold disambiguation if the result lands in a fold
 * @returns UTC ISO datetime string
 */
export function addCalendarDays(
	utcIso: string,
	days: number,
	timeZone: string,
	fold?: "first" | "second",
): string {
	validateTimezone(timeZone);
	const wall = formatInTimezone(utcIso, timeZone);

	// Add days in wall-clock space
	const wallDate = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
	wallDate.setUTCDate(wallDate.getUTCDate() + days);

	const newYear = wallDate.getUTCFullYear();
	const newMonth = wallDate.getUTCMonth() + 1;
	const newDay = wallDate.getUTCDate();
	const dateStr = `${newYear}-${String(newMonth).padStart(2, "0")}-${String(newDay).padStart(2, "0")}`;

	return zonedTimeToUtc(dateStr, wall.hours, wall.minutes, timeZone, fold);
}

/**
 * Add elapsed milliseconds to a UTC instant.
 * Used for snooze with minute/hour units (elapsed basis).
 */
export function addElapsedMillis(utcIso: string, millis: number): string {
	const utcMillis = new Date(utcIso).getTime();
	if (Number.isNaN(utcMillis)) {
		throw new Error(`Invalid UTC datetime: "${utcIso}"`);
	}
	return new Date(utcMillis + millis).toISOString();
}

/**
 * Get the YYYY-MM-DD date string for a UTC instant in a timezone.
 */
export function utcToDateString(utcIso: string, timeZone: string): string {
	const wall = formatInTimezone(utcIso, timeZone);
	return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}
