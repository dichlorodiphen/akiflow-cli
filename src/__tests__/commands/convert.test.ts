import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertTasksCommand } from "../../commands/convert";
import type { Calendar, Event, Task } from "../../lib/api/types";
import * as storage from "../../lib/auth/storage";
import * as cache from "../../lib/cache";

const mockCredentials = {
	token: "test-jwt-token",
	clientId: "test-client-id-12345",
	expiryTimestamp: Date.now() + 86400000,
};

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		user_id: 1,
		recurring_id: null,
		title: "Portland trip: lunch",
		description: "Lunch details",
		date: "2026-06-22",
		datetime: "2026-06-22T18:30:00.000Z",
		datetime_tz: "America/Los_Angeles",
		original_date: null,
		original_datetime: null,
		duration: 3600,
		recurrence: null,
		recurrence_version: null,
		status: 2,
		priority: null,
		dailyGoal: null,
		done: false,
		done_at: null,
		read_at: null,
		listId: null,
		section_id: null,
		tags_ids: [],
		sorting: 0,
		sorting_label: null,
		origin: null,
		due_date: null,
		connector_id: null,
		origin_id: null,
		origin_account_id: null,
		akiflow_account_id: null,
		doc: {},
		calendar_id: null,
		time_slot_id: null,
		links: [],
		content: {},
		trashed_at: null,
		plan_unit: null,
		plan_period: null,
		global_list_id_updated_at: null,
		global_tags_ids_updated_at: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		data: {},
		deleted_at: null,
		...overrides,
	};
}

