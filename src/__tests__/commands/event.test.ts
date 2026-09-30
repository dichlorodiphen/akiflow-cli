import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attendeeAddCommand,
	attendeeRemoveCommand,
	buildAttendeePatchIntent,
	buildEventDeletePayload,
	buildEventUpdatePayload,
	eventDeleteCommand,
	eventUpdateCommand,
	resolveCachedEvent,
	validateMutableTimedGoogleEvent,
} from "../../commands/event";
import type { Event } from "../../lib/api/types";
import * as storage from "../../lib/auth/storage";
import * as cache from "../../lib/cache";
import { expectReceiptOnlyCommandFailure } from "../helpers/receipt-only-command";

const mockCredentials = {
	token: "test-jwt-token",
	clientId: "test-client-id-12345",
	expiryTimestamp: Date.now() + 86400000,
};

function event(overrides: Partial<Event> = {}): Event {
	return {
		id: "event-123456",
		user_id: 1,
		recurring_id: null,
		recurrence_exception: false,
		recurrence_exception_delete: null,
		recurrence_sync_retry: null,
		recurrence: null,
		origin_recurring_id: null,
		start_time: "2026-06-20T16:00:00.000Z",
		end_time: "2026-06-20T16:30:00.000Z",
		start_date: null,
		end_date: null,
		start_datetime_tz: "America/Los_Angeles",
		end_datetime_tz: "America/Los_Angeles",
		original_start_time: null,
		original_start_date: null,
		title: "Portland trip: flight",
		description: "Original details",
		status: "confirmed",
		declined: false,
		read_only: false,
		hidden: false,
		color: null,
		calendar_color: "#7986cb",
		attendees: [
			{ email: "pat@example.com", name: "Pat", response: "accepted" },
		],
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
		origin_id: "google-event-123",
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
		content: { location: "Old gate", color: "blue" },
		data: { local: true },
		fingerprints: { local: "hash" },
		etag: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		deleted_at: null,
		...overrides,
	};
}

