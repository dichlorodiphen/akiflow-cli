import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventCommand, createSlotCommand } from "../../commands/create";
import * as storage from "../../lib/auth/storage";
import * as cache from "../../lib/cache";

const mockCredentials = {
	token: "test-jwt-token",
	clientId: "test-client-id-12345",
	expiryTimestamp: Date.now() + 86400000,
};

describe("create command", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let loadCredentialsSpy: ReturnType<typeof spyOn>;
	let readResourceSpy: ReturnType<typeof spyOn>;
	let writeFileSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch");
		loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(
			mockCredentials,
		);
		readResourceSpy = spyOn(cache, "readResource");
		writeFileSpy = spyOn(fs, "writeFile").mockResolvedValue(undefined as any);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		loadCredentialsSpy.mockRestore();
		readResourceSpy.mockRestore();
		writeFileSpy.mockRestore();
	});

	it("creates a task slot and linked child tasks", async () => {
		// given
		const consoleLogSpy = spyOn(console, "log");
		readResourceSpy.mockResolvedValue([
			{
				id: "cal-123",
				akiflow_account_id: "akiflow-account-1",
				akiflow_primary: true,
				primary: true,
				connector_id: "google",
				origin_id: "person@example.com",
				origin_account_id: "google-account-1",
				title: "Personal",
				color: "#7986cb",
				read_only: false,
				hidden_at: null,
				deleted_at: null,
			},
		] as any);
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							{
								id: "slot-123",
								calendar_id: "cal-123",
								title: "Planning block",
								start_time: "2026-06-20T16:00:00.000Z",
								end_time: "2026-06-20T17:00:00.000Z",
								start_datetime_tz: "America/Los_Angeles",
								status: "confirmed",
								description: "Deep work",
								content: {},
								data: {},
								global_created_at: "2026-06-20T00:00:00.000Z",
								global_updated_at: "2026-06-20T00:00:00.000Z",
								deleted_at: null,
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
							{
								id: "task-created-1",
								title: "Draft",
								time_slot_id: "slot-123",
								global_created_at: "2026-06-20T00:00:00.000Z",
								global_updated_at: "2026-06-20T00:00:00.000Z",
							},
							{
								id: "task-created-2",
								title: "Review",
								time_slot_id: "slot-123",
								global_created_at: "2026-06-20T00:00:00.000Z",
								global_updated_at: "2026-06-20T00:00:00.000Z",
							},
						],
					}),
					{ status: 200 },
				),
			);

		// when
		await createSlotCommand.run!({
			args: {
				title: "Planning block",
				date: "2026-06-20",
				at: "09:00",
				duration: "1h",
				description: "Deep work",
				task: ["Draft", "Review"],
				"task-duration": "30m",
				json: false,
				_: [],
			},
			rawArgs: [],
		} as any);

		// then
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/time_slots",
		);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe(
			"https://api.akiflow.com/v5/tasks",
		);

		const slotPayload = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(slotPayload[0].calendar_id).toBe("cal-123");
		expect(slotPayload[0].title).toBe("Planning block");
		expect(slotPayload[0].description).toBe("Deep work");

		const taskPayload = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string);
		expect(taskPayload).toHaveLength(2);
		expect(taskPayload.map((t: { title: string }) => t.title)).toEqual([
			"Draft",
			"Review",
		]);
		expect(
			taskPayload.map((t: { time_slot_id: string }) => t.time_slot_id),
		).toEqual(["slot-123", "slot-123"]);
		expect(taskPayload.map((t: { duration: number }) => t.duration)).toEqual([
			1800, 1800,
		]);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"✓ Akiflow task slot created successfully",
		);

		consoleLogSpy.mockRestore();
	});

	it("creates a timed Google calendar event through a v5 event operation", async () => {
		// given
		const consoleLogSpy = spyOn(console, "log");
		const expectedStart = new Date(2026, 5, 20, 9, 0).toISOString();
		const expectedEnd = new Date(2026, 5, 20, 9, 45).toISOString();
		const expectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		readResourceSpy.mockResolvedValue([
			{
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
			},
		] as any);
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [
						{
							id: "event-123",
							title: "Standup",
							calendar_id: "cal-123",
							start_time: expectedStart,
							end_time: expectedEnd,
							start_datetime_tz: expectedTimezone,
							status: "confirmed",
							description: "Discuss launch",
							content: { sendUpdates: "all", location: "Office" },
							global_created_at: null,
							global_updated_at: "2026-06-19T22:42:58.271Z",
							deleted_at: null,
						},
					],
				}),
				{ status: 200 },
			),
		);

		// when
		await createEventCommand.run!({
			args: {
				title: "Standup",
				date: "2026-06-20",
				at: "09:00",
				duration: "45m",
				description: "Discuss launch",
				location: "Office",
				json: false,
				_: [],
			},
			rawArgs: [],
		} as any);

		// then
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		expect(fetchSpy.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"Content-Type": "application/json",
				}),
			}),
		);

		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations).toHaveLength(1);
		expect(operations[0]).toEqual(
			expect.objectContaining({
				connector_id: "google",
				account_id: "akiflow-account-1",
				calendar_id: "cal-123",
				operation: "create",
				payload: {
					event: {
						title: "Standup",
						description: "Discuss launch",
						start_time: expectedStart,
						end_time: expectedEnd,
						start_datetime_tz: expectedTimezone,
						location: "Office",
					},
				},
			}),
		);
		expect(typeof operations[0].id).toBe("string");
		expect(typeof operations[0].global_updated_at).toBe("string");
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"✓ Akiflow calendar event created successfully",
		);

		consoleLogSpy.mockRestore();
	});

	it("uses an explicit calendar title and prints JSON output", async () => {
		// given
		const consoleLogSpy = spyOn(console, "log");
		readResourceSpy.mockResolvedValue([
			{
				id: "cal-primary",
				akiflow_account_id: "akiflow-account-1",
				akiflow_primary: true,
				primary: true,
				connector_id: "google",
				origin_id: "primary@example.com",
				origin_account_id: "google-account-1",
				title: "Primary",
				color: "#111111",
				read_only: false,
				hidden_at: null,
				deleted_at: null,
			},
			{
				id: "cal-explicit",
				akiflow_account_id: "akiflow-account-2",
				akiflow_primary: false,
				primary: false,
				connector_id: "google",
				origin_id: "explicit@example.com",
				origin_account_id: "google-account-2",
				title: "Explicit",
				color: "#222222",
				read_only: false,
				hidden_at: null,
				deleted_at: null,
			},
		] as any);
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ id: "event-json", title: "Demo" }],
				}),
				{ status: 200 },
			),
		);

		// when
		await createEventCommand.run!({
			args: {
				title: "Demo",
				date: "2026-06-20",
				at: "10:00",
				duration: "30m",
				calendar: "Explicit",
				json: true,
				_: [],
			},
			rawArgs: [],
		} as any);

		// then
		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0].calendar_id).toBe("cal-explicit");
		expect(operations[0].account_id).toBe("akiflow-account-2");
		const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string);
		expect(output).toEqual(
			expect.objectContaining({
				title: "Demo",
				calendar_id: "cal-explicit",
				creator_id: "explicit@example.com",
			}),
		);

		consoleLogSpy.mockRestore();
	});

	it("reads event description from --description-file without shell expansion", async () => {
		// given
		const tempDir = mkdtempSync(join(tmpdir(), "af-create-event-"));
		const descriptionPath = join(tempDir, "description.txt");
		writeFileSync(descriptionPath, "Credit hold: $300\nBring ID.", "utf-8");
		readResourceSpy.mockResolvedValue([
			{
				id: "cal-123",
				akiflow_account_id: "akiflow-account-1",
				akiflow_primary: true,
				primary: true,
				connector_id: "google",
				origin_id: "person@example.com",
				origin_account_id: "google-account-1",
				title: "Personal",
				color: "#7986cb",
				read_only: false,
				hidden_at: null,
				deleted_at: null,
			},
		] as any);
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ id: "event-123", title: "Rental pickup" }],
				}),
				{ status: 200 },
			),
		);

		// when
		await createEventCommand.run!({
			args: {
				title: "Rental pickup",
				date: "2026-06-20",
				at: "09:00",
				duration: "30m",
				"description-file": descriptionPath,
				json: false,
				_: [],
			},
			rawArgs: [],
		} as any);

		// then
		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0].payload.event.description).toBe(
			"Credit hold: $300\nBring ID.",
		);
	});
});
