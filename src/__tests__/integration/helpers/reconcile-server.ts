import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeAkiflowServer } from "./fake-server";

/** Use the existing behavioral server, with the existing IPC preload when sockets are denied. */
export async function startReconcileServer(server: FakeAkiflowServer) {
	try {
		const url = await server.start();
		return {
			url,
			env: {} as Record<string, string>,
			stop: () => server.stop(),
		};
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EPERM"
		)
			throw error;
		await server.stop();
	}
	const directory = mkdtempSync(join(tmpdir(), "af-reconcile-ipc-"));
	const pending = new Set<string>();
	const timer = setInterval(() => {
		for (const file of readdirSync(directory)) {
			if (!file.endsWith(".request") || pending.has(file)) continue;
			pending.add(file);
			const input = JSON.parse(readFileSync(join(directory, file), "utf8"));
			const request = new Request(input.url, {
				method: input.method,
				headers: input.headers,
				...(input.body ? { body: input.body } : {}),
			});
			void (async () => {
				let result: unknown;
				try {
					const response = await server.dispatch(request);
					result = {
						status: response.status,
						body: await response.text(),
						headers: Object.fromEntries(response.headers),
					};
				} catch (error) {
					result = { error: String(error) };
				}
				const path = join(directory, file.replace(/\.request$/, ".response"));
				writeFileSync(`${path}.tmp`, JSON.stringify(result));
				renameSync(`${path}.tmp`, path);
				rmSync(join(directory, file));
				pending.delete(file);
			})();
		}
	}, 2);
	return {
		url: "http://127.0.0.1:1",
		env: { AF_TEST_IPC_DIR: directory },
		stop: async () => {
			clearInterval(timer);
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
