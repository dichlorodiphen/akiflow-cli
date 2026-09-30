import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Test-only transport for sandboxes that prohibit listening sockets. */
export async function ipcFetch(
	dir: string,
	request: Request,
): Promise<Response> {
	const id = crypto.randomUUID();
	const requestFile = join(dir, `${id}.request`);
	const responseFile = join(dir, `${id}.response`);
	writeFileSync(
		`${requestFile}.tmp`,
		JSON.stringify({
			url: request.url,
			method: request.method,
			headers: Object.fromEntries(request.headers),
			body: request.body ? await request.text() : undefined,
		}),
	);
	renameSync(`${requestFile}.tmp`, requestFile);
	const deadline = Date.now() + 30000;
	while (!existsSync(responseFile)) {
		if (Date.now() >= deadline)
			throw new Error("Fake-server IPC response timed out");
		await Bun.sleep(5);
	}
	const response = JSON.parse(readFileSync(responseFile, "utf8"));
	unlinkSync(responseFile);
	if (response.error) throw new Error(response.error);
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
}
