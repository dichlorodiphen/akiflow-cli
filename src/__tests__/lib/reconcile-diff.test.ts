import { expect, test } from "bun:test";
import {
	detectDuplicateEvents,
	detectDuplicateRecords,
	detectPossibleReshapes,
	detectReshapeRecords,
} from "../../lib/event-duplicates";
import {
	buildReconcileReport,
	timedProjection,
} from "../../lib/reconcile/diff";
import {
	af,
	calendar,
	ge,
	normalizedA,
	normalizedG,
	now,
	report,
	selected,
	sources,
	window,
	workCalendar,
} from "./reconcile-fixtures";

test("server_present_cache_absent_reports_cache_gap", () => {
	expect(report([af()], [ge()]).tiers?.google_missing[0]).toMatchObject({
		reason: "cache_gap",
		server_presence: "present",
		cache_presence: "absent",
	});
});
test("unavailable_cache_creates_no_absence_claim", () => {
	expect(report([af()], [ge()], [], false).tiers?.google_missing).toHaveLength(
		0,
	);
	expect(report([], [ge()], [], false).tiers?.google_missing[0]).toMatchObject({
		reason: "server_gap",
		cache_presence: "unavailable",
	});
});
test("cache_only_record_stays_out_of_fresh_akiflow_tier", () => {
	const result = report([], [], [af()]);
	expect(result.tiers?.akiflow_missing_or_cancelled).toHaveLength(0);
	expect(result.cache_diagnostics[0]).toMatchObject({
		code: "cache_only_record",
		google_state: "unobserved",
	});
});
test("unmatched_read_only_record_is_possible_phantom", () => {
	expect(
		report([af("guest", { read_only: true })], []).tiers
			?.akiflow_missing_or_cancelled[0]?.possible_phantom,
	).toBe(true);
});
test("declined_counterpart_is_not_missing", () => {
	const result = report(
		[af()],
		[ge("g1", { attendees: [{ self: true, responseStatus: "declined" }] })],
	);
	expect(result.tiers?.akiflow_missing_or_cancelled).toHaveLength(0);
	expect(result.diagnostics[0]?.code).toBe("counterpart_excluded");
	expect(
		result.matches[0]?.differences.map((difference) => difference.field),
	).toEqual(["state"]);
});
test("identity-linked hidden records are excluded instead of absent", () => {
	const result = report([af("hidden", { hidden: true })], [ge()]);
	expect(result.tiers?.google_missing[0]).toMatchObject({
		server_presence: "excluded",
		reason: "excluded",
	});
});
test("identity collision proves presence, without choosing a writable copy", () => {
	const result = report(
		[af("a", { read_only: true }), af("b")],
		[ge()],
		[],
		false,
	);
	expect(result.tiers?.google_missing).toHaveLength(0);
	expect(result.tiers?.akiflow_missing_or_cancelled).toHaveLength(0);
	expect(
		result.tiers?.duplicates_or_overlaps.map((finding) => finding.kind),
	).toContain("identity_collision");
	expect(result.matches).toHaveLength(0);
});
test("akiflow_rrule_does_not_fill_missing_observations", () => {
	const result = report(
		[
			af("master", {
				origin_id: "series",
				recurring_id: "master",
				recurrence: ["RRULE:FREQ=DAILY"],
			}),
		],
		[
			ge("instance", {
				recurringEventId: "series",
				originalStartTime: { dateTime: "2026-10-01T03:00:00Z" },
				start: { dateTime: "2026-10-01T03:00:00Z" },
				summary: "Another day",
			}),
		],
	);
	expect(result.tiers?.google_missing).toHaveLength(1);
	expect(
		result.records.filter((record) => record.side === "akiflow"),
	).toHaveLength(1);
});

test.each([
	"A",
	"B",
])("Study fixture variant %s: matched_records_remain_detector_inputs", (variant) => {
	const first = af("study-1", { origin_id: "study-google-1" });
	const second = af("study-2", {
		origin_id: "study-google-2",
		start_time: "2026-10-01T02:45:00Z",
	});
	const google = [
		ge("study-google-1"),
		ge("study-google-2", { start: { dateTime: "2026-10-01T02:45:00Z" } }),
	];
	const result = report(variant === "A" ? [first] : [first, second], google, [
		first,
	]);
	expect(result.tiers?.google_missing).toHaveLength(1);
	expect(result.tiers?.google_missing[0]?.reason).toBe(
		variant === "A" ? "both_gap" : "cache_gap",
	);
	const duplicates = result.tiers?.duplicates_or_overlaps.filter(
		(finding) => finding.side === "google" && finding.kind === "duplicate",
	);
	expect(duplicates).toHaveLength(1);
	const members = result.records
		.filter((record) => duplicates?.[0]?.member_refs.includes(record.ref))
		.map((record) => record.id);
	expect(members).toEqual(["study-google-1", "study-google-2"]);
	expect(result.matches).toHaveLength(variant === "A" ? 1 : 2);
});

