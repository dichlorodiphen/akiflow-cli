import { parseDate as chronoParseDate } from "chrono-node";

/**
 * Parse natural language date string to ISO date format (YYYY-MM-DD).
 * Supports: "today", "tomorrow", "next monday", "next friday", "in 3 days", "next week"
 *
 * @param dateString - Natural language date string
 * @param now - Reference "now" for parsing. Defaults to the current time;
 *              tests pass a fixed Date to keep assertions deterministic.
 * @returns ISO date string (YYYY-MM-DD) or null if parsing fails
 */
export function parseDate(
	dateString: string,
	now: Date = new Date(),
): string | null {
	const result = chronoParseDate(dateString, now, { forwardDate: true });

	if (!result) {
		return null;
	}

	const year = result.getFullYear();
	const month = String(result.getMonth() + 1).padStart(2, "0");
	const day = String(result.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

/**
 * Get today's date in ISO format (YYYY-MM-DD).
 *
 * @param now - Reference "now". Defaults to the current time; tests pass
 *              a fixed Date to keep assertions deterministic.
 * @returns Today's date as ISO string
 */
export function getTodayDate(now: Date = new Date()): string {
	return formatLocalDate(now);
}

/**
 * Get tomorrow's date in ISO format (YYYY-MM-DD).
 *
 * @param now - Reference "now". Defaults to the current time; tests pass
 *              a fixed Date to keep assertions deterministic.
 * @returns Tomorrow's date as ISO string
 */
export function getTomorrowDate(now: Date = new Date()): string {
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);

	return formatLocalDate(tomorrow);
}

/**
 * Parse time string (HH:MM or H:MM format) to hours and minutes.
 *
 * @param timeString - Time string (e.g., "21:00", "9:30", "14:30")
 * @returns Object with hours and minutes, or null if parsing fails
 */
export function parseTime(
	timeString: string,
): { hours: number; minutes: number } | null {
	const trimmed = timeString.trim();
	const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);

	if (!match) {
		return null;
	}

	const hours = parseInt(match[1]!, 10);
	const minutes = parseInt(match[2]!, 10);

	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
		return null;
	}

	return { hours, minutes };
}

/**
 * Create UTC datetime string from date and time.
 *
 * @param dateString - ISO date string (YYYY-MM-DD)
 * @param hours - Hours (0-23)
 * @param minutes - Minutes (0-59)
 * @returns UTC ISO datetime string
 */
export function createDateTimeUTC(
	dateString: string,
	hours: number,
	minutes: number,
): string {
	const [year, month, day] = dateString.split("-").map(Number);
	const localDate = new Date(year!, month! - 1, day!, hours, minutes, 0, 0);
	return localDate.toISOString();
}

/**
 * Get local timezone identifier.
 *
 * @returns IANA timezone string (e.g., "Asia/Seoul")
 */
export function getLocalTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ============================================================
// Named ranges + month parsing (added in fork v0.1 for ls/cal filters)
// ============================================================

export type NamedRange =
	| "today"
	| "tomorrow"
	| "yesterday"
	| "this-week"
	| "next-week"
	| "this-month"
	| "next-month";

export interface DateRange {
	from: Date;
	to: Date;
}

const ISO_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const startOfDay = (d: Date): Date =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
export const endOfDay = (d: Date): Date =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export function isLocalDateString(value: string): boolean {
	return ISO_LOCAL_DATE.test(value);
}

export function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Parse an API date-only value as a local calendar day. Date-only strings
 * must not use new Date("YYYY-MM-DD"), which JavaScript interprets as UTC.
 */
export function parseLocalDate(value: string): Date | null {
	const match = value.match(ISO_LOCAL_DATE);
	if (!match) return null;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(year, month - 1, day, 0, 0, 0, 0);

	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day
	) {
		return null;
	}

	return date;
}

export function parseDateBoundary(
	value: string,
	boundary: "start" | "end",
	now: Date = new Date(),
): Date | null {
	const localDate = parseLocalDate(value);
	if (localDate) {
		return boundary === "start" ? startOfDay(localDate) : endOfDay(localDate);
	}

	const instant = new Date(value);
	if (!Number.isNaN(instant.getTime())) return instant;

	const parsedDate = parseDate(value, now);
	if (parsedDate) {
		const parsedLocalDate = parseLocalDate(parsedDate);
		if (parsedLocalDate) {
			return boundary === "start"
				? startOfDay(parsedLocalDate)
				: endOfDay(parsedLocalDate);
		}
	}

	return null;
}

export function resolveSingleDayRange(
	value: string,
	now: Date = new Date(),
): DateRange | null {
	const start = parseDateBoundary(value, "start", now);
	if (!start) return null;

	const localDate =
		parseLocalDate(value) ?? parseLocalDate(parseDate(value, now) ?? "");
	if (localDate) {
		return { from: startOfDay(localDate), to: endOfDay(localDate) };
	}

	return { from: startOfDay(start), to: endOfDay(start) };
}

/**
 * Resolve a named range to a {from, to} pair (local time). Week starts on
 * Monday (ISO 8601).
 */
export function resolveRange(
	name: NamedRange,
	now: Date = new Date(),
): DateRange {
	switch (name) {
		case "today":
			return { from: startOfDay(now), to: endOfDay(now) };
		case "tomorrow": {
			const t = new Date(now);
			t.setDate(t.getDate() + 1);
			return { from: startOfDay(t), to: endOfDay(t) };
		}
		case "yesterday": {
			const y = new Date(now);
			y.setDate(y.getDate() - 1);
			return { from: startOfDay(y), to: endOfDay(y) };
		}
		case "this-week": {
			const dow = (now.getDay() + 6) % 7; // 0 = Monday
			const monday = new Date(now);
			monday.setDate(now.getDate() - dow);
			const sunday = new Date(monday);
			sunday.setDate(monday.getDate() + 6);
			return { from: startOfDay(monday), to: endOfDay(sunday) };
		}
		case "next-week": {
			const dow = (now.getDay() + 6) % 7;
			const monday = new Date(now);
			monday.setDate(now.getDate() - dow + 7);
			const sunday = new Date(monday);
			sunday.setDate(monday.getDate() + 6);
			return { from: startOfDay(monday), to: endOfDay(sunday) };
		}
		case "this-month": {
			const first = new Date(now.getFullYear(), now.getMonth(), 1);
			const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
			return { from: startOfDay(first), to: endOfDay(last) };
		}
		case "next-month": {
			const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
			const last = new Date(now.getFullYear(), now.getMonth() + 2, 0);
			return { from: startOfDay(first), to: endOfDay(last) };
		}
	}
}

const MONTH_NAMES = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

/**
 * Parse a month identifier into {year, month}. Accepts:
 *   "2026-05"      → { year: 2026, month: 5 }
 *   "may"          → { year: <now>, month: 5 }
 *   "may 2026"     → { year: 2026, month: 5 }
 */
export function parseMonth(
	input: string,
	now: Date = new Date(),
): { year: number; month: number } | null {
	const trimmed = input.trim().toLowerCase();
	const m1 = trimmed.match(/^(\d{4})-(\d{1,2})$/);
	if (m1) return { year: Number(m1[1]), month: Number(m1[2]) };
	const parts = trimmed.split(/\s+/);
	const monthIdx = MONTH_NAMES.findIndex((m) => parts[0]?.startsWith(m));
	if (monthIdx < 0) return null;
	const year = parts[1] ? Number(parts[1]) : now.getFullYear();
	return { year, month: monthIdx + 1 };
}
