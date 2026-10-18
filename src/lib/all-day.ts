import { parseCalendarDate } from "./timezone";

/** Date spans use a civil start and exclusive civil end; no timezone conversion. */
export function addCivilDays(date: string, days: number): string {
	parseCalendarDate(date);
	const instant = new Date(`${date}T00:00:00Z`);
	instant.setUTCDate(instant.getUTCDate() + days);
	return instant.toISOString().slice(0, 10);
}

export function allDaySpan(
	start: string,
	end?: string,
): { start_date: string; end_date: string } {
	parseCalendarDate(start);
	const exclusiveEnd = end ?? addCivilDays(start, 1);
	parseCalendarDate(exclusiveEnd);
	if (exclusiveEnd <= start)
		throw new Error("--end-date must be after --date (exclusive end)");
	return { start_date: start, end_date: exclusiveEnd };
}

/** A move preserves calendar-day length, including across DST transitions. */
export function moveAllDaySpan(
	start: string,
	end: string,
	newStart?: string,
	newEnd?: string,
) {
	allDaySpan(start, end);
	const dayCount =
		(Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
		86400000;
	const nextStart = newStart ?? start;
	return allDaySpan(nextStart, newEnd ?? addCivilDays(nextStart, dayCount));
}
