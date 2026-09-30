import { spyOn } from "bun:test";
import { runCommand } from "citty";
import { main } from "../../../command-tree";
import type { FakeAkiflowServer } from "./fake-server";
import { makeTestEnv } from "./test-env";

class CliExit extends Error {
	constructor(readonly code: number) {
		super(`CLI exit ${code}`);
	}
}
const root = main;

/**
 * Run the actual citty parser and command handlers against dispatch(), without
 * a socket or subprocess. Global spies are restored by cleanup(); do not use
 * concurrently with unrelated tests. Concurrent commands within one session
 * intentionally share a cache/config and the fake server.
 */
export function localCliSession(server: FakeAkiflowServer) {
	const env = makeTestEnv("http://127.0.0.1:1");
	const prior = Object.fromEntries(
		Object.keys(env.env).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, env.env);
	const log = spyOn(console, "log").mockImplementation(() => {});
	const error = spyOn(console, "error").mockImplementation(() => {});
	const exit = spyOn(process, "exit").mockImplementation((code) => {
		throw new CliExit(Number(code ?? 0));
	});
	const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		const url = new URL(request.url);
		// client.ts resolves base URLs at module load; intercept both that default
		// and the isolated override. Never fall through to the native fetch.
		if (
			!["127.0.0.1", "api.akiflow.com", "web.akiflow.com"].includes(
				url.hostname,
			)
		)
			throw new Error(`Forbidden test URL: ${url}`);
		const pending = server.dispatch(request);
		if (!request.signal) return pending;
		request.signal.throwIfAborted();
		return new Promise<Response>((resolve, reject) => {
			const abort = () => reject(request.signal.reason);
			request.signal.addEventListener("abort", abort, { once: true });
			pending
				.then(resolve, reject)
				.finally(() => request.signal.removeEventListener("abort", abort));
		});
	}) as typeof globalThis.fetch);
	return {
		env,
		async run(args: string[]) {
			const logStart = log.mock.calls.length;
			const errorStart = error.mock.calls.length;
			const previousExitCode = process.exitCode;
			process.exitCode = 0;
			let exitCode = 0;
			process.exitCode = 0;
			try {
				await runCommand(root, { rawArgs: args });
				if (process.exitCode !== 0 && process.exitCode !== undefined) {
					exitCode = process.exitCode;
				}
			} catch (cause) {
				exitCode = cause instanceof CliExit ? cause.code : 1;
				if (!(cause instanceof CliExit)) console.error(String(cause));
			} finally {
				process.exitCode = 0;
			}
			exitCode ||= Number(process.exitCode ?? 0);
			process.exitCode = previousExitCode;
			return {
				exitCode,
				stdout: log.mock.calls
					.slice(logStart)
					.map((call) => call.join(" "))
					.join("\n"),
				stderr: error.mock.calls
					.slice(errorStart)
					.map((call) => call.join(" "))
					.join("\n"),
			};
		},
		cleanup() {
			fetch.mockRestore();
			exit.mockRestore();
			log.mockRestore();
			error.mockRestore();
			for (const [key, value] of Object.entries(prior))
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			env.cleanup();
		},
	};
}
