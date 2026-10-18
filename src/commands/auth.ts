import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { defineCommand } from "citty";
import { scanBrowsers } from "../lib/auth/extract-token";
import {
	bindVerifiedIdentity,
	boundIdentity,
	verifyAuthenticatedIdentity,
} from "../lib/auth/identity";
import { refreshAccessToken } from "../lib/auth/refresh";
import {
	clearCredentials,
	loadCredentials,
	saveCredentials,
	withCredentialsLock,
} from "../lib/auth/storage";
import { profileStatus } from "../lib/profiles";

/**
 * Show authentication status
 */
async function showStatus(json = false): Promise<void> {
	const credentials = await loadCredentials();
	if (json) {
		console.log(
			JSON.stringify(
				{
					profile: profileStatus(),
					authenticated: Boolean(credentials),
					identity_user_id: boundIdentity(),
					expires_at: credentials
						? new Date(credentials.expiryTimestamp).toISOString()
						: null,
					expired: credentials
						? Date.now() > credentials.expiryTimestamp
						: null,
					auto_refresh: Boolean(credentials?.refreshToken),
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(`Profile: ${profileStatus().name}`);

	if (!credentials) {
		console.log("Not authenticated");
		console.log("Run 'af auth login' to authenticate");
		return;
	}

	const expiryDate = new Date(credentials.expiryTimestamp);
	const isExpired = Date.now() > credentials.expiryTimestamp;
	const expiryStatus = isExpired ? "EXPIRED" : "valid";

	console.log(`Status: ${expiryStatus}`);
	console.log(`Client ID: ${credentials.clientId}`);
	console.log(`Expires: ${expiryDate.toISOString()}`);
	console.log(
		`Auto-refresh: ${credentials.refreshToken ? "enabled" : "disabled"}`,
	);

	if (isExpired && credentials.refreshToken) {
		console.log(
			"\nToken has expired. It will be automatically refreshed on next API call.",
		);
	} else if (isExpired) {
		console.log("\nToken has expired. Run 'af auth login' to authenticate.");
	}
}

/**
 * Interactive auth flow
 */
async function interactiveAuth(): Promise<void> {
	console.log("Scanning browsers for Akiflow tokens...");

	const tokens = await scanBrowsers();

	if (tokens.length === 0) {
		console.log("\nNo Akiflow tokens found in any browser");
		console.log("\nTo authenticate:");
		console.log("1. Log in to https://web.akiflow.com in your browser");
		console.log("2. Run 'af auth login' again to extract your session token");

		// Avoid hard-exiting (helps tests and embedding).
		process.exitCode = 1;
		return;
	}

	console.log(`\nFound ${tokens.length} token(s) from:`);
	console.log(tokens.map((t, i) => `${i + 1}. ${t.browser}`).join("\n"));

	let selectedIndex: number | undefined;

	if (tokens.length === 1) {
		console.log("\nUsing the only available token...");
		selectedIndex = 0;
	} else {
		const rl = createInterface({ input, output });

		try {
			const answer = await rl.question(
				`\nSelect token to use (1-${tokens.length}): `,
			);
			const parsed = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) : NaN;

			if (Number.isNaN(parsed) || parsed < 1 || parsed > tokens.length) {
				console.error(
					`Invalid selection. Please enter a number between 1 and ${tokens.length}`,
				);
				process.exitCode = 1;
				return;
			}

			selectedIndex = parsed - 1;
		} finally {
			rl.close();
		}
	}

	if (selectedIndex === undefined) {
		return;
	}

	const selected = tokens[selectedIndex]!;

	console.log(`\nSelected: ${selected.browser}`);

	const expiryTimestamp = selected.expiresAt?.getTime();
	const identity = await verifyAuthenticatedIdentity(selected.token, "10");
	await withCredentialsLock(async () => {
		const previous = await loadCredentials();
		bindVerifiedIdentity(identity, previous?.token);
		await saveCredentials(
			selected.token,
			undefined,
			expiryTimestamp,
			selected.refreshToken,
		);
	});

	console.log("\nAuthentication successful!");
	if (selected.refreshToken) {
		console.log("Refresh token saved for automatic token renewal");
	}
	console.log(
		"You can now use af commands like 'af task list' and 'af task create'",
	);
}

/**
 * Refresh authentication (force new token extraction)
 */
async function refreshAuth(): Promise<void> {
	await withCredentialsLock(refreshAuthLocked);
}

async function refreshAuthLocked(): Promise<void> {
	console.log("Refreshing authentication...");

	const credentials = await loadCredentials();
	if (credentials?.refreshToken) {
		const replacement = await refreshAccessToken({
			refreshToken: credentials.refreshToken,
			clientId: "10",
		});
		if (!replacement) {
			console.error(
				"Token refresh failed: endpoint rejected the request, returned invalid tokens, or could not be reached. Existing credentials retained.",
			);
			process.exitCode = 1;
			return;
		}
		await saveCredentials(
			replacement.accessToken,
			credentials.clientId,
			replacement.expiresAtMs,
			replacement.refreshToken,
		);
		console.log("Authentication refreshed successfully");
		return;
	}

	await interactiveAuth();
}

/**
 * Logout (clear stored credentials)
 */
async function logoutAuth(): Promise<void> {
	const credentials = await loadCredentials();

	if (!credentials) {
		console.log("Not authenticated. Nothing to logout.");
		return;
	}

	console.log("Clearing stored credentials...");
	await withCredentialsLock(() => clearCredentials());

	console.log("Logged out successfully");
}

export const authStatusCommand = defineCommand({
	meta: {
		name: "status",
		description: "Show current authentication status",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output status as JSON without credentials",
		},
	},
	run: async (context) => {
		await showStatus(context?.args?.json);
	},
});

export const authLogoutCommand = defineCommand({
	meta: {
		name: "logout",
		description: "Clear stored credentials",
	},
	run: async () => {
		await logoutAuth();
	},
});

export const authRefreshCommand = defineCommand({
	meta: {
		name: "refresh",
		description: "Force refresh of authentication token",
	},
	run: async () => {
		await refreshAuth();
	},
});

/**
 * Main auth command
 */
export const authLoginCommand = defineCommand({
	meta: {
		name: "login",
		description: "Authenticate by scanning browser sessions",
	},
	run: interactiveAuth,
});

export const authCommand = defineCommand({
	meta: {
		name: "auth",
		description: "Manage Akiflow authentication",
	},
	subCommands: {
		status: authStatusCommand,
		verify: defineCommand({
			meta: {
				name: "verify",
				description:
					"Verify server identity and bind this profile without changing credentials",
			},
			args: { json: { type: "boolean", description: "Output JSON" } },
			run: async ({ args }) => {
				const credentials = await loadCredentials();
				if (!credentials) throw new Error("No credentials to verify");
				const owner = await verifyAuthenticatedIdentity(
					credentials.token,
					credentials.clientId,
				);
				await withCredentialsLock(async () => {
					const current = await loadCredentials();
					if (current?.token !== credentials.token)
						throw new Error(
							"Credentials changed during verification; retry verification",
						);
					bindVerifiedIdentity(owner, credentials.token);
				});
				console.log(
					args.json
						? JSON.stringify({
								profile: profileStatus(),
								user_id: owner,
								verified: true,
							})
						: `Verified profile ${profileStatus().name}: Akiflow user ${owner}`,
				);
			},
		}),
		login: authLoginCommand,
		logout: authLogoutCommand,
		refresh: authRefreshCommand,
	},
	run: async ({ rawArgs }) => {
		if (rawArgs.some((arg) => !arg.startsWith("-"))) return;
		console.log("Usage: af auth <status|login|logout|refresh>");
	},
});
