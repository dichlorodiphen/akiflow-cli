import { expect, test } from "bun:test";
import { auditDiscrepancies, auditStatusCounts } from "../../lib/audit";
import { deduplicateOccurrences, markPossibleEchoes } from "../../lib/capacity";
import {
	attachProvenance,
	normalizeTask,
	queryOccurrences,
	queryOccurrencesWithRaw,
} from "../../lib/occurrence";
import { minimumMinutes, occurrenceRange } from "../../lib/occurrence-read";
import { buildReviewEnvelope } from "../../lib/review-envelope";
import { event, instant, occurrence, slot, task } from "./occurrence-fixtures";

test("provenance is immutable, preserves provider identity, and reserves pending false", () => {
	const original = occurrence({ origin_id: "provider" });
	const result = attachProvenance([original], {
		observedAt: instant(8).toISOString(),
		generation: "gen-42",
	})[0]!;
	expect(result.provenance).toEqual({
		origin_id: "provider",
		origin_account_id: null,
		observedAt: instant(8).toISOString(),
		generation: "gen-42",
		pending: false,
	});
	expect(original.provenance.observedAt).toBeNull();
	expect(original.provenance.generation).toBeNull();
	expect(original.provenance.pending).toBe(false);
});
test("calendarIds ANY visibility plus active calendar exclusion and explicit hidden selection", () => {
	const input = {
		events: [
			event(),
			event({ id: "hidden", calendar_id: "hidden" }),
			event({ id: "deleted", calendar_id: "deleted" }),
			event({ id: "other", calendar_id: "other" }),
			event({ id: "hidden-record", hidden: true }),
		],
		slots: [slot()],
		tasks: [task()],
	};
	const visibility = {
		calendarIds: ["cal", "other"],
		activeCalendarIds: ["cal", "other", "hidden"],
	};
	expect(queryOccurrences(input, visibility).map((o) => o.id)).toEqual([
		"e",
		"other",
		"s",
		"t",
	]);
	expect(
		queryOccurrences(input, { ...visibility, calendarId: "hidden" }).map(
			(o) => o.id,
		),
	).toEqual(["hidden"]);
	expect(
		queryOccurrences(input, { ...visibility, calendarId: "deleted" }),
	).toEqual([]);
	expect(queryOccurrences(input, { calendarIds: [] })).toEqual([]);
});
test("raw pairs keep original records and never serialize raw into occurrence", () => {
	const raw = slot({ description: "original" });
	const pair = queryOccurrencesWithRaw({ slots: [raw] })[0]!;
	expect(pair.raw).toBe(raw);
	expect(pair.occurrence.source).toBe("slot");
	expect("raw" in pair.occurrence).toBe(false);
});
test("review envelope includes ISO generation time, local timezone and observation provenance", () => {
	const result = buildReviewEnvelope(
		[occurrence()],
		{ start: instant(8).getTime(), end: instant(12).getTime() },
		0,
		{ generation: "gen-7", observed_at: instant(7).toISOString() },
	);
	expect(Number.isFinite(Date.parse(result.generated_at))).toBe(true);
	expect(result.timezone).toBe(
		Intl.DateTimeFormat().resolvedOptions().timeZone,
	);
	expect(result.provenance).toEqual({
		generation: "gen-7",
		observed_at: instant(7).toISOString(),
	});
});
test("audit chooses earliest provider echo, retains native tasks, and lists divergent event owner links", () => {
	const input = [
		occurrence({
			id: "late",
			origin_id: "same",
			start_time: instant(10).toISOString(),
			end_time: instant(12).toISOString(),
		}),
		occurrence({
			id: "early-z",
			origin_id: "same",
			start_time: instant(9).toISOString(),
			end_time: instant(11).toISOString(),
		}),
		occurrence({
			id: "early",
			origin_id: "same",
			end_time: instant(11).toISOString(),
			task_id: "t",
			time_slot_id: "s",
		}),
		normalizeTask(task({ datetime: instant(14).toISOString() }))!,
		queryOccurrences({
			slots: [
				slot({
					start_time: instant(15).toISOString(),
					end_time: instant(16).toISOString(),
				}),
			],
		})[0]!,
	];
	const result = auditDiscrepancies(input);
	expect(result.possible_echo_groups).toHaveLength(1);
	expect(result.possible_echo_groups[0]!.suggested_canonical.id).toBe("early");
	expect(result.possible_echo_groups[0]!.members.map((o) => o.id)).toEqual([
		"late",
		"early-z",
		"early",
	]);
	expect(result.owner_overrides).toHaveLength(2);
	expect(result.link_divergences).toHaveLength(2);
	expect(
		markPossibleEchoes(
			deduplicateOccurrences([
				occurrence({ origin_id: "same" }),
				normalizeTask(task({ origin_id: null }))!,
			]),
		)[1]!.possibleEchoGroup,
	).toBeNull();
	const overlapping = auditDiscrepancies([
		occurrence({ task_id: "t" }),
		normalizeTask(task())!,
	]);
	expect(overlapping.owner_overrides).toHaveLength(1);
	expect(overlapping.link_divergences).toEqual([]);
});
test("audit status counts compare scoped observations to effective visibility", () => {
	const input = {
		events: [
			event({ status: "cancelled" }),
			event({ id: "declined", declined: true }),
		],
		tasks: [task({ done: true }), task({ id: "trash", trashed_at: "now" })],
	};
	expect(auditStatusCounts(input, {}, queryOccurrences(input))).toEqual({
		cancelled: { seen: 1, excluded: 1 },
		declined: { seen: 1, excluded: 1 },
		done: { seen: 1, excluded: 1 },
		trashed: { seen: 1, excluded: 1 },
	});
});
test("read ranges are half open local days and durations validate", () => {
	const range = occurrenceRange({ date: "2026-06-20" });
	expect(range.from).toEqual(new Date(2026, 5, 20));
	expect(range.to).toEqual(new Date(2026, 5, 21));
	expect(minimumMinutes({})).toBe(0);
	expect(minimumMinutes({ "min-duration": "30m" })).toBe(30);
	expect(() => minimumMinutes({ "min-duration": "garbage" })).toThrow();
});
