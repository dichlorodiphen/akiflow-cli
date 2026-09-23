import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { cal } from "../../commands/cal";
import { createClient } from "../../lib/api/client";
import type { Calendar, Event, Task, TimeSlot } from "../../lib/api/types";
import * as cache from "../../lib/cache";

describe("cal command", () => {
	let mockGetTimeSlots: ReturnType<typeof spyOn>;
	let mockReadResource: ReturnType<typeof spyOn>;

	beforeEach(() => {
		mockGetTimeSlots = spyOn(
			createClient().constructor.prototype,
			"getTimeSlots",
		);
		mockReadResource = spyOn(cache, "readResource");
	});

	afterEach(() => {
		mockGetTimeSlots.mockRestore();
		mockReadResource.mockRestore();
	});

	const mockTimeSlots: TimeSlot[] = [
		{
			id: "1",
			user_id: 1,
			recurring_id: null,
			calendar_id: "cal1",
			label_id: null,
			section_id: null,
			status: "confirmed",
			title: "Morning standup",
			description: null,
			original_start_time: null,
			start_time: new Date(new Date().setHours(9, 0, 0)).toISOString(),
			end_time: new Date(new Date().setHours(10, 0, 0)).toISOString(),
			start_datetime_tz: new Date().toISOString(),
			recurrence: null,
			color: null,
			content: {},
			global_label_id_updated_at: null,
			global_created_at: new Date().toISOString(),
			global_updated_at: new Date().toISOString(),
			data: {},
			deleted_at: null,
		},
		{
			id: "2",
			user_id: 1,
			recurring_id: null,
			calendar_id: "cal1",
			label_id: null,
			section_id: null,
			status: "confirmed",
			title: "Deep work",
			description: null,
			original_start_time: null,
			start_time: new Date(new Date().setHours(14, 0, 0)).toISOString(),
			end_time: new Date(new Date().setHours(16, 0, 0)).toISOString(),
			start_datetime_tz: new Date().toISOString(),
			recurrence: null,
			color: null,
			content: {},
			global_label_id_updated_at: null,
			global_created_at: new Date().toISOString(),
			global_updated_at: new Date().toISOString(),
			data: {},
			deleted_at: null,
		},
	];

	const mockCalendars = [
		{
			id: "cal1",
			hidden_at: null,
			deleted_at: null,
		},
	] as Calendar[];

	function mockMergedCalendarData({
		events = [],
		slots = mockTimeSlots,
		tasks = [],
		calendars = mockCalendars,
	}: {
		events?: Event[];
		slots?: TimeSlot[];
		tasks?: Task[];
		calendars?: Calendar[];
	} = {}): void {
		mockReadResource.mockImplementation(
			(_client: unknown, resource: string) => {
				if (resource === "events") return Promise.resolve(events);
				if (resource === "time_slots") return Promise.resolve(slots);
				if (resource === "tasks") return Promise.resolve(tasks);
				if (resource === "calendars") return Promise.resolve(calendars);
				if (resource === "accounts") return Promise.resolve([]);
				return Promise.resolve([]);
			},
		);
	}

	it("lists today's events in timeline format", async () => {
		// given
		mockMergedCalendarData();

		const consoleLogSpy = spyOn(console, "log");

		// when
		await cal.run!({
			args: { free: false, _: [] } as never,
			rawArgs: [],
		} as never);

		// then
		expect(mockReadResource).toHaveBeenCalled();
		expect(consoleLogSpy).toHaveBeenCalled();
		const output = consoleLogSpy.mock.calls.join("\n");
		expect(output).toContain("09:00");
		expect(output).toContain("10:00");
		expect(output).toContain("Morning standup");
		expect(output).toContain("14:00");
		expect(output).toContain("16:00");
		expect(output).toContain("Deep work");

		consoleLogSpy.mockRestore();
	});

	it("lists free time slots when --free flag is used", async () => {
		// given
		mockGetTimeSlots.mockResolvedValue({
			success: true,
			message: null,
			data: mockTimeSlots,
		});

		const consoleLogSpy = spyOn(console, "log");

		// when
		await cal.run!({
			args: { free: true, _: [] } as never,
			rawArgs: [],
		} as never);

		// then
		expect(mockGetTimeSlots).toHaveBeenCalled();
		expect(consoleLogSpy).toHaveBeenCalled();
		const output = consoleLogSpy.mock.calls.join("\n");
		expect(output).toContain("Free Time Slots Today");
		expect(output).toContain("available");

		consoleLogSpy.mockRestore();
	});

	it("shows no events message when schedule is empty", async () => {
		// given
		mockMergedCalendarData({ slots: [] });

		const consoleLogSpy = spyOn(console, "log");

		// when
		await cal.run!({
			args: { free: false, _: [] } as never,
			rawArgs: [],
		} as never);

		// then
		expect(mockReadResource).toHaveBeenCalled();
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"(no events, slots, or scheduled tasks in range)",
		);

		consoleLogSpy.mockRestore();
	});

	it("prints grouped counts with --search and --summary", async () => {
		// given
		mockMergedCalendarData({
			events: [
				{
					id: "event-1",
					calendar_id: "cal1",
					title: "Portland trip: lunch",
					description: null,
					start_time: new Date(2026, 5, 22, 11, 30).toISOString(),
					end_time: new Date(2026, 5, 22, 12, 30).toISOString(),
					start_date: null,
					end_date: null,
					declined: false,
					deleted_at: null,
					hidden: false,
					status: "confirmed",
				} as Event,
				{
					id: "event-2",
					calendar_id: "cal1",
					title: "Unrelated",
					description: null,
					start_time: new Date(2026, 5, 22, 13, 0).toISOString(),
					end_time: new Date(2026, 5, 22, 14, 0).toISOString(),
					start_date: null,
					end_date: null,
					declined: false,
					deleted_at: null,
					hidden: false,
					status: "confirmed",
				} as Event,
			],
			slots: [],
			tasks: [
				{
					id: "task-1",
					title: "Portland trip: task block",
					description: null,
					datetime: new Date(2026, 5, 22, 15, 0).toISOString(),
					duration: 3600,
				} as Task,
			],
		});

		const consoleLogSpy = spyOn(console, "log");

		// when
		await cal.run!({
			args: {
				free: false,
				date: "2026-06-22",
				search: "Portland trip",
				summary: true,
				_: [],
			} as never,
			rawArgs: [],
		} as never);

		// then
		const output = consoleLogSpy.mock.calls.join("\n");
		expect(output).toContain("event: 1");
		expect(output).toContain("task: 1");
		expect(output).toContain("total: 2");

		consoleLogSpy.mockRestore();
	});

	it("filters events, slots, and scheduled tasks by resolved --calendar", async () => {
		// given
		mockMergedCalendarData({
			calendars: [
				{ id: "cal1", title: "Primary", hidden_at: null, deleted_at: null },
				{ id: "cal2", title: "Other", hidden_at: null, deleted_at: null },
			] as Calendar[],
			events: [
				{
					id: "event-1",
					calendar_id: "cal1",
					title: "Selected event",
					description: null,
					start_time: new Date(2026, 5, 22, 9, 0).toISOString(),
					end_time: new Date(2026, 5, 22, 10, 0).toISOString(),
					start_date: null,
					end_date: null,
					declined: false,
					deleted_at: null,
					hidden: false,
					status: "confirmed",
				} as Event,
				{
					id: "event-2",
					calendar_id: "cal2",
					title: "Filtered event",
					description: null,
					start_time: new Date(2026, 5, 22, 10, 0).toISOString(),
					end_time: new Date(2026, 5, 22, 11, 0).toISOString(),
					start_date: null,
					end_date: null,
					declined: false,
					deleted_at: null,
					hidden: false,
					status: "confirmed",
				} as Event,
			],
			slots: [
				{
					...mockTimeSlots[0]!,
					id: "slot-1",
					calendar_id: "cal1",
					title: "Selected slot",
					start_time: new Date(2026, 5, 22, 11, 0).toISOString(),
					end_time: new Date(2026, 5, 22, 12, 0).toISOString(),
				},
				{
					...mockTimeSlots[0]!,
					id: "slot-2",
					calendar_id: "cal2",
					title: "Filtered slot",
					start_time: new Date(2026, 5, 22, 12, 0).toISOString(),
					end_time: new Date(2026, 5, 22, 13, 0).toISOString(),
				},
			],
			tasks: [
				{
					id: "task-1",
					title: "Selected task",
					description: null,
					datetime: new Date(2026, 5, 22, 13, 0).toISOString(),
					duration: 1800,
					calendar_id: "cal1",
				} as Task,
				{
					id: "task-2",
					title: "Filtered task",
					description: null,
					datetime: new Date(2026, 5, 22, 14, 0).toISOString(),
					duration: 1800,
					calendar_id: "cal2",
				} as Task,
			],
		});

		const consoleLogSpy = spyOn(console, "log");

		// when
		await cal.run!({
			args: {
				free: false,
				date: "2026-06-22",
				calendar: "Primary",
				json: true,
				_: [],
			} as never,
			rawArgs: [],
		} as never);

		// then
		const output = consoleLogSpy.mock.calls.join("\n");
		const report = JSON.parse(output);
		const titles = report.result.map((entry: { title: string }) => entry.title);
		expect(titles).toEqual([
			"Selected event",
			"Selected slot",
			"Selected task",
		]);

		consoleLogSpy.mockRestore();
	});

	it("shows free slots header when minimal slots available", async () => {
		// given
		// Even with a full day event (00:00-23:59:59), a tiny gap may exist
		// due to Date precision - this tests the free slots display format
		const fullDaySlots: TimeSlot[] = [
			{
				id: "1",
				user_id: 1,
				recurring_id: null,
				calendar_id: "cal1",
				label_id: null,
				section_id: null,
				status: "confirmed",
				title: "Full day event",
				description: null,
				original_start_time: null,
				start_time: new Date(new Date().setHours(0, 0, 0)).toISOString(),
				end_time: new Date(new Date().setHours(23, 59, 59)).toISOString(),
				start_datetime_tz: new Date().toISOString(),
				recurrence: null,
				color: null,
				content: {},
				global_label_id_updated_at: null,
				global_created_at: new Date().toISOString(),
				global_updated_at: new Date().toISOString(),
				data: {},
				deleted_at: null,
			},
		];

		mockGetTimeSlots.mockResolvedValue({
			success: true,
			message: null,
			data: fullDaySlots,
		});

		const consoleLogSpy = spyOn(console, "log");

		// when
		await cal.run!({
			args: { free: true, _: [] } as never,
			rawArgs: [],
		} as never);

		// then
		expect(mockGetTimeSlots).toHaveBeenCalled();
		const output = consoleLogSpy.mock.calls.join("\n");
		expect(output).toContain("Free Time Slots Today");

		consoleLogSpy.mockRestore();
	});

	it("handles authentication errors", async () => {
		// given
		const authError = new Error("Authentication failed");
		authError.name = "AuthError";
		mockReadResource.mockRejectedValue(authError);

		const consoleErrorSpy = spyOn(console, "error");
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		// when
		try {
			await cal.run!({
				args: { free: false, _: [] } as never,
				rawArgs: [],
			} as never);
		} catch {}

		// then
		expect(mockReadResource).toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Error: Authentication failed. Please run 'af auth' to login.",
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it("handles network errors", async () => {
		// given
		const networkError = new Error("Connection failed");
		networkError.name = "NetworkError";
		mockReadResource.mockRejectedValue(networkError);

		const consoleErrorSpy = spyOn(console, "error");
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		// when
		try {
			await cal.run!({
				args: { free: false, _: [] } as never,
				rawArgs: [],
			} as never);
		} catch {}

		// then
		expect(mockReadResource).toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Error: Failed to fetch calendar",
			"Connection failed",
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});
});
