/** Test-only preload for runners where socket listeners are prohibited. */
import { randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const directory = process.env.AF_TEST_TRANSPORT;
if (directory) {
	globalThis.fetch = (async (input, init) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(String(input), init);
		if (new URL(request.url).origin !== process.env.AF_API_BASE)
			throw new Error("Test transport refuses external network calls");
		const id = randomUUID();
		const path = join(directory, `${id}.request.json`);
		writeFileSync(
			`${path}.tmp`,
			JSON.stringify({
				url: request.url,
				method: request.method,
				headers: Object.fromEntries(request.headers),
				body: request.body ? await request.text() : "",
			}),
		);
		renameSync(`${path}.tmp`, path);
		const responsePath = join(directory, `${id}.response.json`);
		const deadline = Date.now() + 10000;
		while (!existsSync(responsePath)) {
			if (Date.now() > deadline)
				throw new Error("Test fixture transport timed out");
			await Bun.sleep(2);
		}
		const result = JSON.parse(readFileSync(responsePath, "utf8"));
		rmSync(responsePath);
		return new Response(result.body, {
			status: result.status,
			headers: result.headers,
		});
	}) as typeof fetch;
}
