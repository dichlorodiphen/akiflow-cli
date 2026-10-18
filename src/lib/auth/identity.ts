import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../cache/atomic";
import { cacheFile } from "../platform-config";
import { configPath } from "../profiles";
import { requestTimeoutMs } from "./refresh";

/** JWT claims are a local mismatch guard, never proof of authenticated identity. */
export function tokenUserId(token: string): number | null {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
		);
		const subject =
			payload.user_id ??
			(typeof payload.sub === "string" && /^[1-9][0-9]*$/.test(payload.sub)
				? Number(payload.sub)
				: null);
		return Number.isSafeInteger(subject) && subject > 0 ? subject : null;
	} catch {
		return null;
	}
}
export function boundIdentity(directory = configPath()): number | null {
	const path = join(directory, "identity.json");
	if (!existsSync(path)) return null;
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (
		value.schema_version !== 1 ||
		!Number.isSafeInteger(value.user_id) ||
		value.user_id <= 0
	)
		throw new Error(
			"Invalid profile identity binding; refusing credential changes",
		);
	return value.user_id;
}
/** Official web client identity contract: authenticated raw user object with numeric id. */
export async function verifyAuthenticatedIdentity(
	token: string,
	clientId: string,
): Promise<number> {
	const response = await fetch(
		process.env.AF_IDENTITY_URL ?? "https://web.akiflow.com/api/v2/user",
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"Akiflow-Client-Id": clientId,
				"Akiflow-Version": "3",
				"Akiflow-Platform": "web",
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(requestTimeoutMs()),
		},
	);
	if (!response.ok)
		throw new Error(
			`Cannot verify authenticated profile identity: HTTP ${response.status}`,
		);
	const value: unknown = await response.json();
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		typeof value.id !== "number" ||
		!Number.isSafeInteger(value.id) ||
		value.id <= 0
	)
		throw new Error(
			"Cannot verify authenticated profile identity: invalid user response",
		);
	const claim = tokenUserId(token);
	if (claim !== null && claim !== value.id)
		throw new Error("Token claim and authenticated user conflict");
	return value.id;
}
export function bindVerifiedIdentity(
	owner: number,
	previousToken?: string,
): void {
	const bound = boundIdentity();
	if (bound !== null && bound !== owner)
		throw new Error(
			"Profile belongs to another Akiflow identity; create a new profile instead",
		);
	const priorClaim = previousToken ? tokenUserId(previousToken) : null;
	if (priorClaim !== null && priorClaim !== owner)
		throw new Error(
			"Existing credentials belong to another Akiflow identity; create a new profile instead",
		);
	// Legacy cache observations must agree before attaching a newly verified login.
	for (const resource of [
		"tasks",
		"events",
		"time_slots",
		"labels",
		"tags",
		"calendars",
		"accounts",
		"contacts",
	]) {
		const path = cacheFile(`${resource}.jsonl`);
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const row = JSON.parse(line);
			if (row.user_id != null && row.user_id !== 0 && row.user_id !== owner)
				throw new Error(
					"Existing cache belongs to another Akiflow identity; create a new profile instead",
				);
		}
	}
	atomicWrite(
		join(configPath(), "identity.json"),
		JSON.stringify({
			schema_version: 1,
			user_id: owner,
			verified_by: "authenticated-web-api-v2-user",
		}),
	);
}