function calendar(overrides: Partial<Calendar> = {}): Calendar {
	return {
		id: "cal-123",
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

function event(overrides: Partial<Event> = {}): Event {
	return {
		id: "event-1",
		user_id: 1,
		recurring_id: null,
		recurrence_exception: false,
		recurrence_exception_delete: null,
		recurrence_sync_retry: null,
		recurrence: null,
		origin_recurring_id: null,
		start_time: "2026-06-22T18:30:00.000Z",
		end_time: "2026-06-22T19:30:00.000Z",
		start_date: null,
		end_date: null,
		start_datetime_tz: "America/Los_Angeles",
		end_datetime_tz: null,
		original_start_time: null,
		original_start_date: null,
		title: "Portland trip: lunch",
		description: "Lunch details",
		status: "confirmed",
		declined: false,
		read_only: false,
		hidden: false,
		color: null,
		calendar_color: "#7986cb",
		attendees: [],
		organizer_id: "person@example.com",
		creator_id: "person@example.com",
		created_by: null,
		meeting_url: null,
		meeting_solution: null,
		meeting_icon: null,
		meeting_status: null,
		calendar_id: "cal-123",
		task_id: null,
		time_slot_id: null,
		url: null,
		origin_id: null,
		origin_account_id: "google-account-1",
		origin_calendar_id: "person@example.com",
		origin_updated_at: null,
		akiflow_account_id: "akiflow-account-1",
		connector_id: "google",
		availability_config_id: null,
		email_confirmation_type: null,
		email_confirmation_status: null,
		email_reminder_type: null,
		email_reminder_status: null,
		email_remind_before: null,
		email_reminded_at: null,
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

describe("convert tasks command", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let loadCredentialsSpy: ReturnType<typeof spyOn>;
	let readResourceSpy: ReturnType<typeof spyOn>;
	let testCacheDir: string;
	let previousCacheDir: string | undefined;
	function seedTasks(records: Task[]) {
		writeFileSync(
			join(testCacheDir, "tasks.jsonl"),
			records.map((record) => JSON.stringify(record)).join("\n"),
		);
	}

	beforeEach(() => {
		previousCacheDir = process.env.AF_CACHE_DIR;
		testCacheDir = mkdtempSync(join(tmpdir(), "af-convert-unit-"));
		process.env.AF_CACHE_DIR = testCacheDir;
		seedTasks([task()]);
		writeFileSync(join(testCacheDir, "events.jsonl"), "");
		writeFileSync(
			join(testCacheDir, "calendars.jsonl"),
			JSON.stringify(calendar()),
		);
		fetchSpy = spyOn(globalThis, "fetch");
		loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(
			mockCredentials,
		);
		readResourceSpy = spyOn(cache, "readResource");
		readResourceSpy.mockImplementation((_client: unknown, resource: string) => {
			if (resource === "tasks") return Promise.resolve([task()]);
			if (resource === "events") return Promise.resolve([]);
			if (resource === "calendars") return Promise.resolve([calendar()]);
			return Promise.resolve([]);
		});
	});

	afterEach(() => {
		rmSync(testCacheDir, { recursive: true, force: true });
		if (previousCacheDir === undefined) delete process.env.AF_CACHE_DIR;
		else process.env.AF_CACHE_DIR = previousCacheDir;
		fetchSpy.mockRestore();
		loadCredentialsSpy.mockRestore();
		readResourceSpy.mockRestore();
	});

	it("dry-runs without mutating APIs", async () => {
		const consoleLogSpy = spyOn(console, "log");

		await convertTasksCommand.run!({
			args: {
				to: "events",
				search: "Portland trip",
				execute: false,
				_: [],
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(loadCredentialsSpy).not.toHaveBeenCalled();
		expect(readResourceSpy).not.toHaveBeenCalled();
		expect(consoleLogSpy.mock.calls.join("\n")).toContain(
			"Conversion plan: tasks -> events",
		);
		expect(consoleLogSpy.mock.calls.join("\n")).toContain(
			"Events to create: 1",
		);

		consoleLogSpy.mockRestore();
	});

	it("creates events and deletes native source tasks only after create succeeds", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ id: "created-event" }],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ id: "task-1", deleted_at: "2026-06-19T00:00:00.000Z" }],
					}),
					{ status: 200 },
				),
			);
		const consoleLogSpy = spyOn(console, "log");

		await convertTasksCommand.run!({
			args: {
				to: "events",
				execute: true,
				"delete-source": true,
				calendar: "Personal",
				_: [],
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe(
			"https://api.akiflow.com/v5/tasks",
		);

		const eventPayload = JSON.parse(
			fetchSpy.mock.calls[0]?.[1]?.body as string,
		);
		expect(eventPayload[0]).toEqual(
			expect.objectContaining({
				operation: "create",
				calendar_id: "cal-123",
				payload: {
					event: expect.objectContaining({
						title: "Portland trip: lunch",
						description: "Lunch details",
						start_time: "2026-06-22T18:30:00.000Z",
						end_time: "2026-06-22T19:30:00.000Z",
					}),
				},
			}),
		);
		const deletePayload = JSON.parse(
			fetchSpy.mock.calls[1]?.[1]?.body as string,
		);
		expect(deletePayload[0]).toEqual(
			expect.objectContaining({
				id: "task-1",
				deleted_at: expect.any(String),
			}),
		);

		consoleLogSpy.mockRestore();
	});

	it("accepts event-operation responses without a success flag", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						message: null,
						data: [{ id: "created-event" }],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ id: "task-1", deleted_at: "2026-06-19T00:00:00.000Z" }],
					}),
					{ status: 200 },
				),
			);
		const consoleLogSpy = spyOn(console, "log");

		await convertTasksCommand.run!({
			args: {
				to: "events",
				execute: true,
				"delete-source": true,
				_: [],
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe(
			"https://api.akiflow.com/v5/tasks",
		);

		consoleLogSpy.mockRestore();
	});

	it("skips duplicate event creation and can delete matched source tasks", async () => {
		readResourceSpy.mockImplementation((_client: unknown, resource: string) => {
			if (resource === "tasks") return Promise.resolve([task()]);
			if (resource === "events") return Promise.resolve([event()]);
			if (resource === "calendars") return Promise.resolve([calendar()]);
			return Promise.resolve([]);
		});
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ id: "task-1", deleted_at: "2026-06-19T00:00:00.000Z" }],
				}),
				{ status: 200 },
			),
		);
		const consoleLogSpy = spyOn(console, "log");

		await convertTasksCommand.run!({
			args: {
				to: "events",
				execute: true,
				"delete-source": true,
				_: [],
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/tasks",
		);
		expect(consoleLogSpy.mock.calls.join("\n")).toContain(
			"Already matched events: 1",
		);

		consoleLogSpy.mockRestore();
	});

	it("rejects missing task durations without --default-duration", async () => {
		seedTasks([task({ duration: null })]);
		readResourceSpy.mockImplementation((_client: unknown, resource: string) => {
			if (resource === "tasks")
				return Promise.resolve([task({ duration: null })]);
			if (resource === "events") return Promise.resolve([]);
			if (resource === "calendars") return Promise.resolve([calendar()]);
			return Promise.resolve([]);
		});
		const consoleErrorSpy = spyOn(console, "error");
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		try {
			await convertTasksCommand.run!({
				args: { to: "events", _: [] },
				rawArgs: [],
			} as any);
		} catch {}

		expect(consoleErrorSpy.mock.calls.join("\n")).toContain("missing duration");
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it("rejects connector-backed source deletion", async () => {
		seedTasks([task({ connector_id: "todoist" })]);
		readResourceSpy.mockImplementation((_client: unknown, resource: string) => {
			if (resource === "tasks")
				return Promise.resolve([task({ connector_id: "todoist" })]);
			if (resource === "events") return Promise.resolve([]);
			if (resource === "calendars") return Promise.resolve([calendar()]);
			return Promise.resolve([]);
		});
		const consoleErrorSpy = spyOn(console, "error");
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		try {
			await convertTasksCommand.run!({
				args: {
					to: "events",
					"include-connector-tasks": true,
					"delete-source": true,
					_: [],
				},
				rawArgs: [],
			} as any);
		} catch {}

		expect(consoleErrorSpy.mock.calls.join("\n")).toContain(
			"connector-backed source tasks cannot be deleted",
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});
});
