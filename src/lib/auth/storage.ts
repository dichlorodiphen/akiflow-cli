import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "../cache/lock";
import { configPath } from "../profiles";
import { boundIdentity, tokenUserId } from "./identity";

export interface Credentials {
	token: string;
	clientId: string;
	expiryTimestamp: number;
	refreshToken?: string;
}

function getConfigPath(): string {
	// Allow tests/advanced users to override config dir.
	// Default: ~/.config/af
	return configPath();
}

function getCredentialsPath(directory = getConfigPath()): string {
	return join(directory, "credentials.json");
}

async function ensureConfigDirectory(
	configPath = getConfigPath(),
): Promise<void> {
	await mkdir(configPath, { recursive: true, mode: 0o700 });
	await chmod(configPath, 0o700);
}

export async function saveCredentials(
	token: string,
	clientId?: string,
	expiryTimestamp?: number,
	refreshToken?: string,
	directory = getConfigPath(),
): Promise<void> {
	const owner = boundIdentity(directory);
	const claim = tokenUserId(token);
	if (owner !== null && claim !== owner)
		throw new Error(
			"Credentials do not match the verified profile identity; existing credentials retained",
		);
	const credentials: Credentials = {
		token,
		clientId: clientId || crypto.randomUUID(),
		expiryTimestamp: expiryTimestamp ?? Date.now() + 24 * 60 * 60 * 1000,
		refreshToken,
	};

	await ensureConfigDirectory(directory);
	const credentialsPath = getCredentialsPath(directory);
	const temporaryPath = `${credentialsPath}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, JSON.stringify(credentials, null, 2), {
			mode: 0o600,
			flag: "wx",
		});
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, credentialsPath);
	} finally {
		await unlink(temporaryPath).catch(() => {});
	}
}

export async function loadCredentials(
	directory = getConfigPath(),
): Promise<Credentials | null> {
	const credentialsFile = Bun.file(getCredentialsPath(directory));

	if (!(await credentialsFile.exists())) {
		return null;
	}

	try {
		const value: unknown = await credentialsFile.json();
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const credentials = value as Credentials;
		if (
			typeof credentials.token !== "string" ||
			!credentials.token.trim() ||
			typeof credentials.clientId !== "string" ||
			!credentials.clientId.trim() ||
			typeof credentials.expiryTimestamp !== "number" ||
			!Number.isFinite(credentials.expiryTimestamp) ||
			!Number.isFinite(new Date(credentials.expiryTimestamp).getTime()) ||
			(credentials.refreshToken !== undefined &&
				(typeof credentials.refreshToken !== "string" ||
					!credentials.refreshToken.trim()))
		)
			return null;
		const owner = boundIdentity(directory);
		if (owner !== null && tokenUserId(credentials.token) !== owner) return null;
		return credentials;
	} catch {
		return null;
	}
}

export async function clearCredentials(
	directory = getConfigPath(),
): Promise<void> {
	const credentialsPath = getCredentialsPath(directory);

	try {
		await unlink(credentialsPath);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
}

/** Serialize refresh-token rotation across processes for one login only. */
export async function withCredentialsLock<T>(
	fn: () => Promise<T>,
	directory = getConfigPath(),
): Promise<T> {
	return withLock(`${directory}.credentials.lock`, fn);
}
