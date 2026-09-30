/** Bounded transport timeout; invalid overrides use the production default. */
export function requestTimeoutMs(): number {
	const raw = process.env.AF_REQUEST_TIMEOUT_MS;
	const parsed = raw == null || raw === "" ? NaN : Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 30_000;
}

export function isTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		["TimeoutError", "AbortError"].includes(error.name)
	);
}

export async function refreshAccessToken(options: {
	refreshToken: string;
	clientId: string;
	refreshUrl?: string;
	timeoutMs?: number;
	/** Lets the transport preserve timeout diagnostics while the public result remains null. */
	onFailure?: (error: unknown) => void;
}): Promise<{
	accessToken: string;
	refreshToken: string;
	expiresAtMs: number;
} | null> {
	try {
		const response = await fetch(
			options.refreshUrl ??
				process.env.AF_REFRESH_URL ??
				"https://web.akiflow.com/oauth/refreshToken",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					client_id: options.clientId,
					refresh_token: options.refreshToken,
				}),
				signal: AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs()),
			},
		);
		if (!response.ok) return null;
		const value: unknown = await response.json();
		if (!value || typeof value !== "object") return null;
		const data = value as Record<string, unknown>;
		if (
			typeof data.access_token !== "string" ||
			!data.access_token ||
			typeof data.refresh_token !== "string" ||
			!data.refresh_token ||
			typeof data.expires_in !== "number" ||
			!Number.isFinite(data.expires_in) ||
			data.expires_in <= 0
		)
			return null;
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAtMs: Date.now() + data.expires_in * 1000,
		};
	} catch (error) {
		options.onFailure?.(error);
		return null;
	}
}
