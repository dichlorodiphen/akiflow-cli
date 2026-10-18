import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
	token: string;
	clientId: string;
	expiryTimestamp: number;
	refreshToken?: string;
}

function getConfigPath(): string {
	// Allow tests/advanced users to override config dir.
	// Default: ~/.config/af
	return process.env.AF_CONFIG_DIR ?? join(homedir(), ".config", "af");
}

function getCredentialsPath(): string {
	return join(getConfigPath(), "credentials.json");
}

async function ensureConfigDirectory(): Promise<void> {
	const configPath = getConfigPath();
	await mkdir(configPath, { recursive: true, mode: 0o700 });
	await chmod(configPath, 0o700);
}

export async function saveCredentials(
	token: string,
	clientId?: string,
	expiryTimestamp?: number,
	refreshToken?: string,
): Promise<void> {
	const credentials: Credentials = {
		token,
		clientId: clientId || crypto.randomUUID(),
		expiryTimestamp: expiryTimestamp ?? Date.now() + 24 * 60 * 60 * 1000,
		refreshToken,
	};

	await ensureConfigDirectory();
	const credentialsPath = getCredentialsPath();
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

export async function loadCredentials(): Promise<Credentials | null> {
	const credentialsFile = Bun.file(getCredentialsPath());

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
		return credentials;
	} catch {
		return null;
	}
}

export async function clearCredentials(): Promise<void> {
	const credentialsPath = getCredentialsPath();

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
