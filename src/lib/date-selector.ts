import { parse as chronoParse } from "chrono-node";
import {
	type DateRange,
	endOfDay,
	parseDateBoundary,
	parseLocalDate,
	parseMonth,
	resolveSingleDayRange,
	startOfDay,
} from "./date-parser";

export class SelectorError extends Error {
	readonly exitCode = 2;
	constructor(value: string, selector: string) {
		super(`Invalid --${selector} selector "${value}"`);
		this.name = "SelectorError";
	}
}

/** Date selectors must consume the entire input and must never repair invalid dates. */
function validateDate(value: string, selector: string, now: Date): void {
	const text = value.trim();
	if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
		if (!parseLocalDate(text.slice(0, 10)))
			throw new SelectorError(value, selector);
		if (
			text.length === 10 ||
			(/^\d{4}-\d{2}-\d{2}T/.test(text) &&
				!Number.isNaN(new Date(text).getTime()))
		)
			return;
		throw new SelectorError(value, selector);
	}
	const results = chronoParse(text, now, { forwardDate: true });
	if (
		results.length !== 1 ||
		results[0]?.index !== 0 ||
		results[0]?.text.length !== text.length
	) {
		throw new SelectorError(value, selector);
	}
}

export function strictDaySelector(value: string, now = new Date()): DateRange {
	validateDate(value, "date", now);
	const range = resolveSingleDayRange(value.trim(), now);
	if (!range) throw new SelectorError(value, "date");
	return range;
}

export function strictBoundarySelector(
	value: string,
	boundary: "start" | "end",
	now = new Date(),
): Date {
	const selector = boundary === "start" ? "from" : "to";
	validateDate(value, selector, now);
	const date = parseDateBoundary(value.trim(), boundary, now);
	if (!date) throw new SelectorError(value, selector);
	return date;
}

export function strictMonthSelector(
	value: string,
	now = new Date(),
): DateRange {
	const text = value.trim();
	if (
		!/^(\d{4}-\d{1,2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?: \d{4})?)$/i.test(
			text,
		)
	)
		throw new SelectorError(value, "month");
	const month = parseMonth(text, now);
	if (
		!month ||
		!Number.isInteger(month.year) ||
		month.month < 1 ||
		month.month > 12
	)
		throw new SelectorError(value, "month");
	return {
		from: startOfDay(new Date(month.year, month.month - 1, 1)),
		to: endOfDay(new Date(month.year, month.month, 0)),
	};
}

export function validateDateSelectors(args: Record<string, unknown>): void {
	if (typeof args.date === "string") strictDaySelector(args.date);
	if (typeof args.from === "string") strictBoundarySelector(args.from, "start");
	if (typeof args.to === "string") strictBoundarySelector(args.to, "end");
	if (typeof args.month === "string") strictMonthSelector(args.month);
}
