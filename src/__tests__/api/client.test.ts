/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { AkiflowClient, createClient } from "../../lib/api/client";
import { AuthError, NetworkError } from "../../lib/api/types";
import * as storage from "../../lib/auth/storage";

const mockCredentials = {
	token: "test-jwt-token",
	clientId: "test-client-id-12345",
	expiryTimestamp: Date.now() + 86400000,
};

const mockTaskResponse = {
	success: true,
	message: null,
	data: [
		{
			id: "task-123",
			user_id: 1,
			title: "Test Task",
			done: false,
			status: 0,
			tags_ids: [],
			links: [],
			doc: {},
			content: {},
			data: {},
			sorting: 0,
			global_created_at: "2026-02-01T00:00:00.000Z",
			global_updated_at: "2026-02-01T00:00:00.000Z",
		},
	],
	sync_token: "test-sync-token",
	has_next_page: false,
};

describe("AkiflowClient", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let loadCredentialsSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue(
			mockCredentials,
		);
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		loadCredentialsSpy?.mockRestore();
	});

	describe("constructor", () => {
		it("creates client with default options", () => {
			// given & when
			const client = new AkiflowClient();

			// then
			expect(client).toBeInstanceOf(AkiflowClient);
		});

		it("creates client with provided credentials", async () => {
			// given
			const credentials = { token: "custom-token", clientId: "custom-client" };
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockTaskResponse), { status: 200 }),
			);

			// when
			const client = new AkiflowClient({ credentials });
			await client.getTasks();

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/v5/tasks"),
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer custom-token",
						"Akiflow-Client-Id": "custom-client",
					}),
				}),
			);
		});
	});

	describe("getTasks", () => {
		it("fetches tasks with default limit", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockTaskResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			const result = await client.getTasks();

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/tasks?limit=2500",
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Authorization: `Bearer ${mockCredentials.token}`,
						"Akiflow-Client-Id": mockCredentials.clientId,
						"Akiflow-Version": "3",
						"Akiflow-Platform": "web",
						Accept: "application/json",
					}),
				}),
			);
			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(1);
		});

		it("fetches tasks with custom limit and sync token", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockTaskResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			await client.getTasks({ limit: 100, syncToken: "prev-sync-token" });

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/tasks?limit=100&sync_token=prev-sync-token",
				expect.any(Object),
			);
		});

		it("throws AuthError on 401 response", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("Unauthorized", { status: 401 }),
			);
			const client = createClient();

			// when & then
			await expect(client.getTasks()).rejects.toThrow(AuthError);
		});

		it("throws NetworkError on network failure", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
				new Error("Network error"),
			);
			const client = createClient();

			// when & then
			await expect(client.getTasks()).rejects.toThrow(NetworkError);
		});

		it("throws NetworkError on non-ok response", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("Server Error", {
					status: 500,
					statusText: "Internal Server Error",
				}),
			);
			const client = createClient();

			// when & then
			await expect(client.getTasks()).rejects.toThrow(NetworkError);
		});
	});

	describe("getAllTasks", () => {
		it("paginates using sync_token cursor", async () => {
			// given
			const page1 = {
				...mockTaskResponse,
				data: [
					{
						...mockTaskResponse.data[0]!,
						id: "task-1",
						title: "Page 1 Task",
					},
				],
				sync_token: "token-1",
				has_next_page: true,
			};

			const page2 = {
				...mockTaskResponse,
				data: [
					{
						...mockTaskResponse.data[0]!,
						id: "task-2",
						title: "Page 2 Task",
					},
				],
				sync_token: "token-2",
				has_next_page: false,
			};

			fetchSpy = spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(
					new Response(JSON.stringify(page1), { status: 200 }),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(page2), { status: 200 }),
				);

			const client = createClient();

			// when
			const all = await client.getAllTasks();

			// then
			expect(all).toHaveLength(2);
			expect(all.map((t) => t.id)).toEqual(["task-1", "task-2"]);

			expect(fetchSpy).toHaveBeenNthCalledWith(
				1,
				"https://api.akiflow.com/v5/tasks?limit=2500",
				expect.any(Object),
			);

			expect(fetchSpy).toHaveBeenNthCalledWith(
				2,
				"https://api.akiflow.com/v5/tasks?limit=2500&sync_token=token-1",
				expect.any(Object),
			);
		});
	});

	describe("upsertTasks", () => {
		it("sends PATCH request with task array", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockTaskResponse), { status: 200 }),
			);
			const client = createClient();
			const taskPayload = {
				id: "new-task-id",
				title: "New Task",
				global_created_at: "2026-02-01T00:00:00.000Z",
				global_updated_at: "2026-02-01T00:00:00.000Z",
			};

			// when
			await client.upsertTasks([taskPayload]);

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/tasks",
				expect.objectContaining({
					method: "PATCH",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
					body: JSON.stringify([taskPayload]),
				}),
			);
		});
	});

	describe("getLabels", () => {
		it("fetches labels from correct endpoint", async () => {
			// given
			const mockResponse = { success: true, message: null, data: [] };
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			await client.getLabels();

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/labels?limit=2500",
				expect.any(Object),
			);
		});

		it("fetches labels with sync token", async () => {
			// given
			const mockResponse = { success: true, message: null, data: [] };
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			await client.getLabels({ syncToken: "label-sync-token" });

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/labels?limit=2500&sync_token=label-sync-token",
				expect.any(Object),
			);
		});
	});

	describe("getTags", () => {
		it("fetches tags from correct endpoint", async () => {
			// given
			const mockResponse = { success: true, message: null, data: [] };
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			await client.getTags();

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/tags?limit=2500",
				expect.any(Object),
			);
		});
	});

	describe("getTimeSlots", () => {
		it("fetches time slots from correct endpoint", async () => {
			// given
			const mockResponse = { success: true, message: null, data: [] };
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			await client.getTimeSlots();

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/time_slots?limit=2500",
				expect.any(Object),
			);
		});
	});

	describe("upsertTimeSlots", () => {
		it("sends PATCH request with time slot array", async () => {
			// given
			const mockResponse = {
				success: true,
				message: null,
				data: [
					{
						id: "slot-123",
						title: "Planning",
						calendar_id: "cal-123",
						start_time: "2026-06-20T16:00:00.000Z",
						end_time: "2026-06-20T17:00:00.000Z",
						start_datetime_tz: "America/Los_Angeles",
						status: "confirmed",
						global_created_at: "2026-06-20T00:00:00.000Z",
						global_updated_at: "2026-06-20T00:00:00.000Z",
					},
				],
			};
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockResponse), { status: 200 }),
			);
			const client = createClient();
			const slotPayload = {
				id: "slot-123",
				title: "Planning",
				calendar_id: "cal-123",
				status: "confirmed" as const,
				start_time: "2026-06-20T16:00:00.000Z",
				end_time: "2026-06-20T17:00:00.000Z",
				start_datetime_tz: "America/Los_Angeles",
				global_created_at: "2026-06-20T00:00:00.000Z",
				global_updated_at: "2026-06-20T00:00:00.000Z",
			};

			// when
			await client.upsertTimeSlots([slotPayload]);

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/time_slots",
				expect.objectContaining({
					method: "PATCH",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
					body: JSON.stringify([slotPayload]),
				}),
			);
		});
	});

	describe("createEvents", () => {
		it("sends a create operation to the v5 event operations endpoint", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async (_url: unknown, init?: RequestInit) => {
						const submitted = JSON.parse(String(init?.body));
						return new Response(
							JSON.stringify({
								success: true,
								message: null,
								data: submitted.map((operation: { id: string }) => ({
									...operation,
									user_id: 1,
									status: "pending",
								})),
							}),
							{ status: 200 },
						);
					},
					{ preconnect() {} },
				),
			);
			const client = createClient();
			const eventPayload = {
				title: "Meeting",
				description: "",
				start_time: "2026-06-20T16:00:00.000Z",
				end_time: "2026-06-20T16:30:00.000Z",
				id: "event-123",
				status: "confirmed" as const,
				start_datetime_tz: "America/Los_Angeles",
				creator_id: "person@example.com",
				organizer_id: "person@example.com",
				origin_id: null,
				connector_id: "google",
				akiflow_account_id: "akiflow-account-1",
				origin_account_id: "google-account-1",
				recurring_id: null,
				origin_recurring_id: null,
				calendar_id: "cal-123",
				origin_calendar_id: "person@example.com",
				original_start_time: null,
				original_start_date: null,
				start_date: null,
				end_date: null,
				end_datetime_tz: null,
				origin_updated_at: null,
				etag: null,
				content: { sendUpdates: "all" },
				attendees: [],
				recurrence: null,
				recurrence_exception: false,
				declined: false,
				read_only: false,
				hidden: false,
				url: null,
				meeting_status: null,
				meeting_url: null,
				meeting_icon: null,
				meeting_solution: null,
				color: null,
				calendar_color: "#7986cb",
				task_id: null,
				time_slot_id: null,
				recurrence_exception_delete: false,
				recurrence_sync_retry: null,
				errors: null,
				global_created_at: null,
				deleted_at: null,
				global_updated_at: "2026-06-19T22:42:58.271Z",
			};

			// when
			const result = await client.createEvents([eventPayload]);

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v5/event_operations",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
				}),
			);
			const operations = JSON.parse(
				fetchSpy.mock.calls[0]?.[1]?.body as string,
			);
			expect(operations).toHaveLength(1);
			expect(operations[0]).toEqual(
				expect.objectContaining({
					event_id: eventPayload.id,
					connector_id: "google",
					account_id: "akiflow-account-1",
					calendar_id: "cal-123",
					operation: "create",
					payload: {
						event: expect.objectContaining({
							title: "Meeting",
							start_time: eventPayload.start_time,
							end_time: eventPayload.end_time,
						}),
					},
				}),
			);
			expect(typeof operations[0].id).toBe("string");
			expect(result.receipts).toEqual([
				{
					operation_id: operations[0].id,
					event_id: eventPayload.id,
					kind: "create",
					status: "pending",
					failed_at: null,
					processed_at: null,
					result: null,
				},
			]);
			expect(result.allAccepted).toBe(false);
			expect(result.raw.data[0]?.id).toBe(operations[0].id);
			expect("data" in result).toBe(false);
			expect("success" in result).toBe(false);
		});
	});

	describe("createEventModifiers", () => {
		it("sends POST request to the captured v3 event modifiers endpoint", async () => {
			// given
			const mockResponse = {
				success: true,
				message: null,
				data: [
					{
						id: "modifier-123",
						event_id: "event-123",
						action: "attendees/updateList",
					},
				],
			};
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockResponse), { status: 200 }),
			);
			const client = createClient();
			const modifierPayload = {
				id: "modifier-123",
				akiflow_account_id: "akiflow-account-1",
				event_id: "event-123",
				calendar_id: "cal-123",
				action: "attendees/updateList" as const,
				content: {
					attendeeEmailsToAdd: ["julia@example.com"],
					attendeeEmailsToRemove: [],
					attendeeResponseStatusesByEmail: {
						"julia@example.com": "needsAction",
					},
					sendUpdates: "all" as const,
				},
				processed_at: null,
				failed_at: null,
				result: null,
				attempts: 0,
				global_created_at: "2026-06-19T22:42:58.271Z",
				deleted_at: null,
				global_updated_at: "2026-06-19T22:42:58.271Z",
			};

			// when
			await client.createEventModifiers([modifierPayload]);

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.akiflow.com/v3/events/modifiers",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
					body: JSON.stringify([modifierPayload]),
				}),
			);
		});
	});

	describe("credential loading", () => {
		it("throws AuthError when no credentials available", async () => {
			// given
			loadCredentialsSpy.mockResolvedValue(null);
			const client = createClient();

			// when & then
			await expect(client.getTasks()).rejects.toThrow(AuthError);
			await expect(client.getTasks()).rejects.toThrow(
				"No credentials found. Please login first.",
			);
		});

		it("uses stored credentials when not provided in constructor", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockTaskResponse), { status: 200 }),
			);
			const client = createClient();

			// when
			await client.getTasks();

			// then
			expect(loadCredentialsSpy).toHaveBeenCalled();
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: `Bearer ${mockCredentials.token}`,
					}),
				}),
			);
		});
	});

	describe("createClient helper", () => {
		it("returns AkiflowClient instance", () => {
			// given & when
			const client = createClient();

			// then
			expect(client).toBeInstanceOf(AkiflowClient);
		});

		it("passes options to constructor", async () => {
			// given
			fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify(mockTaskResponse), { status: 200 }),
			);
			const customVersion = "2.66.3";
			const customPlatform = "mac";

			// when
			const client = createClient({
				version: customVersion,
				platform: customPlatform,
			});
			await client.getTasks();

			// then
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						"Akiflow-Version": customVersion,
						"Akiflow-Platform": customPlatform,
					}),
				}),
			);
		});
	});
});
