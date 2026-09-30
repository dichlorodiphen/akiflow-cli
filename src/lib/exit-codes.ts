/** Stable process contract. Verify timeout is reserved for future verification. */
export const EXIT_CODES = {
	ok: 0,
	validation: 2,
	auth: 3,
	notFound: 4,
	upstream: 5,
	partialSuccess: 6,
	verifyTimeout: 7,
} as const;

export class UsageError extends Error {
	readonly exitCode = EXIT_CODES.validation;
}
