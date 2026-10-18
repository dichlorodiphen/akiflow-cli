import { randomUUID } from "node:crypto";
import type { AkiflowClient } from "../api/client";
import { requestTimeoutMs } from "../auth/refresh";

const API_KEY = "ytw4s72xx5yt";
export interface AkiMessage {
	id: string;
	text?: string;
	user?: { id?: string };
	created_at?: string;
	updated_at?: string;
	deleted_at?: string | null;
	[key: string]: unknown;
}
export interface AkiChannel {
	id: string;
	name?: string;
	title?: string;
	members?: Array<{ user_id?: string; user?: { id?: string } }>;
	[key: string]: unknown;
}
export interface AkiHistory {
	channel: AkiChannel;
	messages: AkiMessage[];
	members?: Array<{ user_id?: string; user?: { id?: string } }>;
	[key: string]: unknown;
}

/** Decode only the service-issued session identity; never use an arbitrary local JWT as auth proof. */
export function sessionIdentity(token: string): string {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) throw new Error();
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
		if (typeof payload.user_id !== "string" || !/^\d+$/.test(payload.user_id))
			throw new Error();
		if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now())
			throw new Error();
		return payload.user_id;
	} catch {
		throw new Error("Aki returned an invalid or expired chat session");
	}
}

/** Memory-only GetStream session. No prompt, response, token, or conversation cache. No request replay. */
export class AkiClient {
	private readonly base: string;
	private constructor(
		private readonly token: string,
		readonly userId: string,
	) {
		this.base =
			process.env.AF_AKI_STREAM_BASE ?? "https://chat.stream-io-api.com";
	}
	static async connect(
		client: Pick<AkiflowClient, "getAkiChatSession">,
	): Promise<AkiClient> {
		const session = await client.getAkiChatSession();
		if (!session || typeof session.token !== "string")
			throw new Error("Aki did not return a chat session token");
		return new AkiClient(session.token, sessionIdentity(session.token));
	}
	private async request<T>(
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const url = new URL(`${this.base}${path}`);
		url.searchParams.set("api_key", API_KEY);
		url.searchParams.set("user_id", this.userId);
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: this.token,
					"stream-auth-type": "jwt",
					"X-Stream-Client": "akiflow-cli",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs())])
					: AbortSignal.timeout(requestTimeoutMs()),
			});
		} catch {
			throw new Error(
				"Aki transport interrupted; outcome may be unknown. Do not automatically resubmit a prompt.",
			);
		}
		if (!response.ok)
			throw new Error(
				response.status === 401 || response.status === 403
					? "Aki chat authentication/authorization failed; no prompt was retried"
					: `Aki chat request failed (HTTP ${response.status}); no request was retried`,
			);
		try {
			return (await response.json()) as T;
		} catch {
			throw new Error("Aki returned malformed JSON; no request was retried");
		}
	}
	async list(limit = 30, offset = 0): Promise<AkiHistory[]> {
		const result = await this.request<{ channels?: AkiHistory[] }>(
			"/channels",
			{
				filter_conditions: {
					type: "messaging",
					members: { $in: [this.userId] },
				},
				sort: [
					{ field: "last_message_at", direction: -1 },
					{ field: "created_at", direction: -1 },
				],
				watch: false,
				state: true,
				limit,
				offset,
				message_limit: 1,
				member_limit: 5,
			},
		);
		if (!result || !Array.isArray(result.channels))
			throw new Error("Aki returned an invalid conversation list");
		return result.channels.filter((entry) => this.isAkiConversation(entry));
	}
	private path(channel: string): string {
		if (!/^[\w!-]+$/.test(channel))
			throw new Error("Invalid Aki conversation ID");
		return `/channels/messaging/${encodeURIComponent(channel)}`;
	}
	private isAkiConversation(entry: AkiHistory): boolean {
		const members = entry.members ?? entry.channel?.members ?? [];
		const ids = members.map((member) => member.user_id ?? member.user?.id);
		return (
			ids.length === 2 &&
			new Set(ids).size === 2 &&
			ids.includes(this.userId) &&
			ids.includes("aki") &&
			(typeof entry.channel?.member_count !== "number" ||
				entry.channel.member_count === 2)
		);
	}
	async history(
		channel: string,
		limit = 100,
		before?: string,
		signal?: AbortSignal,
	): Promise<AkiHistory> {
		const result = await this.request<AkiHistory>(
			`${this.path(channel)}/query`,
			{
				watch: false,
				state: true,
				messages: { limit, ...(before ? { id_lt: before } : {}) },
				member_limit: 100,
			},
			signal,
		);
		if (
			!result?.channel ||
			result.channel.id !== channel ||
			!Array.isArray(result.messages) ||
			!this.isAkiConversation(result)
		)
			throw new Error("Conversation is not an Aki chat for the selected login");
		return result;
	}
	async create(title = "New Aki chat"): Promise<AkiHistory> {
		const id = `aki-${this.userId}-${Date.now()}-${randomUUID().slice(0, 6)}`;
		let result: AkiHistory;
		try {
			result = await this.request<AkiHistory>(`${this.path(id)}/query`, {
				data: {
					name: title,
					title,
					members: [this.userId, "aki"],
					created_by_id: this.userId,
				},
				state: true,
				watch: false,
			});
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : "Aki conversation request failed"} Conversation ID: ${id}; inspect conversations before any manual retry.`,
			);
		}
		if (
			!result?.channel ||
			result.channel.id !== id ||
			!this.isAkiConversation(result)
		)
			throw new Error(
				`Aki conversation creation outcome unknown (${id}); do not automatically retry`,
			);
		try {
			return await this.history(id, 1);
		} catch {
			throw new Error(
				`Aki conversation ${id} was created but fresh verification failed; inspect conversations before any manual retry.`,
			);
		}
	}
	async send(
		channel: string,
		prompt: string,
		signal?: AbortSignal,
	): Promise<AkiMessage> {
		await this.history(channel, 1, undefined, signal);
		const id = randomUUID();
		let result: { message?: AkiMessage };
		try {
			result = await this.request<{ message?: AkiMessage }>(
				`${this.path(channel)}/message`,
				{ message: { id, text: prompt, origin: "web" } },
				signal,
			);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : "Aki submission failed"} Prompt ID: ${id}; conversation: ${channel}. Inspect history before any manual resubmission.`,
			);
		}
		if (!result?.message || result.message.id !== id)
			throw new Error(
				`Aki prompt outcome unknown (${id}); inspect history before any manual resubmission`,
			);
		return result.message;
	}
	/** Reversibly hide a disposable chat without clearing history or deleting messages. */
	async hide(channel: string): Promise<void> {
		await this.history(channel, 1);
		await this.request(`${this.path(channel)}/hide`, {
			user_id: null,
			clear_history: false,
		});
	}

	async stop(channel: string): Promise<void> {
		await this.history(channel, 1);
		await this.request(`${this.path(channel)}/event`, {
			event: { type: "ai_indicator.stop" },
		});
	}
	/** Observe posted Aki messages without inferring an unverified turn-completion marker. */
	async waitForReply(
		channel: string,
		sent: AkiMessage,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AkiMessage[]> {
		const deadline = Date.now() + timeoutMs;
		const waitSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			let history: AkiHistory;
			try {
				history = await this.history(channel, 100, undefined, waitSignal);
			} catch (error) {
				throw new Error(
					`${error instanceof Error ? error.message : "Aki response read failed"} Prompt ${sent.id} remains submitted in conversation ${channel}. Inspect history before any manual retry.`,
				);
			}
			const index = history.messages.findIndex(
				(message) => message.id === sent.id,
			);
			if (index >= 0) {
				const replies = history.messages
					.slice(index + 1)
					.filter(
						(message) =>
							message.user?.id === "aki" &&
							!message.deleted_at &&
							((typeof message.text === "string" && !!message.text.trim()) ||
								(Array.isArray(message.attachments) &&
									message.attachments.length > 0)),
					);
				if (replies.length) return replies;
			}
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", aborted);
					resolve();
				};
				const aborted = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", aborted);
					reject(
						new Error("Aki wait cancelled; submitted prompt was not replayed"),
					);
				};
				const timer = setTimeout(
					done,
					Math.min(1000, Math.max(0, deadline - Date.now())),
				);
				signal?.addEventListener("abort", aborted, { once: true });
			});
		}
		throw new Error(
			`Aki response wait timed out; prompt ${sent.id} remains submitted in conversation ${channel}. Inspect history; do not automatically resend.`,
		);
	}
}
