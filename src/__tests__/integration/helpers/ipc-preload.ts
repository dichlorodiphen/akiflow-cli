import { ipcFetch } from "./ipc-transport";

const dir = process.env.AF_TEST_IPC_DIR;
if (dir) {
	const base = process.env.AF_API_BASE;
	const refresh = process.env.AF_REFRESH_URL;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		if (
			!(base && request.url.startsWith(`${base}/`)) &&
			!(refresh && request.url === refresh)
		) {
			throw new Error(
				`Integration tests prohibit non-fake requests: ${request.url}`,
			);
		}
		return ipcFetch(dir, request);
	}) as typeof fetch;
}
