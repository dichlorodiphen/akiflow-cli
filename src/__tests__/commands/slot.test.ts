import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	buildSlotDeletePayload,
	buildSlotTaskUpdatePayloads,
	buildSlotUpdatePayload,
	deleteSlotCommand,
	listSlotCommand,
	resolveCachedSlot,
	showSlotCommand,
	updateSlotCommand,
} from "../../commands/slot";
import type {
	Calendar,
	Task,
	TimeSlot,
	UpdateTaskPayload,
} from "../../lib/api/types";
import * as storage from "../../lib/auth/storage";
import * as cache from "../../lib/cache";

const mockCredentials = {
	token: "test-jwt-token",
	clientId: "test-client-id-12345",
	expiryTimestamp: Date.now() + 86400000,
};

function slot(overrides: Partial<TimeSlot> = {}): TimeSlot {
	return {
		id: "slot-123456",
		user_id: 1,
		recurring_id: null,
		calendar_id: "cal-123",
		label_id: null,
		section_id: null,
		status: "confirmed",
		title: "Planning block",
		description: "Focus time",
		original_start_time: null,
		start_time: "2026-06-20T16:00:00.000Z",
		end_time: "2026-06-20T17:00:00.000Z",
		start_datetime_tz: "America/Los_Angeles",
		recurrence: null,
		color: null,
		content: {},
		global_label_id_updated_at: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		data: {},
		deleted_at: null,
		...overrides,
	};
}

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-123456",
		user_id: 1,
		recurring_id: null,
		title: "Linked task",
		description: null,
		date: null,
		datetime: null,
		datetime_tz: null,
		original_date: null,
		original_datetime: null,
		duration: null,
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
		time_slot_id: "slot-123456",
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
		akiflow_account_id: "account-123",
		akiflow_primary: true,
		primary: true,
		connector_id: "google",
		origin_id: "user@example.com",
		origin_account_id: "origin-account-123",
		title: "Personal",
		description: null,
		timezone: "America/Los_Angeles",
		color: "#7986cb",
		icon: null,
		read_only: false,
		hidden_at: null,
		url: null,
		sync_status: "ok",
		last_synced_at: "2026-06-19T00:00:00.000Z",
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

function parseLoggedJsonContaining(
	consoleLogSpy: ReturnType<typeof spyOn>,
	needle: string,
): unknown {
	const match = [...consoleLogSpy.mock.calls]
		.map((call) => String(call[0]))
		.reverse()
		.find((entry) => entry.includes(needle));
	expect(match).toBeDefined();
	if (!match) throw new Error(`No JSON log containing ${needle}`);
	return JSON.parse(match);
}

