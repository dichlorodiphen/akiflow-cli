import {
	isTimeout,
	refreshAccessToken,
	requestTimeoutMs,
} from "../auth/refresh";
import { loadCredentials, saveCredentials } from "../auth/storage";
import { parseEventMutationResult } from "./mutation-results";
import type {
	AkiflowCredentials,
	ApiResponse,
	CreateTaskPayload,
	CreateTimeSlotPayload,
	EventOperation,
	EventOperationPayload,
	Label,
	MutationResult,
	Tag,
	Task,
	TimeSlot,
	UpdateTaskPayload,
	UpdateTimeSlotPayload,
} from "./types";
import { AuthError, HttpError, NetworkError } from "./types";

// AF_API_BASE override lets integration tests point the client at a fake
// HTTP server. Default matches Akiflow's production v5 base.
const BASE_URL = process.env.AF_API_BASE ?? "https://api.akiflow.com";
const WEB_CLIENT_ID = "10";
const DEFAULT_VERSION = "3";
const DEFAULT_PLATFORM = "web";
const DEFAULT_LIMIT = 2500;

export interface AkiflowClientOptions {
	/** Reject non-GET requests. A 401 still triggers the normal access-token
	 * refresh and one retry (auth maintenance, not a data write); the client
	 * never touches the CLI cache or any user data. */
	readOnly?: boolean;
	credentials?: AkiflowCredentials;
	version?: string;
	platform?: string;
}

export class AkiflowClient {
	private credentials: AkiflowCredentials | null = null;
	private version: string;
	private platform: string;
	private refreshPromise: Promise<boolean> | null = null;
	private readonly readOnly: boolean;

	constructor(options: AkiflowClientOptions = {}) {
		this.readOnly = options.readOnly === true;
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
			throw new AuthError(
				"No credentials found. Run 'af auth login' to authenticate.",
			);
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
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.performRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async performRefresh(): Promise<boolean> {
		const creds = await this.getCredentials();
		if (!creds.refreshToken) return false;
		let failure: unknown;
		const timeoutMs = requestTimeoutMs();
		const replacement = await refreshAccessToken({
			refreshToken: creds.refreshToken,
			clientId: WEB_CLIENT_ID,
			timeoutMs,
			onFailure: (error) => {
				failure = error;
			},
		});
		if (!replacement) {
			if (isTimeout(failure))
				throw new NetworkError(
					`API request timed out after ${timeoutMs}ms: POST /oauth/refreshToken`,
					failure as Error,
				);
			return false;
		}
		try {
			await saveCredentials(
				replacement.accessToken,
				creds.clientId,
				replacement.expiresAtMs,
				replacement.refreshToken,
			);
			this.credentials = {
				token: replacement.accessToken,
				clientId: creds.clientId,
				refreshToken: replacement.refreshToken,
			};
			return true;
		} catch {
			return false;
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
		if (this.readOnly && method !== "GET") {
			throw new Error("Read-only Akiflow client permits only GET requests");
		}
		const url = `${process.env.AF_API_BASE ?? BASE_URL}${path}`;
		const headers = await this.buildHeaders(method !== "GET");

		const timeoutMs = requestTimeoutMs();
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				signal: AbortSignal.timeout(timeoutMs),
				headers,
				body: body ? JSON.stringify(body) : undefined,
			});
		} catch (error) {
			throw new NetworkError(
				isTimeout(error)
					? `API request timed out after ${timeoutMs}ms: ${method} ${path}`
					: "Failed to connect to Akiflow API",
				error instanceof Error ? error : undefined,
			);
		}

		if (response.status === 401 && !retried) {
			// A late 401 may arrive after another request has already rotated us.
			let refreshed =
				`Bearer ${this.credentials?.token}` !== headers.Authorization;
			let refreshFailure: unknown;
			if (!refreshed) {
				try {
					refreshed = await this.refreshToken();
				} catch (error) {
					refreshFailure = error;
				}
			}
			if (refreshed) return this.request<TData>(method, path, body, true);
			const stored = await loadCredentials();
			if (stored && `Bearer ${stored.token}` !== headers.Authorization) {
				this.credentials = stored;
				return this.request<TData>(method, path, body, true);
			}
			if (refreshFailure) throw refreshFailure;
			throw new AuthError(
				"Authentication failed. Token expired and refresh failed. Run 'af auth login' to authenticate.",
			);
		}

		if (response.status === 401) {
			throw new AuthError(
				"Authentication failed. Run 'af auth login' to authenticate.",
			);
		}

		if (!response.ok) {
			let detail = "";
			let responseBody: string | null = null;
			try {
				responseBody = await response.text();
				const body = responseBody.trim();
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
			throw new HttpError(
				`API request failed with status ${response.status}: ${response.statusText}${detail ? ` - ${detail}` : ""}`,
				response.status,
				path,
				responseBody,
			);
		}

		try {
			return (await response.json()) as ApiResponse<TData>;
		} catch (error) {
			throw new NetworkError(
				isTimeout(error)
					? `API request timed out after ${timeoutMs}ms: ${method} ${path}`
					: "Failed to parse API response",
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

	/**
	 * Submit pre-built v5 event operations. Operation kinds are fixed by the
	 * explicit intent constructors in ./event-intents; this method never
	 * infers create/patch/delete from payload fields.
	 */
	async submitEventOperations(
		operations: EventOperationPayload[],
	): Promise<MutationResult> {
		if (this.readOnly) {
			throw new Error("Read-only Akiflow client permits only GET requests");
		}
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
}

export function createClient(
	options: AkiflowClientOptions = {},
): AkiflowClient {
	return new AkiflowClient(options);
}
