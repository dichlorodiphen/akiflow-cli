import { loadCredentials, saveCredentials } from "../auth/storage";
import { parseEventMutationResult } from "./mutation-results";
import type {
	AkiflowCredentials,
	ApiResponse,
	CreateEventPayload,
	CreateTaskPayload,
	CreateTimeSlotPayload,
	EventModifier,
	EventModifierPayload,
	EventOperation,
	EventOperationPayload,
	Label,
	MutationResult,
	Tag,
	Task,
	TimeSlot,
	TokenRefreshResponse,
	UpdateTaskPayload,
	UpdateTimeSlotPayload,
} from "./types";
import { AuthError, NetworkError } from "./types";

// AF_API_BASE override lets integration tests point the client at a fake
// HTTP server. Default matches Akiflow's production v5 base.
const BASE_URL = process.env.AF_API_BASE ?? "https://api.akiflow.com";
const REFRESH_URL =
	process.env.AF_REFRESH_URL ?? "https://web.akiflow.com/oauth/refreshToken";
const WEB_CLIENT_ID = "10";
const DEFAULT_VERSION = "3";
const DEFAULT_PLATFORM = "web";
const DEFAULT_LIMIT = 2500;

function eventLocation(event: CreateEventPayload): string | null {
	const location = event.content?.location;
	return typeof location === "string" && location.trim()
		? location.trim()
		: null;
}

function providerEventPayload(
	event: CreateEventPayload,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		title: event.title,
		description: event.description,
		start_time: event.start_time,
		end_time: event.end_time,
		start_datetime_tz: event.start_datetime_tz,
	};

	if (event.end_datetime_tz) {
		payload.end_datetime_tz = event.end_datetime_tz;
	}

	const location = eventLocation(event);
	if (location) payload.location = location;

	if (event.attendees.length > 0) payload.attendees = event.attendees;
	if (
		Array.isArray(event.recurrence)
			? event.recurrence.length > 0
			: event.recurrence
	) {
		payload.recurrence = event.recurrence;
	}

	return payload;
}

function eventOperationFromLegacyPayload(
	event: CreateEventPayload,
	clientOrder: number,
): EventOperationPayload {
	if (!event.akiflow_account_id) {
		throw new NetworkError(
			`Event "${event.id}" is missing its Akiflow account id`,
		);
	}

	const timestamp = event.global_updated_at || new Date().toISOString();
	let operation: EventOperationPayload["operation"];
	let payload: Record<string, unknown>;

	if (event.deleted_at || event.status === "cancelled") {
		operation = "delete";
		payload = {
			send_updates: event.content?.sendUpdates !== "none",
		};
	} else if (!event.origin_id) {
		operation = "create";
		payload = { event: providerEventPayload(event) };
	} else {
		operation = "patch";
		const changes = providerEventPayload(event);
		payload = { base: event.event_operation_base ?? changes, changes };
	}

	return {
		id: crypto.randomUUID(),
		event_id: event.id,
		connector_id: event.connector_id,
		account_id: event.akiflow_account_id,
		calendar_id: event.calendar_id,
		operation,
		payload,
		result: null,
		processed_at: null,
		failed_at: null,
		client_order: clientOrder,
		global_created_at: timestamp,
		deleted_at: null,
		global_updated_at: timestamp,
	};
}

export interface AkiflowClientOptions {
	credentials?: AkiflowCredentials;
	version?: string;
	platform?: string;
}

export class AkiflowClient {
	private credentials: AkiflowCredentials | null = null;
	private version: string;
	private platform: string;
	private isRefreshing = false;

	constructor(options: AkiflowClientOptions = {}) {
		this.credentials = options.credentials ?? null;
		this.version = options.version ?? DEFAULT_VERSION;
		this.platform = options.platform ?? DEFAULT_PLATFORM;
	}

	private async getCredentials(): Promise<AkiflowCredentials> {
		if (this.credentials) {
			return this.credentials;
		}

		const stored = await loadCredentials();
		if (!stored) {
			throw new AuthError("No credentials found. Please login first.");
		}

		this.credentials = {
			token: stored.token,
			clientId: stored.clientId,
			refreshToken: stored.refreshToken,
		};

		return this.credentials;
	}