describe("event command", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let loadCredentialsSpy: ReturnType<typeof spyOn>;
	let readResourceSpy: ReturnType<typeof spyOn>;
	let refreshResourceSpy: ReturnType<typeof spyOn>;
	let upsertResourceRecordsSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch");
		loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(
			mockCredentials,
		);
		readResourceSpy = spyOn(cache, "readResource").mockImplementation(
			() => Promise.resolve([event()]) as any,
		);
		refreshResourceSpy = spyOn(cache, "refreshResource").mockResolvedValue({
			upserted: 0,
			tombstones: 0,
			pages: 1,
		} as any);
		upsertResourceRecordsSpy = spyOn(
			cache,
			"upsertResourceRecords",
		).mockResolvedValue(undefined as any);
	});

	afterEach(() => {
		process.exitCode = 0;
		fetchSpy.mockRestore();
		loadCredentialsSpy.mockRestore();
		readResourceSpy.mockRestore();
		refreshResourceSpy.mockRestore();
		upsertResourceRecordsSpy.mockRestore();
	});

	it("builds an update payload that preserves attendees and strips local-only fields", () => {
		const source = event();
		const payload = buildEventUpdatePayload({
			event: source,
			title: "Portland trip: flight updated",
			description: "Updated details",
			location: "New gate",
			startTime: "2026-06-20T17:00:00.000Z",
			endTime: "2026-06-20T18:00:00.000Z",
			timezone: "America/Los_Angeles",
			now: "2026-06-19T12:00:00.000Z",
		}) as unknown as Record<string, unknown>;

		expect(payload.title).toBe("Portland trip: flight updated");
		expect(payload.description).toBe("Updated details");
		expect(payload.start_time).toBe("2026-06-20T17:00:00.000Z");
		expect(payload.end_time).toBe("2026-06-20T18:00:00.000Z");
		expect(payload.start_date).toBeNull();
		expect(payload.end_date).toBeNull();
		expect(payload.attendees).toEqual(source.attendees);
		expect(payload.content).toEqual({
			location: "New gate",
			color: "blue",
			sendUpdates: "none",
		});
		expect(payload.data).toBeUndefined();
		expect(payload.fingerprints).toBeUndefined();
		expect(payload.user_id).toBeUndefined();
	});

	it("builds a delete payload that cancels the event and strips local-only fields", () => {
		const source = event();
		const payload = buildEventDeletePayload({
			event: source,
			sendUpdates: "none",
			now: "2026-06-19T12:00:00.000Z",
		}) as unknown as Record<string, unknown>;

		expect(payload.id).toBe("event-123456");
		expect(payload.status).toBe("cancelled");
		expect(payload.deleted_at).toBe("2026-06-19T12:00:00.000Z");
		expect(payload.global_updated_at).toBe("2026-06-19T12:00:00.000Z");
		expect(payload.content).toEqual({
			location: "Old gate",
			color: "blue",
			sendUpdates: "none",
		});
		expect(payload.data).toBeUndefined();
		expect(payload.fingerprints).toBeUndefined();
		expect(payload.user_id).toBeUndefined();
	});

	it("updates a cached event through /v5/event_operations", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const expectedStart = new Date(2026, 5, 20, 10, 0).toISOString();
		const expectedEnd = new Date(2026, 5, 20, 10, 45).toISOString();
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [
						{
							...event(),
							title: "Updated flight",
							start_time: expectedStart,
							end_time: expectedEnd,
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expectReceiptOnlyCommandFailure(() =>
			eventUpdateCommand.run!({
				args: {
					id: "event-123",
					date: "2026-06-20",
					at: "10:00",
					duration: "45m",
					title: "Updated flight",
					description: "Gate changed",
					location: "PDX",
					json: false,
					_: [],
				},
				rawArgs: [],
			} as any),
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0]).toEqual(
			expect.objectContaining({
				event_id: "event-123456",
				operation: "patch",
				payload: {
					base: expect.any(Object),
					changes: expect.objectContaining({
						title: "Updated flight",
						description: "Gate changed",
						start_time: expectedStart,
						end_time: expectedEnd,
						location: "PDX",
						attendees: event().attendees,
					}),
					send_updates: false,
				},
			}),
		);
		expect(consoleLogSpy).not.toHaveBeenCalledWith(
			"✓ Akiflow calendar event updated successfully",
		);

		// Fresh bases are still required; unmatched results cannot enter the cache.
		expect(refreshResourceSpy).toHaveBeenCalledWith(
			expect.anything(),
			"events",
		);
		expect(upsertResourceRecordsSpy).not.toHaveBeenCalled();

		consoleLogSpy.mockRestore();
	});

	it("builds the second operation from freshly observed state despite receipt-only responses", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const firstStart = new Date(2026, 5, 20, 10, 0).toISOString();
		const firstEnd = new Date(2026, 5, 20, 10, 45).toISOString();
		const secondStart = new Date(2026, 5, 20, 11, 0).toISOString();
		const secondEnd = new Date(2026, 5, 20, 11, 45).toISOString();

		const firstResponse = {
			...event(),
			title: "First update",
			start_time: firstStart,
			end_time: firstEnd,
		};
		// Simulate a fresh canonical read, independent of the mutation response.
		readResourceSpy.mockResolvedValueOnce([event()]);
		readResourceSpy.mockResolvedValueOnce([firstResponse]);

		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ success: true, message: null, data: [firstResponse] }),
				{ status: 200 },
			),
		);
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ ...firstResponse, title: "Second update" }],
				}),
				{ status: 200 },
			),
		);

		const runUpdate = (at: string, title: string) =>
			eventUpdateCommand.run!({
				args: {
					id: "event-123",
					date: "2026-06-20",
					at,
					duration: "45m",
					title,
					description: "desc",
					json: false,
					_: [],
				},
				rawArgs: [],
			} as any);

		await expectReceiptOnlyCommandFailure(() =>
			runUpdate("10:00", "First update"),
		);
		await expectReceiptOnlyCommandFailure(() =>
			runUpdate("11:00", "Second update"),
		);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string);
		// The second operation's base must reflect the first update's applied
		// state, not the original cached state — otherwise the server drops it.
		expect(secondBody[0].payload.base).toEqual(
			expect.objectContaining({
				title: "First update",
				start_time: firstStart,
				end_time: firstEnd,
			}),
		);
		expect(secondStart).toBeTruthy();
		expect(secondEnd).toBeTruthy();

		consoleLogSpy.mockRestore();
	});

	it("deletes a cached event through /v5/event_operations and stays silent by default", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [
						{
							...event(),
							status: "cancelled",
							deleted_at: "2026-06-20T00:00:00.000Z",
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expectReceiptOnlyCommandFailure(() =>
			eventDeleteCommand.run!({
				args: {
					id: "event-123",
					_: [],
				},
				rawArgs: [],
			} as any),
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0]).toEqual(
			expect.objectContaining({
				event_id: "event-123456",
				operation: "delete",
				payload: { send_updates: false },
				global_updated_at: expect.any(String),
			}),
		);
		expect(consoleLogSpy).not.toHaveBeenCalledWith(
			"✓ Akiflow calendar event deleted successfully",
		);

		consoleLogSpy.mockRestore();
	});

	it("sends silent event delete without fabricating JSON output", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ id: "event-123456", status: "cancelled" }],
				}),
				{ status: 200 },
			),
		);

		await expectReceiptOnlyCommandFailure(() =>
			eventDeleteCommand.run!({
				args: {
					id: "event-123456",
					"send-updates": "none",
					json: true,
					_: [],
				},
				rawArgs: [],
			} as any),
		);

		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0].payload.send_updates).toBe(false);
		expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		const envelope = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0]));
		expect(envelope.status).toBe("unknown");
		expect(envelope.result).toBeNull();

		consoleLogSpy.mockRestore();
	});

	it("reads update descriptions from a file without shell expansion", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const tempDir = mkdtempSync(join(tmpdir(), "af-event-update-"));
		const descriptionPath = join(tempDir, "description.txt");
		writeFileSync(descriptionPath, "Fare difference: $300\nBring ID.", "utf-8");
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ id: "event-123456", title: "Flight" }],
				}),
				{ status: 200 },
			),
		);

		await expectReceiptOnlyCommandFailure(() =>
			eventUpdateCommand.run!({
				args: {
					id: "event-123456",
					date: "2026-06-20",
					at: "10:00",
					duration: "30m",
					"description-file": descriptionPath,
					json: true,
					_: [],
				},
				rawArgs: [],
			} as any),
		);

		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0].payload.changes.description).toBe(
			"Fare difference: $300\nBring ID.",
		);
		consoleLogSpy.mockRestore();
	});

	it("rejects ambiguous id prefixes", () => {
		const consoleErrorSpy = spyOn(console, "error").mockImplementation(
			() => {},
		);
		const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		try {
			resolveCachedEvent(
				[event({ id: "event-abc-1" }), event({ id: "event-abc-2" })],
				"event-abc",
			);
		} catch {}

		expect(consoleErrorSpy.mock.calls.join("\n")).toContain("ambiguous");
		expect(processExitSpy).toHaveBeenCalledWith(1);

		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it("rejects unsupported event shapes before mutation", () => {
		const cases: Array<[string, Partial<Event>]> = [
			[
				"all-day",
				{ start_time: null, end_time: null, start_date: "2026-06-20" },
			],
			["recurring", { recurring_id: "recurring-1" }],
			["recurrence rule", { recurrence: ["RRULE:FREQ=DAILY"] }],
			["read-only", { read_only: true }],
			["non-Google", { connector_id: "microsoft" }],
		];

		for (const [label, overrides] of cases) {
			const consoleErrorSpy = spyOn(console, "error").mockImplementation(
				() => {},
			);
			const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
				throw new Error("process.exit");
			});

			try {
				validateMutableTimedGoogleEvent(event(overrides));
			} catch {}

			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(consoleErrorSpy.mock.calls.join("\n").length).toBeGreaterThan(0);

			consoleErrorSpy.mockRestore();
			processExitSpy.mockRestore();
			void label;
		}
	});

	it("accepts Google-synced non-recurring events with empty recurrence arrays", () => {
		expect(() =>
			validateMutableTimedGoogleEvent(event({ recurrence: [] })),
		).not.toThrow();
	});

	it("builds an attendee patch intent with merged attendee list and silent default", () => {
		const intent = buildAttendeePatchIntent({
			event: event(),
			add: ["julia@example.com"],
			remove: [],
		});

		expect(intent.sendUpdates).toBe("none");
		expect(intent.changes).toEqual({
			attendees: [
				{ email: "pat@example.com", name: "Pat", response: "accepted" },
				{ email: "julia@example.com", responseStatus: "needsAction" },
			],
		});
		expect(intent.base).toEqual(
			expect.objectContaining({ title: "Portland trip: flight" }),
		);
	});

	it("builds an attendee patch intent that removes by email", () => {
		const intent = buildAttendeePatchIntent({
			event: event(),
			add: [],
			remove: ["Pat@Example.com"],
			sendUpdates: "all",
		});

		expect(intent.sendUpdates).toBe("all");
		expect(intent.changes).toEqual({ attendees: [] });
	});

	it("adds multiple attendee emails through a v5 patch operation, never the 410 modifiers endpoint", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		fetchSpy.mockImplementationOnce(
			async (_url: unknown, init?: RequestInit) => {
				const operations = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ ...operations[0], status: "succeeded", user_id: 1 }],
					}),
					{ status: 200 },
				);
			},
		);

		await attendeeAddCommand.run!({
			args: {
				id: "event-123456",
				email: "Julia@Example.com",
				_: ["alex@example.com"],
				json: false,
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		for (const call of fetchSpy.mock.calls) {
			expect(String(call[0])).not.toContain("/v3/events/modifiers");
		}
		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0]).toEqual(
			expect.objectContaining({
				event_id: "event-123456",
				operation: "patch",
				payload: {
					base: expect.any(Object),
					changes: {
						attendees: [
							{ email: "pat@example.com", name: "Pat", response: "accepted" },
							{ email: "julia@example.com", responseStatus: "needsAction" },
							{ email: "alex@example.com", responseStatus: "needsAction" },
						],
					},
					send_updates: false,
				},
			}),
		);
		// Accepted receipts print the mutation envelope; success is never claimed.
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("✓ Operation accepted"),
		);
		expect(process.exitCode).toBe(0);

		consoleLogSpy.mockRestore();
	});

	it("never accepts aggregate-failed operations and preserves pending/failed status", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const cases = [
			{ success: false, status: "succeeded", expected: "unknown" },
			{ success: true, status: "pending", expected: "pending" },
			{ success: true, status: "failed", expected: "failed" },
		];
		for (const testCase of cases) {
			fetchSpy.mockImplementationOnce(
				async (_url: unknown, init?: RequestInit) => {
					const payloads = JSON.parse(String(init?.body));
					return new Response(
						JSON.stringify({
							success: testCase.success,
							message: "server detail",
							data: [
								{
									...payloads[0],
									status: testCase.status,
									result: "server rejected",
								},
							],
						}),
					);
				},
			);
			await attendeeAddCommand.run!({
				args: { id: "event-123456", email: "new@example.com", json: true },
				rawArgs: [],
			} as any);
			const output = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]));
			expect(output.status).toBe(testCase.expected);
			expect(output.receipts[0].status).toBe(testCase.expected);
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;
		}
		consoleLogSpy.mockRestore();
	});

	it("verifies single attendee membership with an uncached fresh read", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		fetchSpy.mockImplementationOnce(
			async (_url: unknown, init?: RequestInit) => {
				const payloads = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ ...payloads[0], status: "succeeded" }],
					}),
				);
			},
		);
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ ...event(), attendees: [{ email: "new@example.com" }] }],
				}),
			),
		);
		await attendeeAddCommand.run!({
			args: {
				id: "event-123456",
				email: "new@example.com",
				verify: true,
				json: true,
			},
			rawArgs: [],
		} as any);
		const output = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]));
		expect(output.status).toBe("verified");
		expect(output.result.attendees).toEqual([{ email: "new@example.com" }]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(upsertResourceRecordsSpy).toHaveBeenCalledWith("events", [
			output.result,
		]);
		consoleLogSpy.mockRestore();
	});

	it("skips no-op attendee additions", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});

		await attendeeAddCommand.run!({
			args: {
				id: "event-123456",
				email: "pat@example.com",
				_: [],
				json: true,
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(
			JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string).result,
		).toEqual(
			expect.objectContaining({
				event_id: "event-123456",
				action: "add",
				requested: 1,
				changed: 0,
			}),
		);

		consoleLogSpy.mockRestore();
	});

	it("removes existing attendee emails through a silent v5 patch operation", async () => {
		const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		fetchSpy.mockImplementationOnce(
			async (_url: unknown, init?: RequestInit) => {
				const operations = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ ...operations[0], status: "succeeded", user_id: 1 }],
					}),
					{ status: 200 },
				);
			},
		);

		await attendeeRemoveCommand.run!({
			args: {
				id: "event-123456",
				email: "pat@example.com",
				_: [],
				json: false,
			},
			rawArgs: [],
		} as any);

		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.akiflow.com/v5/event_operations",
		);
		for (const call of fetchSpy.mock.calls) {
			expect(String(call[0])).not.toContain("/v3/events/modifiers");
		}
		const operations = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(operations[0]).toEqual(
			expect.objectContaining({
				event_id: "event-123456",
				operation: "patch",
				payload: {
					base: expect.any(Object),
					changes: { attendees: [] },
					send_updates: false,
				},
			}),
		);
		expect(process.exitCode).toBe(0);
		consoleLogSpy.mockRestore();
	});
});