const corgi = ge("corgi", {
	summary: "Walk + feed corgi",
	start: { dateTime: "2026-10-01T00:45:00Z" },
	end: { dateTime: "2026-10-01T01:15:00Z" },
});
const tidus = ge("tidus", {
	summary: "Walk + feed Tidus",
	start: { dateTime: "2026-10-01T01:25:00Z" },
	end: { dateTime: "2026-10-01T01:55:00Z" },
});
const afTidus = af("tidus-a", {
	origin_id: "tidus",
	title: tidus.summary,
	start_time: tidus.start?.dateTime,
	end_time: tidus.end?.dateTime,
});
const afCorgi = af("corgi-a", {
	origin_id: "corgi",
	title: corgi.summary,
	start_time: corgi.start?.dateTime,
	end_time: corgi.end?.dateTime,
});
test("corgi/Tidus reshape without overlap, two shared tokens and ten-minute gap", () => {
	const result = report([], [corgi, tidus]);
	expect(result.tiers?.duplicates_or_overlaps).toHaveLength(0);
	expect(result.tiers?.possible_reshapes).toHaveLength(1);
	expect(result.tiers?.possible_reshapes[0]?.edges[0]).toMatchObject({
		shared_tokens: 2,
		jaccard: 0.5,
		gap_minutes: 10,
	});
});
test("corgi/Tidus split across Google-only old block and Akiflow-only replacement", () => {
	const result = report([afTidus], [corgi]);
	expect(result.tiers?.possible_reshapes).toHaveLength(1);
	expect(result.tiers?.possible_reshapes[0]).toMatchObject({
		side: "combined",
	});
	expect(result.tiers?.possible_reshapes[0]?.member_refs).toHaveLength(2);
});
test("corgi/Tidus mirrored variant collapses mirrors and merges equivalent findings", () => {
	const result = report([afCorgi, afTidus], [corgi, tidus]);
	expect(result.tiers?.possible_reshapes).toHaveLength(1);
	expect(result.tiers?.possible_reshapes[0]?.member_refs).toHaveLength(4);
	expect(report([afCorgi], [corgi]).tiers?.possible_reshapes).toHaveLength(0);
});
test("possible counterpart annotation survives cross-source reshape", () => {
	const a = { ...afCorgi, origin_id: "contradictory" };
	const result = report([a, afTidus], [corgi]);
	expect(
		result.diagnostics.some(
			(diagnostic) => diagnostic.code === "possible_counterpart",
		),
	).toBe(true);
	expect(
		result.tiers?.possible_reshapes.some(
			(group) => group.possible_counterpart_refs?.length,
		),
	).toBe(true);
});
test("reshape title or proximity below threshold does not qualify", () => {
	expect(
		report(
			[],
			[corgi, ge("other", { ...tidus, id: "other", summary: "Feed Tidus" })],
		).tiers?.possible_reshapes,
	).toHaveLength(0);
	expect(
		report(
			[],
			[
				corgi,
				ge("tidus", {
					...tidus,
					start: { dateTime: "2026-10-01T02:00:00Z" },
					end: { dateTime: "2026-10-01T02:30:00Z" },
				}),
			],
		).tiers?.possible_reshapes,
	).toHaveLength(0);
});

