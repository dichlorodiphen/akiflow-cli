import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "../../lib/exit-codes";
import {
	classifyExit,
	ENVELOPE_MIGRATION_WARNING,
	outputMode,
	toEnvelope,
} from "../../lib/output-contract";

describe("versioned output contract", () => {
	test("normalizes existing wrappers and retains metadata and warnings", () => {
		const envelope = toEnvelope(
			"af task list",
			{
				result: [1],
				next_cursor: null,
				errors: [],
				meta: { snapshot: "pin" },
				warnings: ["inventory"],
			},
			0,
		);
		expect(envelope.schema_version).toBe(1);
		expect(envelope.command).toBe("af task list");
		expect(envelope.status).toBe("ok");
		expect(envelope.result).toEqual([1]);
		expect(envelope.meta).toEqual({
			snapshot: "pin",
			next_cursor: null,
			exit_code: 0,
		});
		expect(envelope.warnings).toEqual([
			ENVELOPE_MIGRATION_WARNING,
			"inventory",
		]);
	});
	test("retains bare legacy reports and provides structured failure status", () => {
		const report = { selected: 2, changed: 1, failed: 1 };
		expect(toEnvelope("af batch", report, 6).result).toEqual(report);
		expect(toEnvelope("af batch", report, 6).status).toBe("partial");
		expect(
			toEnvelope("af task update", null, 4, [], ["Task not found"]).errors,
		).toEqual(["Task not found"]);
	});
	test("classifies safe errors and reserves verify timeout", () => {
		expect(classifyExit(1, ["Task with ID x not found"], [])).toBe(4);
		expect(classifyExit(1, ["Authentication failed"], [])).toBe(3);
		expect(classifyExit(1, ["HTTP 503 API error"], [])).toBe(5);
		expect(classifyExit(1, [], [{ failed: 1, changed: 1 }])).toBe(6);
		expect(classifyExit(1, ["Invalid --date selector"], [])).toBe(2);
		expect(classifyExit(1, ["Unrelated failure"], [])).toBe(1);
		expect(EXIT_CODES.verifyTimeout).toBe(7);
	});
});

test("envelope opt-in honors explicit negation and ignores positional flag-shaped titles", () => {
	expect(outputMode(["--json", "--no-envelope"], "1")).toEqual({
		enabled: false,
		requestedJson: true,
	});
	expect(outputMode(["--json", "--", "--envelope"], "0")).toEqual({
		enabled: false,
		requestedJson: true,
	});
	expect(outputMode(["--json=true", "--envelope=true"], "0")).toEqual({
		enabled: true,
		requestedJson: true,
	});
	expect(outputMode(["--envelope=false"], "1").enabled).toBe(false);
});

test("output mode honors final boolean spellings for every JSON source", () => {
	expect(outputMode(["--envelope", "--json", "--no-json"], "0")).toEqual({
		enabled: true,
		requestedJson: false,
	});
	expect(
		outputMode(["--raw", "--raw=false", "--json=false"], "0").requestedJson,
	).toBe(false);
	expect(outputMode(["--raw", "--no-json"], "0").requestedJson).toBe(true);
	expect(outputMode(["--no-envelope=false"], "0").enabled).toBe(true);
});

test("API timeouts retain the upstream exit contract", () => {
	expect(
		classifyExit(
			1,
			["Error: API request timed out after 50ms: GET /v5/events"],
			[],
		),
	).toBe(EXIT_CODES.upstream);
});
