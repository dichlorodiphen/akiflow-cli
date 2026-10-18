import { afterEach, describe, expect, it, mock } from "bun:test";
import { AkiflowClient } from "../../lib/api/client";

const originalFetch = globalThis.fetch;
const originalAkiBase = process.env.AF_AKI_BASE;
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalAkiBase === undefined) delete process.env.AF_AKI_BASE;
	else process.env.AF_AKI_BASE = originalAkiBase;
});
function client(readOnly = false) {
	return new AkiflowClient({
		readOnly,
		credentials: { token: "selected-profile-token", clientId: "test-client" },
	});
}

describe("project and Aki authenticated transport", () => {
	it("submits project arrays to the existing labels endpoint with selected credentials", async () => {
		let requestUrl = "";
		let body: unknown;
		let auth: string | null = null;
		globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
			requestUrl = String(url);
			body = JSON.parse(String(init?.body));
			auth = new Headers(init?.headers).get("Authorization");
			return new Response(
				JSON.stringify({
					success: true,
					message: "",
					data: [{ id: "project" }],
				}),
			);
		}) as unknown as typeof fetch;
		await client().upsertLabels([{ id: "project", title: "New" }]);
		expect(requestUrl).toEndWith("/v5/labels");
		expect(body).toEqual([{ id: "project", title: "New" }]);
		expect(auth as string | null).toBe("Bearer selected-profile-token");
	});
	it("requests raw Aki token response at the official separate host without persisting it", async () => {
		delete process.env.AF_AKI_BASE;
		let requestUrl = "";
		globalThis.fetch = mock(async (url: unknown) => {
			requestUrl = String(url);
			return new Response(JSON.stringify({ token: "session" }));
		}) as unknown as typeof fetch;
		expect(await client().getAkiChatSession()).toEqual({ token: "session" });
		expect(requestUrl).toBe("https://aki.akiflow.com/api/v1/chat/token");
	});
	it("keeps both new POST/PATCH operations outside read-only client capability", async () => {
		const fetcher = mock(async () => {
			throw new Error("must not fetch");
		});
		globalThis.fetch = fetcher as unknown as typeof fetch;
		await expect(
			client(true).upsertLabels([{ id: "project" }]),
		).rejects.toThrow("Read-only");
		await expect(client(true).getAkiChatSession()).rejects.toThrow("Read-only");
		expect(fetcher).toHaveBeenCalledTimes(0);
	});
});