	/**
	 * Refresh access token using refresh token
	 */
	private async refreshToken(): Promise<boolean> {
		if (this.isRefreshing) {
			return false;
		}

		const creds = await this.getCredentials();
		if (!creds.refreshToken) {
			return false;
		}

		this.isRefreshing = true;
		try {
			const response = await fetch(REFRESH_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					client_id: WEB_CLIENT_ID,
					refresh_token: creds.refreshToken,
				}),
			});

			if (!response.ok) {
				return false;
			}

			const data = (await response.json()) as TokenRefreshResponse;
			if (!data.access_token || !data.refresh_token) {
				return false;
			}

			const expiryTimestamp = Date.now() + data.expires_in * 1000;

			await saveCredentials(
				data.access_token,
				creds.clientId,
				expiryTimestamp,
				data.refresh_token,
			);

			this.credentials = {
				token: data.access_token,
				clientId: creds.clientId,
				refreshToken: data.refresh_token,
			};

			return true;
		} catch {
			return false;
		} finally {
			this.isRefreshing = false;
		}
	}

	private async buildHeaders(
		includeContentType = false,
	): Promise<Record<string, string>> {
		const creds = await this.getCredentials();

		const headers: Record<string, string> = {
			Authorization: `Bearer ${creds.token}`,
			"Akiflow-Client-Id": creds.clientId,
			"Akiflow-Version": this.version,
			"Akiflow-Platform": this.platform,
			Accept: "application/json",
		};

		if (includeContentType) {
			headers["Content-Type"] = "application/json";
		}

		return headers;
	}

	private async request<TData>(
		method: "GET" | "PATCH" | "POST",
		path: string,
		body?: unknown,
		retried = false,
	): Promise<ApiResponse<TData>> {
		const url = `${BASE_URL}${path}`;
		const headers = await this.buildHeaders(method !== "GET");

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
			});
		} catch (error) {
			throw new NetworkError(
				"Failed to connect to Akiflow API",
				error instanceof Error ? error : undefined,
			);
		}

		if (response.status === 401 && !retried) {
			const refreshed = await this.refreshToken();
			if (refreshed) {
				return this.request<TData>(method, path, body, true);
			}
			throw new AuthError(
				"Authentication failed. Token expired and refresh failed. Please run 'af auth' to re-authenticate.",
			);
		}

		if (response.status === 401) {
			throw new AuthError(
				"Authentication failed. Please run 'af auth' to re-authenticate.",
			);
		}

		if (!response.ok) {
			let detail = "";
			try {
				const body = (await response.text()).trim();
				if (body) {
					try {
						const parsed = JSON.parse(body) as { message?: unknown };
						detail = typeof parsed.message === "string" ? parsed.message : body;
					} catch {
						detail = body;
					}
				}
			} catch {
				// Preserve the status-only error if the body cannot be read.
			}
			throw new NetworkError(
				`API request failed with status ${response.status}: ${response.statusText}${detail ? ` - ${detail}` : ""}`,
			);
		}

		try {
			return (await response.json()) as ApiResponse<TData>;
		} catch (error) {
			throw new NetworkError(
				"Failed to parse API response",
				error instanceof Error ? error : undefined,
			);
		}
	}

	/**
	 * Generic GET for any v5 resource. Composes the query string from
	 * `params` (sync_token, limit) and delegates to the internal request()
	 * which handles auth + token refresh on 401.
	 *
	 * Used by the cache layer (src/lib/cache/) to sync resources that
	 * don't have typed-method coverage in this class (events, calendars,
	 * accounts, contacts).
	 */
	async get<T>(
		path: string,
		params: { sync_token?: string; limit?: number } = {},
	): Promise<ApiResponse<T>> {
		const qs = new URLSearchParams();
		if (params.limit != null) qs.set("limit", String(params.limit));
		if (params.sync_token != null) qs.set("sync_token", params.sync_token);
		const suffix = qs.toString() ? `?${qs.toString()}` : "";
		return this.request<T>("GET", `${path}${suffix}`);
	}

	async getTasks(
		options: { limit?: number; syncToken?: string } = {},
	): Promise<ApiResponse<Task[]>> {
		const params = new URLSearchParams();
		params.set("limit", String(options.limit ?? DEFAULT_LIMIT));

		if (options.syncToken) {
			params.set("sync_token", options.syncToken);
		}

		return this.request<Task[]>("GET", `/v5/tasks?${params.toString()}`);
	}

	async getTask(taskId: string): Promise<ApiResponse<Task>> {
		return this.request<Task>("GET", `/v5/tasks/${taskId}`);
	}

	/**
	 * Fetch all tasks by paging with Akiflow's sync_token cursor.
	 *
	 * Akiflow's /v5/tasks behaves like:
	 * - First page: GET /v5/tasks?limit=2500
	 * - Next pages: GET /v5/tasks?limit=2500&sync_token=<previous_response.sync_token>
	 */
	async getAllTasks(): Promise<Task[]> {
		const allTasks: Task[] = [];
		const limit = DEFAULT_LIMIT;

		let cursor: string | undefined;
		let safety = 0;

		while (true) {
			const response = await this.getTasks({ limit, syncToken: cursor });
			const pageTasks = response.data ?? [];

			allTasks.push(...pageTasks);

			const hasNext = response.has_next_page === true;
			if (!hasNext) break;

			// Avoid infinite loops: token must advance for next page.
			if (!response.sync_token || response.sync_token === cursor) break;

			cursor = response.sync_token;
			safety += 1;
			if (safety > 1000) break;
		}

		return allTasks;
	}

	async upsertTasks(
		tasks: Array<CreateTaskPayload | UpdateTaskPayload>,
	): Promise<ApiResponse<Task[]>> {
		return this.request<Task[]>("PATCH", "/v5/tasks", tasks);
	}

	async getLabels(
		options: { limit?: number; syncToken?: string } = {},
	): Promise<ApiResponse<Label[]>> {
		const params = new URLSearchParams();
		params.set("limit", String(options.limit ?? DEFAULT_LIMIT));

		if (options.syncToken) {
			params.set("sync_token", options.syncToken);
		}

		return this.request<Label[]>("GET", `/v5/labels?${params.toString()}`);
	}

	async getTags(
		options: { limit?: number; syncToken?: string } = {},
	): Promise<ApiResponse<Tag[]>> {
		const params = new URLSearchParams();
		params.set("limit", String(options.limit ?? DEFAULT_LIMIT));

		if (options.syncToken) {
			params.set("sync_token", options.syncToken);
		}

		return this.request<Tag[]>("GET", `/v5/tags?${params.toString()}`);
	}

	async getTimeSlots(
		options: { limit?: number; syncToken?: string } = {},
	): Promise<ApiResponse<TimeSlot[]>> {
		const params = new URLSearchParams();
		params.set("limit", String(options.limit ?? DEFAULT_LIMIT));

		if (options.syncToken) {
			params.set("sync_token", options.syncToken);
		}

		return this.request<TimeSlot[]>(
			"GET",
			`/v5/time_slots?${params.toString()}`,
		);
	}

	async upsertTimeSlots(
		timeSlots: Array<CreateTimeSlotPayload | UpdateTimeSlotPayload>,
	): Promise<ApiResponse<TimeSlot[]>> {
		return this.request<TimeSlot[]>("PATCH", "/v5/time_slots", timeSlots);
	}

	async createEvents(events: CreateEventPayload[]): Promise<MutationResult> {
		const operations = events.map((event, index) =>
			eventOperationFromLegacyPayload(event, index),
		);
		try {
			const response = await this.request<EventOperation[]>(
				"POST",
				"/v5/event_operations",
				operations,
			);
			return parseEventMutationResult(response, operations);
		} catch (error) {
			// A failed transport may follow an applied write. Preserve operation IDs
			// and surface unknown receipts; never submit a second operation.
			return parseEventMutationResult(
				{
					success: false,
					data: [],
					message: error instanceof Error ? error.message : String(error),
				},
				operations,
			);
		}
	}

	async createEventModifiers(
		modifiers: EventModifierPayload[],
	): Promise<ApiResponse<EventModifier[]>> {
		return this.request<EventModifier[]>(
			"POST",
			"/v3/events/modifiers",
			modifiers,
		);
	}
}

export function createClient(
	options: AkiflowClientOptions = {},
): AkiflowClient {
	return new AkiflowClient(options);
}