describe("slot command", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let loadCredentialsSpy: ReturnType<typeof spyOn>;
	let readResourceSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch");
		loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(
			mockCredentials,
		);
		readResourceSpy = spyOn(cache, "readResource").mockImplementation(((
			_client: unknown,
			resource: string,
		) => {
			if (resource === "time_slots") return Promise.resolve([slot()]);
			if (resource === "tasks") return Promise.resolve([task()]);
			if (resource === "calendars") return Promise.resolve([calendar()]);
			return Promise.resolve([]);
		}) as never);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		loadCredentialsSpy.mockRestore();
		readResourceSpy.mockRestore();
	});

	it("builds a minimal slot delete payload", () => {
		expect(
			buildSlotDeletePayload({
				slot: slot(),
				now: "2026-06-20T00:00:00.000Z",
			}),
		).toEqual({
			id: "slot-123456",
			deleted_at: "2026-06-20T00:00:00.000Z",
			global_updated_at: "2026-06-20T00:00:00.000Z",
		});
	});

	it("lists active cached slots with linked tasks as JSON", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		readResourceSpy.mockImplementation(((
			_client: unknown,
			resource: string,
		) => {
			if (resource === "time_slots") {
				return Promise.resolve([
					slot({
						id: "slot-match",
						title: "Portland planning",
						start_time: "2026-06-20T16:00:00.000Z",
						end_time: "2026-06-20T17:00:00.000Z",
					}),
					slot({
						id: "slot-deleted",
						title: "Portland deleted",
						deleted_at: "2026-06-20T00:00:00.000Z",
					}),
					slot({
						id: "slot-other",
						title: "Other",
						start_time: "2026-06-22T16:00:00.000Z",
						end_time: "2026-06-22T17:00:00.000Z",
					}),
				]);
			}
			if (resource === "tasks") {
				return Promise.resolve([
					task({ id: "task-linked", time_slot_id: "slot-match" }),
				]);
			}
			return Promise.resolve([]);
		}) as never);

		await listSlotCommand.run!({
			args: {
				date: "2026-06-20",
				search: "portland",
				json: true,
				_: [],
			},
			rawArgs: [],
		} as never);

		const output = parseLoggedJsonContaining(
			consoleLogSpy,
			"slot-match",
		) as Array<{ slot: TimeSlot; tasks: Task[] }>;
		expect(output).toHaveLength(1);
		const [first] = output;
		if (!first) throw new Error("Expected one slot list result");
		expect(first.slot.id).toBe("slot-match");
		expect(first.tasks.map((t: Task) => t.id)).toEqual(["task-linked"]);

		consoleLogSpy.mockRestore();
	});

	it("shows a cached slot with linked tasks", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});

		await showSlotCommand.run!({
			args: {
				id: "slot-123",
				json: true,
				_: [],
			},
			rawArgs: [],
		} as never);

		const output = parseLoggedJsonContaining(consoleLogSpy, "slot-123456") as {
			slot: TimeSlot;
			tasks: Task[];
		};
		expect(output.slot.id).toBe("slot-123456");
		expect(output.tasks).toHaveLength(1);

		consoleLogSpy.mockRestore();
	});

	it("builds a full slot update payload from cached slot fields", () => {
		const payload = buildSlotUpdatePayload({
			slot: slot(),
			title: "Updated block",
			calendarId: "cal-next",
			timing: {
				startTime: "2026-06-21T17:00:00.000Z",
				endTime: "2026-06-21T17:45:00.000Z",
				date: "2026-06-21",
				timezone: "America/Los_Angeles",
				changed: true,
			},
			now: "2026-06-20T00:00:00.000Z",
		});

		expect(payload).toEqual({
			id: "slot-123456",
			calendar_id: "cal-next",
			status: "confirmed",
			title: "Updated block",
			description: "Focus time",
			start_time: "2026-06-21T17:00:00.000Z",
			end_time: "2026-06-21T17:45:00.000Z",
			start_datetime_tz: "America/Los_Angeles",
			label_id: null,
			section_id: null,
			recurrence: null,
			color: null,
			content: {},
			data: {},
			deleted_at: null,
			global_updated_at: "2026-06-20T00:00:00.000Z",
		});
	});

	it("builds task membership payloads for slot moves, adds, and removes", () => {
		const payloads = buildSlotTaskUpdatePayloads({
			slot: slot(),
			allTasks: [
				task({ id: "task-linked-1" }),
				task({ id: "task-remove" }),
				task({ id: "task-unrelated", time_slot_id: null }),
			],
			addTasks: [task({ id: "task-add", time_slot_id: null })],
			removeTasks: [task({ id: "task-remove" })],
			timing: {
				startTime: "2026-06-21T17:00:00.000Z",
				endTime: "2026-06-21T17:45:00.000Z",
				date: "2026-06-21",
				timezone: "America/Los_Angeles",
				changed: true,
			},
			now: "2026-06-20T00:00:00.000Z",
		});

		expect(payloads).toEqual([
			{
				id: "task-linked-1",
				date: "2026-06-21",
				datetime: "2026-06-21T17:00:00.000Z",
				datetime_tz: "America/Los_Angeles",
				time_slot_id: "slot-123456",
				status: 2,
				global_updated_at: "2026-06-20T00:00:00.000Z",
			},
			{
				id: "task-add",
				date: "2026-06-21",
				datetime: "2026-06-21T17:00:00.000Z",
				datetime_tz: "America/Los_Angeles",
				time_slot_id: "slot-123456",
				status: 2,
				global_updated_at: "2026-06-20T00:00:00.000Z",
			},
			{
				id: "task-remove",
				time_slot_id: null,
				global_updated_at: "2026-06-20T00:00:00.000Z",
			},
		]);
	});

	it("updates a slot and patches task membership", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		readResourceSpy.mockImplementation(((
			_client: unknown,
			resource: string,
		) => {
			if (resource === "time_slots") return Promise.resolve([slot()]);
			if (resource === "tasks") {
				return Promise.resolve([
					task({ id: "task-linked" }),
					task({ id: "task-add", time_slot_id: null }),
					task({ id: "task-remove" }),
				]);
			}
			if (resource === "calendars")
				return Promise.resolve([calendar({ id: "cal-next", title: "Work" })]);
			return Promise.resolve([]);
		}) as never);
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							{
								...slot(),
								title: "Updated block",
								calendar_id: "cal-next",
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							task({ id: "task-linked" }),
							task({ id: "task-add" }),
							task({ id: "task-remove", time_slot_id: null }),
						],
					}),
					{ status: 200 },
				),
			);

		await updateSlotCommand.run!({
			args: {
				id: "slot-123",
				title: "Updated block",
				date: "2026-06-21",
				at: "10:00",
				duration: "45m",
				calendar: "Work",
				"add-task-id": "task-add",
				"remove-task-id": "task-remove",
				_: [],
			},
			rawArgs: [],
		} as never);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/time_slots",
		);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe(
			"https://api.akiflow.com/v5/tasks",
		);
		const slotPayload = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(slotPayload[0]).toMatchObject({
			id: "slot-123456",
			calendar_id: "cal-next",
			title: "Updated block",
			end_time: expect.any(String),
			global_updated_at: expect.any(String),
		});
		const taskPayload = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string);
		expect(taskPayload.map((t: UpdateTaskPayload) => t.id).sort()).toEqual([
			"task-add",
			"task-linked",
			"task-remove",
		]);
		expect(
			taskPayload.find((t: UpdateTaskPayload) => t.id === "task-remove"),
		).toMatchObject({
			time_slot_id: null,
		});
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"✓ Akiflow task slot updated successfully",
		);

		consoleLogSpy.mockRestore();
	});

	it("rejects removing a task that is not linked to the slot", () => {
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(
			() => {},
		);
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		try {
			buildSlotTaskUpdatePayloads({
				slot: slot(),
				allTasks: [],
				removeTasks: [task({ id: "task-other", time_slot_id: null })],
				timing: {
					startTime: "2026-06-21T17:00:00.000Z",
					endTime: "2026-06-21T17:45:00.000Z",
					date: "2026-06-21",
					timezone: "America/Los_Angeles",
					changed: false,
				},
			});
		} catch {}

		expect(consoleErrorSpy.mock.calls.join("\n")).toContain("is not linked");
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it("deletes a cached slot through /v5/time_slots", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [
						{
							...slot(),
							deleted_at: "2026-06-20T00:00:00.000Z",
						},
					],
				}),
				{ status: 200 },
			),
		);

		await deleteSlotCommand.run!({
			args: {
				id: "slot-123",
				_: [],
			},
			rawArgs: [],
		} as never);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/time_slots",
		);
		const payload = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(payload).toEqual([
			{
				id: "slot-123456",
				deleted_at: expect.any(String),
				global_updated_at: expect.any(String),
			},
		]);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"✓ Akiflow task slot deleted successfully",
		);

		consoleLogSpy.mockRestore();
	});

	it("prints deleted slot JSON output", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const deletedSlot = {
			id: "slot-123456",
			title: "Planning block",
			deleted_at: "2026-06-20T00:00:00.000Z",
		};
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [deletedSlot],
				}),
				{ status: 200 },
			),
		);

		await deleteSlotCommand.run!({
			args: {
				id: "slot-123456",
				json: true,
				_: [],
			},
			rawArgs: [],
		} as never);

		expect(consoleLogSpy).toHaveBeenCalledWith(
			JSON.stringify(deletedSlot, null, 2),
		);

		consoleLogSpy.mockRestore();
	});

	it("rejects ambiguous slot id prefixes", () => {
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(
			() => {},
		);
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		try {
			resolveCachedSlot(
				[slot({ id: "slot-abc-1" }), slot({ id: "slot-abc-2" })],
				"slot-abc",
			);
		} catch {}

		expect(consoleErrorSpy.mock.calls.join("\n")).toContain("ambiguous");
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it("rejects already-deleted slots before mutation", () => {
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(
			() => {},
		);
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		try {
			buildSlotDeletePayload({
				slot: slot({ deleted_at: "2026-06-20T00:00:00.000Z" }),
			});
		} catch {}

		expect(consoleErrorSpy.mock.calls.join("\n")).toContain("is deleted");
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});
});
