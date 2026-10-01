import { afterEach, expect, spyOn, test } from "bun:test";
import { reconcileCommand, runReconcile } from "../../commands/reconcile";
import {
	formatReconcileReport,
	reportWarnings,
	stableLabels,
} from "../../lib/reconcile/format";
import * as googleReader from "../../lib/reconcile/google-reader";
import { af, ge, report } from "../lib/reconcile-fixtures";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});
test("human report shows four tiers, full IDs and stable references", () => {
	const result = report([], [ge("full-google-event-id")]);
	const output = formatReconcileReport(result);
	expect(output).toContain("Reconcile — 2026-09-30 · America/Los_Angeles");
	expect(output).toContain("Google missing from Akiflow (1)");
	expect(output).toContain("[G1] Personal · Study · 19:30–21:30");
	expect(output).toContain("Fresh Akiflow: absent · CLI cache: absent");
	expect(output).toContain("Google ID: full-google-event-id");
	expect(output).toContain("Akiflow missing/cancelled on Google (0)\n  none");
	expect(output).toContain("Duplicates / overlaps (0)");
	expect(output).toContain("Possible reshape leftovers (0)");
	expect(output).toContain("unique records involved: 1");
});
test("matched field differences show both native IDs and consequential warnings", () => {
	const result = report(
		[af("native-af-id")],
		[ge("g1", { summary: "New title" })],
		[af("native-af-id")],
	);
	const output = formatReconcileReport(result);
	expect(output).toContain("Matched field differences (1)");
	expect(output).toContain("Akiflow ID: native-af-id");
	expect(output).toContain("Google ID: g1");
	expect(reportWarnings(result)).toContain(
		"Matched records native-af-id / g1 differ in title.",
	);
	expect(result.matches[0]).toHaveProperty("akiflow_ref");
	expect(result.matches[0]).toHaveProperty("google_ref");
});
test("cancellation evidence, cache diagnostics, null time/title retained", () => {
	const result = report(
		[],
		[{ id: "dinner-cancelled", status: "cancelled" }],
		[af("cache-only")],
	);
	const output = formatReconcileReport(result);
	expect(output).toContain("Cancellation evidence (1)");
	expect(output).toContain("title unknown · time unknown");
	expect(output).toContain("Cache diagnostics (1)");
	expect(result.cancelled_evidence[0]?.title).toBeNull();
});
test("references are stable across input order and warnings are strings", () => {
	const result = report(
		[af("z"), af("a", { origin_id: "g2" })],
		[ge("g1"), ge("g2")],
	);
	expect(stableLabels(result.records)).toEqual(
		stableLabels([...result.records].reverse()),
	);
	expect(reportWarnings(result, ["stale", "stale"])).toEqual(["stale"]);
});
test("invalid window fails usage before executable or transport", async () => {
	const helper = spyOn(googleReader, "resolveGoogleExecutable");
	spies.push(helper);
	const fetch = spyOn(globalThis, "fetch");
	spies.push(fetch);
	const outcome = await runReconcile({ from: "2026-09-30", json: true });
	expect(outcome.exitCode).toBe(2);
	expect(outcome.report.complete).toBe(false);
	expect(outcome.report.tiers).toBeNull();
	expect(helper).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});
test("missing helper produces incomplete report and exit 2 without touching providers", async () => {
	const fetch = spyOn(globalThis, "fetch");
	spies.push(fetch);
	const outcome = await runReconcile({
		date: "2026-09-30",
		"google-cmd": "/does-not-exist/reconcile-google-reader",
		json: true,
	});
	expect(outcome.exitCode).toBe(2);
	expect(outcome.report).toMatchObject({
		schema_version: 1,
		complete: false,
		tiers: null,
	});
	expect(outcome.errors[0]?.code).toBe("helper_missing");
	expect(fetch).not.toHaveBeenCalled();
	expect(formatReconcileReport(outcome.report)).toContain("Incomplete report");
});
test("JSON command uses legacy result wrapper with string warnings and structured errors", async () => {
	const log = spyOn(console, "log").mockImplementation(() => {});
	spies.push(log);
	const exit = spyOn(process, "exit").mockImplementation(() => {
		throw new Error("exit");
	});
	spies.push(exit);
	await expect(
		reconcileCommand.run?.({
			args: { json: true, "google-cmd": "/missing/helper" },
		} as never),
	).rejects.toThrow("exit");
	const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
	expect(payload).toMatchObject({
		next_cursor: null,
		result: { schema_version: 1, complete: false, tiers: null },
	});
	expect(Array.isArray(payload.errors)).toBe(true);
	expect(
		payload.warnings.every((warning: unknown) => typeof warning === "string"),
	).toBe(true);
	expect(exit).toHaveBeenCalledWith(2);
});

test("human range label includes both local civil endpoints", () => {
	const result = report([], []);
	result.window = {
		...(result.window as NonNullable<typeof result.window>),
		start: "2026-09-29T07:00:00.000Z",
	};
	expect(formatReconcileReport(result)).toContain(
		"2026-09-29–2026-09-30 · America/Los_Angeles",
	);
});
