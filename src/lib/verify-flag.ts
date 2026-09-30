import type { VerificationOptions } from "./verification";

export const verifyFlag = {
	type: "boolean" as const,
	description: "Confirm with fresh Akiflow reads (default timeout 15000ms)",
};

export function verificationOptions(): VerificationOptions {
	return { timeoutMs: 15000, pollIntervalMs: 1500 };
}
