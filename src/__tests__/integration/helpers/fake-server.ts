import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcFetch } from "./ipc-transport";

const ipcServers = new Map<string, string>();
const originalFetch = globalThis.fetch;
let nextVirtualPort = 40000;
export function fakeServerIpcDir(url: string): string | undefined {
	return ipcServers.get(url);
}

interface RecordedRequest {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: string;
}

type ResponseValue = unknown | ((req: { body: string; url: URL }) => unknown);

interface Responder {
	method: string;
	path: string;
	response: ResponseValue;
	status?: number;
}

/**
 * Sentinel a responder can return (or a responder function can return) to
 * simulate the server dropping the connection mid-request — e.g. a crash
 * after applying a write. The request is still recorded; the client sees a
 * transport failure rather than an HTTP status.
 */
export const DROP_CONNECTION = Symbol("fake-server/drop-connection");

/** A response whose body stream errors immediately: the client observes a dropped connection. */
function droppedConnectionResponse(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.error(new Error("Connection dropped by fake server"));
			},
		}),
	);
}

/**
 * In-memory HTTP server for integration tests. Listens on a random port,
 * matches incoming requests against responders registered via respondTo(),
 * records every request for assertion.
 *
 * Start with `await server.start()`, point the CLI at it via the
 * `AF_API_BASE` env var (the value of `server.url`), stop with
 * `await server.stop()` in afterEach.
 */
export class FakeAkiflowServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private responders: Responder[] = [];
	private ipcDir?: string;
	private timer?: ReturnType<typeof setInterval>;
	public readonly requests: RecordedRequest[] = [];
	public url = "";

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const body = req.body ? await req.text() : "";
		const headers = Object.fromEntries(req.headers);
		this.requests.push({ method: req.method, url, headers, body });
		const responder = this.responders.findLast(
			(candidate) =>
				candidate.method === req.method && candidate.path === url.pathname,
		);
		if (!responder) return new Response("Not Found", { status: 404 });
		const value =
			typeof responder.response === "function"
				? responder.response({ body, url })
				: responder.response;
		if (value === DROP_CONNECTION) return droppedConnectionResponse();
		if (value instanceof Response) return value;
		return new Response(JSON.stringify(value), {
			status: responder.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}

	async start(): Promise<string> {
		try {
			this.server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: (req) => this.handle(req),
			});
			this.url = `http://127.0.0.1:${this.server.port}`;
		} catch (error) {
			if ((error as { code?: string }).code !== "EPERM") throw error;
			// Preserve subprocess execution and request/response semantics without a socket.
			this.ipcDir = mkdtempSync(join(tmpdir(), "af-test-ipc-"));
			this.url = `http://127.0.0.1:${nextVirtualPort++}`;
			ipcServers.set(this.url, this.ipcDir);
			globalThis.fetch = (async (
				input: string | URL | Request,
				init?: RequestInit,
			) => {
				const req =
					input instanceof Request
						? new Request(input, init)
						: new Request(String(input), init);
				const dir = ipcServers.get(new URL(req.url).origin);
				return dir ? ipcFetch(dir, req) : originalFetch(input, init);
			}) as typeof fetch;
			const dir = this.ipcDir;
			this.timer = setInterval(() => {
				for (const name of readdirSync(dir).filter((name) =>
					name.endsWith(".request"),
				)) {
					const path = join(dir, name);
					const input = JSON.parse(readFileSync(path, "utf8"));
					unlinkSync(path);
					void (async () => {
						let output: unknown;
						try {
							const response = await this.handle(
								new Request(input.url, {
									method: input.method,
									headers: input.headers,
									body: input.body,
								}),
							);
							output = {
								status: response.status,
								headers: Object.fromEntries(response.headers),
								body: await response.text(),
							};
						} catch (error) {
							output = { error: String(error) };
						}
						const responseFile = path.replace(/\.request$/, ".response");
						writeFileSync(`${responseFile}.tmp`, JSON.stringify(output));
						renameSync(`${responseFile}.tmp`, responseFile);
					})();
				}
			}, 5);
		}
		return this.url;
	}

	async stop(): Promise<void> {
		if (this.server) this.server.stop(true);
		this.server = null;
		if (this.timer) clearInterval(this.timer);
		if (this.ipcDir) {
			ipcServers.delete(this.url);
			rmSync(this.ipcDir, { recursive: true, force: true });
			this.ipcDir = undefined;
		}
		if (ipcServers.size === 0) globalThis.fetch = originalFetch;
	}

	respondTo(
		method: string,
		path: string,
		response: ResponseValue,
		status?: number,
	): void {
		this.responders.push({ method, path, response, status });
	}

	reset(): void {
		this.responders.length = 0;
		this.requests.length = 0;
	}
}