test("Dinner cancellations with no fresh Akiflow record remain visible", () => {
	const result = report(
		[],
		[
			ge("dinner-organizer", { summary: "Dinner", status: "cancelled" }),
			{ id: "dinner-sparse", status: "cancelled" },
		],
	);
	expect(result.cancelled_evidence).toHaveLength(2);
	expect(result.tiers?.google_missing).toHaveLength(0);
	expect(
		result.cancelled_evidence.find((record) => record.id === "dinner-sparse"),
	).toMatchObject({ title: null, time: { kind: "unknown" } });
});
test("organizer_and_guest_cancellations_remain_calendar_scoped", () => {
	const google = [
		...normalizedG([ge("dinner", { status: "cancelled", summary: "Dinner" })]),
		...normalizedG(
			[{ id: "dinner", status: "cancelled" }],
			workCalendar.origin_id,
		),
	];
	const noAkiflow = buildReconcileReport({
		records: google,
		window,
		selected,
		now,
		sources: sources(),
	});
	expect(noAkiflow.cancelled_evidence).toHaveLength(2);
	expect(noAkiflow.tiers?.google_missing).toHaveLength(0);
	const result = buildReconcileReport({
		records: [
			...normalizedA([af("organizer", { origin_id: "dinner" })]),
			...google,
		],
		window,
		selected,
		now,
		sources: sources(),
	});
	expect(result.cancelled_evidence).toHaveLength(2);
	expect(
		new Set(result.cancelled_evidence.map((record) => record.ref)).size,
	).toBe(2);
	expect(result.tiers?.akiflow_missing_or_cancelled[0]?.reason).toBe(
		"cancelled_on_google",
	);
	expect(result.matches).toHaveLength(1);
	expect(result.matches[0]?.calendar).toBe(calendar.origin_id);
});
test("provider ID not found is evidence and a series master is not an instance", () => {
	const record = normalizedA([af()]);
	const result = buildReconcileReport({
		records: record,
		window,
		selected,
		now,
		sources: sources(),
		notFound: [{ calendar: calendar.origin_id, id: "g1" }],
	});
	expect(result.tiers?.akiflow_missing_or_cancelled[0]?.reason).toBe(
		"provider_id_not_found",
	);
	const series = report(
		[af("a", { origin_id: "series", origin_recurring_id: "series" })],
		[ge("series", { recurrence: ["RRULE:FREQ=DAILY"] })],
	);
	expect(series.tiers?.akiflow_missing_or_cancelled[0]?.reason).toBe(
		"series_present_occurrence_unobserved",
	);
});
test("back_to_back_same_title_is_not_duplicate", () => {
	const result = report(
		[],
		[
			ge(),
			ge("g2", {
				start: { dateTime: "2026-10-01T04:30:00Z" },
				end: { dateTime: "2026-10-01T05:30:00Z" },
			}),
		],
	);
	expect(result.tiers?.duplicates_or_overlaps).toHaveLength(0);
});
test("transitive_groups_are_preserved", () => {
	const events = [
		ge("g1", { end: { dateTime: "2026-10-01T03:30:00Z" } }),
		ge("g2", {
			start: { dateTime: "2026-10-01T03:00:00Z" },
			end: { dateTime: "2026-10-01T04:00:00Z" },
		}),
		ge("g3", { start: { dateTime: "2026-10-01T03:45:00Z" } }),
	];
	const groups = report([], events).tiers?.duplicates_or_overlaps;
	expect(groups).toHaveLength(1);
	expect(groups?.[0]?.member_refs).toHaveLength(3);
	expect(groups?.[0]?.edges).toHaveLength(2);
});
test("neutral different-title overlap is reported once; all-day excluded from detectors", () => {
	const groups = report(
		[],
		[
			ge(),
			ge("meeting", { summary: "Meeting" }),
			ge("all-day", {
				start: { date: "2026-09-30" },
				end: { date: "2026-10-01" },
			}),
		],
	).tiers?.duplicates_or_overlaps;
	expect(groups).toHaveLength(1);
	expect(groups?.[0]?.kind).toBe("overlap");
});
test("coincident point events count; same-ID versions do not count", () => {
	const events = [af("a", { end_time: null }), af("b", { end_time: null })];
	expect(detectDuplicateEvents(events)).toHaveLength(1);
	expect(
		detectDuplicateEvents([
			events[0] as ReturnType<typeof af>,
			events[0] as ReturnType<typeof af>,
		]),
	).toHaveLength(0);
});
test("cal_adapter_preserves_existing_behavior", () => {
	const events = [
		afCorgi,
		afTidus,
		af("s1"),
		af("s2", { start_time: "2026-10-01T02:45:00Z" }),
	];
	const projection = events.map((event) => ({
		id: event.id,
		calendar: event.calendar_id,
		title: event.title,
		start: event.start_time,
		end: event.end_time,
	}));
	expect(detectDuplicateEvents(events)).toEqual(
		detectDuplicateRecords(projection),
	);
	expect(detectPossibleReshapes(events)).toEqual(
		detectReshapeRecords(projection),
	);
	expect(detectDuplicateEvents(events)).toEqual([
		{
			calendar_id: "personal",
			title: "Study",
			event_ids: ["s1", "s2"],
			kind: "duplicate",
			start: "2026-10-01T02:30:00.000Z",
			end: "2026-10-01T04:30:00.000Z",
		},
	]);
	expect(
		timedProjection(
			normalizedA([af()])[0] as ReturnType<typeof normalizedA>[number],
		).calendar,
	).toBe(calendar.origin_id);
});

test("superseded cancellation evidence cannot create a false identity collision", () => {
	const active = normalizedA([af()]);
	const history = normalizedA([af("a1", { status: "cancelled" })]).map(
		(record) => ({ ...record, ref: `${record.ref}:cancellation-evidence` }),
	);
	const result = buildReconcileReport({
		records: [...active, ...history, ...normalizedG([ge()])],
		window,
		selected,
		now,
		sources: sources(false),
	});
	expect(result.matches).toHaveLength(1);
	expect(result.cancelled_evidence).toHaveLength(1);
	expect(result.tiers?.duplicates_or_overlaps).toHaveLength(0);
	expect(result.counts.records_by_source.server).toBe(2);
});
test("cache active record with a fresh tombstone is diagnosed even if Google is unobserved", () => {
	const result = report(
		[af("a1", { deleted_at: now.toISOString() })],
		[],
		[af()],
	);
	expect(result.cache_diagnostics).toContainEqual(
		expect.objectContaining({
			code: "cache_obsolete_state",
			google_state: "unobserved",
		}),
	);
	expect(result.tiers?.akiflow_missing_or_cancelled).toHaveLength(0);
});
