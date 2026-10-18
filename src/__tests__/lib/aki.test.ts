import { afterEach, describe, expect, it, mock } from "bun:test";
import { AkiClient, sessionIdentity } from "../../lib/aki/client";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
function token(user = "123", expired = false): string {
	return `header.${Buffer.from(JSON.stringify({ user_id: user, exp: Math.floor(Date.now() / 1000) + (expired ? -10 : 3600) })).toString("base64url")}.signature`;
}
async function client() {
	return AkiClient.connect({
		getAkiChatSession: async () => ({ token: token() }),
	});
}
function history(id = "aki-123-test", messages: unknown[] = []) {
	return {
		channel: { id },
		members: [{ user_id: "123" }, { user_id: "aki" }],
		messages,
	};
}
function response(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status });
}

describe("Aki memory-only protocol", () => {
	it("rejects malformed/expired session identities", () => {
		expect(sessionIdentity(token())).toBe("123");
		expect(() => sessionIdentity(token("wrong"))).toThrow("invalid");
		expect(() => sessionIdentity(token("123", true))).toThrow("expired");
		expect(() => sessionIdentity("garbage")).toThrow("invalid");
	});
	it("scopes list to selected user, filters non-Aki conversations, and uses token only in auth headers", async () => {
		const calls: { url: URL; init?: RequestInit }[] = [];
		globalThis.fetch = mock(
			async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: new URL(String(url)), init });
				return response({
					channels: [
						history(),
						{
							...history("foreign"),
							members: [{ user_id: "321" }, { user_id: "aki" }],
						},
					],
				});
			},
		) as unknown as typeof fetch;
		const rows = await (await client()).list(5, 10);
		expect(rows).toHaveLength(1);
		expect(calls[0]?.url.searchParams.get("user_id")).toBe("123");
		expect(calls[0]?.url.toString()).not.toContain(token());
		expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
			filter_conditions: { members: { $in: ["123"] } },
			watch: false,
			offset: 10,
		});
	});
	it("refuses foreign conversation before submitting a prompt", async () => {
		const fetcher = mock(async () =>
			response({
				...history(),
				members: [{ user_id: "321" }, { user_id: "aki" }],
			}),
		);
		globalThis.fetch = fetcher as unknown as typeof fetch;
		await expect(
			(await client()).send("aki-123-test", "hello"),
		).rejects.toThrow("selected login");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("refuses group conversations containing additional humans before any message write", async () => {
		const fetcher = mock(async () =>
			response({
				...history(),
				members: [
					{ user_id: "123" },
					{ user_id: "aki" },
					{ user_id: "another-human" },
				],
			}),
		);
		globalThis.fetch = fetcher as unknown as typeof fetch;
		await expect(
			(await client()).send("aki-123-test", "hello"),
		).rejects.toThrow("selected login");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("never retries uncertain prompt writes and reports recovery identifiers", async () => {
		const fetcher = mock(async (_url: unknown, init?: RequestInit) => {
			if (JSON.parse(String(init?.body)).message)
				throw new Error("connection reset");
			return response(history());
		});
		globalThis.fetch = fetcher as unknown as typeof fetch;
		await expect(
			(await client()).send("aki-123-test", "hello"),
		).rejects.toThrow("Prompt ID:");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("ignores old replies and returns new posted Aki messages without replaying the prompt", async () => {
		globalThis.fetch = mock(async () =>
			response(
				history("aki-123-test", [
					{ id: "old", text: "older", user: { id: "aki" } },
					{ id: "sent", text: "hello", user: { id: "123" } },
					{ id: "new", text: "Hello", user: { id: "aki" } },
				]),
			),
		) as unknown as typeof fetch;
		const replies = await (await client()).waitForReply(
			"aki-123-test",
			{ id: "sent" },
			1000,
		);
		expect(replies.map((row) => row.id)).toEqual(["new"]);
	});
	it("preserves a malformed response as a failure rather than a success", async () => {
		globalThis.fetch = mock(
			async () => new Response("not JSON"),
		) as unknown as typeof fetch;
		await expect((await client()).list()).rejects.toThrow("malformed JSON");
	});
});
