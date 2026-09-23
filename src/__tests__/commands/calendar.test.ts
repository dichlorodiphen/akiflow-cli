import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	calendarDefaultCommand,
	calendarListCommand,
	calendarResolveCommand,
} from "../../commands/calendar";
import type { Calendar } from "../../lib/api/types";
import * as cache from "../../lib/cache";

function calendar(overrides: Partial<Calendar> = {}): Calendar {
	return {
		id: "cal-personal",
		user_id: 1,
		akiflow_account_id: "akiflow-account-1",
		akiflow_primary: true,
		primary: true,
		connector_id: "google",
		origin_id: "person@example.com",
		origin_account_id: "google-account-1",
		title: "Personal",
		description: null,
		timezone: "America/Los_Angeles",
		color: "#7986cb",
		icon: null,
		read_only: false,
		hidden_at: null,
		url: null,
		sync_status: null,
		last_synced_at: null,
		clear_job_id: null,
		settings: {},
		content: {},
		data: {},
		fingerprints: {},
		etag: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		deleted_at: null,
		...overrides,
	};
}

describe("calendar command", () => {
	let readResourceSpy: ReturnType<typeof spyOn>;
	let consoleLogSpy: ReturnType<typeof spyOn>;
	let consoleErrorSpy: ReturnType<typeof spyOn>;
	let processExitSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		readResourceSpy = spyOn(cache, "readResource").mockResolvedValue([
			calendar(),
			calendar({
				id: "cal-work",
				title: "Work Calendar",
				origin_id: "work@example.com",
				primary: false,
				akiflow_primary: false,
			}),
			calendar({
				id: "cal-hidden",
				title: "Hidden",
				origin_id: "hidden@example.com",
				primary: false,
				akiflow_primary: false,
				hidden_at: "2026-06-19T00:00:00.000Z",
			}),
		] as any);
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
		processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
	});

	afterEach(() => {
		readResourceSpy.mockRestore();
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it("lists visible non-deleted calendars by default", async () => {
		await calendarListCommand.run!({
			args: { all: false, json: false, _: [] },
			rawArgs: [],
		} as any);

		const output = consoleLogSpy.mock.calls
			.map((call: unknown[]) => call[0])
			.join("\n");
		expect(output).toContain("Personal");
		expect(output).toContain("Work Calendar");
		expect(output).not.toContain("Hidden");
	});

	it("includes hidden calendars with --all JSON output", async () => {
		await calendarListCommand.run!({
			args: { all: true, json: true, _: [] },
			rawArgs: [],
		} as any);

		const report = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0]));
		expect(report.result.map((item: { id: string }) => item.id)).toContain(
			"cal-hidden",
		);
		expect(
			report.result.find((item: { id: string }) => item.id === "cal-hidden")
				.hidden,
		).toBe(true);
	});

	it("prints the default event calendar", async () => {
		await calendarDefaultCommand.run!({
			args: { json: true, _: [] },
			rawArgs: [],
		} as any);

		const report = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0]));
		expect(report.result.id).toBe("cal-personal");
		expect(report.result.default_event_calendar).toBe(true);
	});

	it("resolves a unique title substring", async () => {
		await calendarResolveCommand.run!({
			args: { calendar: "work", json: true, _: [] },
			rawArgs: [],
		} as any);

		const report = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0]));
		expect(report.result.id).toBe("cal-work");
	});

	it("fails with candidate suggestions for ambiguous titles", async () => {
		readResourceSpy.mockResolvedValueOnce([
			calendar({ id: "cal-team-1", title: "Team Calendar" }),
			calendar({
				id: "cal-team-2",
				title: "Team Planning",
				primary: false,
				akiflow_primary: false,
			}),
		] as any);

		await expect(
			calendarResolveCommand.run!({
				args: { calendar: "team", json: false, _: [] },
				rawArgs: [],
			} as any),
		).rejects.toThrow("process.exit");

		const output = consoleErrorSpy.mock.calls
			.map((call: unknown[]) => call[0])
			.join("\n");
		expect(output).toContain("ambiguous");
		expect(output).toContain("Candidates:");
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
