import { parse } from "chrono-node";
import { strictBoundarySelector, strictDaySelector } from "../date-selector";
import {
	DSTGapError,
	formatInTimezone,
	parseCalendarDate,
	validateTimezone,
	zonedTimeToUtc,
} from "../timezone";
import { ReconcileError, type ReconcileWindow, type RecordTime } from "./types";

export interface WindowArgs {
	today?: boolean;
	tomorrow?: boolean;
	date?: string;
	from?: string;
	to?: string;
}

export function addCalendarDays(date: string, days: number): string {
	const { year, month, day } = parseCalendarDate(date);
	const civil = new Date(0);
	civil.setUTCFullYear(year, month - 1, day + days);
	return civil.toISOString().slice(0, 10);
}

/** A DST change can skip midnight itself; use the civil day's first instant. */
export function calendarDayStartUtc(date: string, timezone: string): string {
	for (let minute = 0; minute < 1440; minute++) {
		try {
			return zonedTimeToUtc(
				date,
				Math.floor(minute / 60),
				minute % 60,
				timezone,
				"first",
			);
		} catch (error) {
			if (!(error instanceof DSTGapError)) throw error;
		}
	}
	throw new ReconcileError(
		`Calendar day ${date} does not exist in ${timezone}`,
		2,
		"invalid_window",
	);
}

/** Strict existing day vocabulary, with wall-clock inputs excluded in v1. */
function selectDay(
	value: string,
	selector: "date" | "from" | "to",
	reference: Date,
): string {
	const text = value.trim();
	if (selector === "date") strictDaySelector(text, reference);
	else
		strictBoundarySelector(
			text,
			selector === "from" ? "start" : "end",
			reference,
		);
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		parseCalendarDate(text);
		return text;
	}
	const result = parse(text, reference, { forwardDate: true })[0];
	if (
		!result ||
		result.end ||
		result.start.isCertain("hour") ||
		result.start.isCertain("minute") ||
		/\d{4}-\d{2}-\d{2}T/.test(text)
	) {
		throw new ReconcileError(
			`--${selector} requires a day, without a timestamp or time of day`,
			2,
			"invalid_window",
		);
	}
	return `${String(result.start.get("year")).padStart(4, "0")}-${String(result.start.get("month")).padStart(2, "0")}-${String(result.start.get("day")).padStart(2, "0")}`;
}

/** Pure and host independent: chrono sees a synthetic local civil reference. */
export function resolveReconcileWindow(
	args: WindowArgs,
	now: Date,
	timezone: string,
): ReconcileWindow {
	try {
		validateTimezone(timezone);
		const families =
			Number(!!args.today) +
			Number(!!args.tomorrow) +
			Number(args.date !== undefined) +
			Number(args.from !== undefined || args.to !== undefined);
		if (families > 1)
			throw new Error(
				"Choose one of --today, --tomorrow, --date, or --from/--to",
			);
		if ((args.from === undefined) !== (args.to === undefined))
			throw new Error("Both --from and --to are required");
		const civil = formatInTimezone(now.toISOString(), timezone);
		const reference = new Date(
			civil.year,
			civil.month - 1,
			civil.day,
			civil.hours,
			civil.minutes,
		);
		const today = `${civil.year}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`;
		const first =
			args.from !== undefined
				? selectDay(args.from, "from", reference)
				: args.date !== undefined
					? selectDay(args.date, "date", reference)
					: args.tomorrow
						? addCalendarDays(today, 1)
						: today;
		const last =
			args.to !== undefined ? selectDay(args.to, "to", reference) : first;
		const days =
			(Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
				86400000 +
			1;
		if (days < 1 || days > 31)
			throw new Error(
				"Reconcile requires an ordered window of at most 31 local calendar days",
			);
		return {
			start: calendarDayStartUtc(first, timezone),
			end: calendarDayStartUtc(addCalendarDays(last, 1), timezone),
			timezone,
			end_exclusive: true,
		};
	} catch (error) {
		throw new ReconcileError(
			error instanceof Error ? error.message : String(error),
			2,
			"invalid_window",
		);
	}
}

export function intersectsWindow(
	time: RecordTime,
	window: ReconcileWindow,
	calendarTimezone: string,
): boolean | null {
	if (time.kind === "unknown") return null;
	const start = Date.parse(
		time.kind === "timed"
			? time.start
			: calendarDayStartUtc(time.start_date, calendarTimezone),
	);
	const end = Date.parse(
		time.kind === "timed"
			? (time.end ?? time.start)
			: calendarDayStartUtc(time.end_date_exclusive, calendarTimezone),
	);
	const from = Date.parse(window.start);
	const to = Date.parse(window.end);
	return start === end ? start >= from && start < to : end > from && start < to;
}
