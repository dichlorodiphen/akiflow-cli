import { RRule, type RRuleSet, rrulestr } from "rrule";
import type { Event } from "./api/types";
import { filterEvents } from "./filters/event";
import { DSTGapError, parseCalendarDate, zonedTimeToUtc } from "./timezone";

const DAY = 86_400_000;
const MAX_OCCURRENCES = 1000;
// Bound work even for an old SECONDLY master with a distant query window.
const MAX_VISITED = 100_000;

function instant(value: string | null): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

/** Floating UTC fields represent local wall time, independent of the host TZ. */
function wallTime(date: Date, timeZone: string): Date {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	return new Date(
		Date.UTC(
			get("year"),
			get("month") - 1,
			get("day"),
			get("hour"),
			get("minute"),
			get("second"),
			date.getUTCMilliseconds(),
		),
	);
}

function dateOnly(value: string): Date {
	const { year, month, day } = parseCalendarDate(value);
	return new Date(Date.UTC(year, month - 1, day));
}

function slotKey(event: Event): string | null {
	const time = instant(event.original_start_time ?? event.start_time);
	const slot =
		time?.toISOString() ?? event.original_start_date ?? event.start_date;
	return event.recurring_id && slot ? `${event.recurring_id}|${slot}` : null;
}

/** Original-slot evidence includes hidden, cancelled and deleted exceptions. */
export function coveredRecurringSlots(events: Event[]): Set<string> {
	const covered = new Set<string>();
	for (const event of events) {
		if (event.recurring_id === event.id) continue;
		const key = slotKey(event);
		if (key) covered.add(key);
	}
	return covered;
}

export function isRecurringEventMaster(event: Event): boolean {
	return (
		event.recurring_id === event.id &&
		Array.isArray(event.recurrence) &&
		event.recurrence.length > 0
	);
}

/**
 * Pure, bounded RRULE expansion. `evidence` retains records removed by visibility
 * filtering, including tombstones and masters whose anchor is already covered.
 * No snapshot records are changed. Missing bounds use a 366-day horizon; at
 * most 1000 slots per series and 100000 rule candidates are examined.
 */
export function expandRecurringEvents(
	events: Event[],
	from?: Date,
	to?: Date,
	evidence: Event[] = events,
): Event[] {
	const covered = coveredRecurringSlots(evidence);
	const visible = new Set(
		filterEvents(events, { includeDeclined: true }).map((e) => e.id),
	);
	const result: Event[] = [];
	for (const master of evidence) {
		if (
			!isRecurringEventMaster(master) ||
			master.deleted_at != null ||
			master.status === "cancelled" ||
			master.recurrence_exception_delete
		)
			continue;
		try {
			const allDay = master.start_date != null;
			const zone = allDay ? "UTC" : master.start_datetime_tz || "UTC";
			const anchor = allDay
				? dateOnly(master.start_date ?? "")
				: instant(master.start_time);
			if (!anchor) continue;
			const end = allDay
				? dateOnly(master.end_date ?? master.start_date ?? "")
				: instant(master.end_time);
			const duration = end ? end.getTime() - anchor.getTime() : 0;
			if (duration < 0) continue;
			const lower = from ?? anchor;
			const upper = to ?? new Date(lower.getTime() + 366 * DAY);
			if (
				!Number.isFinite(lower.getTime()) ||
				!Number.isFinite(upper.getTime()) ||
				lower > upper
			)
				continue;
			const start = allDay ? anchor : wallTime(anchor, zone);
			const parsed = rrulestr((master.recurrence ?? []).join("\n"), {
				forceset: true,
			}) as RRuleSet;
			// EXRULE is obsolete and can make exclusion work unbounded; leave such
			// series to materialized records rather than partially interpreting it.
			if (parsed.exrules().length) continue;
			const exclusions = new Set(
				parsed.exdates().map((d) => (allDay ? d : wallTime(d, zone)).getTime()),
			);
			const slots = new Map<number, Date>();
			const overlapDuration = allDay ? duration + DAY : duration;
			const earliestWall = new Date(
				wallTime(new Date(lower.getTime() - overlapDuration), zone).getTime() -
					DAY,
			);
			let visited = 0;
			const collect = (wall: Date): boolean => {
				if (++visited > MAX_VISITED || slots.size >= MAX_OCCURRENCES)
					return false;
				if (wall < earliestWall || exclusions.has(wall.getTime())) return true;
				let slot: Date;
				try {
					slot = allDay
						? wall
						: new Date(
								new Date(
									zonedTimeToUtc(
										wall.toISOString().slice(0, 10),
										wall.getUTCHours(),
										wall.getUTCMinutes(),
										zone,
										"first",
									),
								).getTime() +
									wall.getUTCSeconds() * 1000 +
									wall.getUTCMilliseconds(),
							);
				} catch (error) {
					if (error instanceof DSTGapError) return true;
					throw error;
				}
				// Include starts before `from` that can overlap the query window.
				if (
					slot.getTime() >= lower.getTime() - overlapDuration &&
					slot <= upper &&
					slot >= anchor
				) {
					slots.set(slot.getTime(), slot);
				}
				return slot <= upper;
			};
			for (const rule of parsed.rrules()) {
				const options = rule.origOptions;
				const until =
					options.until && !allDay
						? wallTime(options.until, zone)
						: options.until;
				// A wall-time upper bound also stops rules with no matching dates.
				const ceiling = new Date(wallTime(upper, zone).getTime() + DAY);
				new RRule(
					{
						...options,
						dtstart: start,
						tzid: null,
						until: until && until < ceiling ? until : ceiling,
					},
					true,
				).all((wall) => collect(wall));
			}
			for (const date of parsed.rdates()) {
				if (visited >= MAX_VISITED || slots.size >= MAX_OCCURRENCES) break;
				collect(allDay ? date : wallTime(date, zone));
			}
			for (const slot of [...slots.values()].sort(
				(a, b) => a.getTime() - b.getTime(),
			)) {
				const slotIso = slot.toISOString();
				const slotDate = slotIso.slice(0, 10);
				if (covered.has(`${master.id}|${allDay ? slotDate : slotIso}`))
					continue;
				if (slot.getTime() === anchor.getTime() && visible.has(master.id))
					continue;
				result.push({
					...master,
					id: `virtual:recurrence:${master.id}:${slotIso}`,
					recurrence: null,
					recurring_id: master.id,
					original_start_time: allDay ? null : slotIso,
					original_start_date: allDay ? slotDate : null,
					recurrence_exception: false,
					recurrence_exception_delete: null,
					hidden: false,
					status: "confirmed",
					start_time: allDay ? null : slotIso,
					end_time:
						allDay || !end
							? null
							: new Date(slot.getTime() + duration).toISOString(),
					start_date: allDay ? slotDate : null,
					end_date: allDay
						? new Date(slot.getTime() + duration).toISOString().slice(0, 10)
						: null,
				});
			}
		} catch {
			// Malformed cached recurrence/timezone data must not break the read.
		}
	}
	return result;
}
