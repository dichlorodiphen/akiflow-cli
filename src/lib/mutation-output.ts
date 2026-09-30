import type { CreateEventPayload, Event, MutationReceipt } from "./api/types";
import { classifyExit } from "./output-contract";
import type { ExpectedEventFields, VerificationResult } from "./verification";

export type MutationStatus =
	| MutationReceipt["status"]
	| VerificationResult<unknown>["status"];

export function eventExpectedFields(
	payload: CreateEventPayload,
): ExpectedEventFields {
	return {
		title: payload.title,
		description: payload.description,
		start_time: payload.start_time,
		end_time: payload.end_time,
		start_datetime_tz: payload.start_datetime_tz,
		...(payload.end_datetime_tz !== undefined
			? { end_datetime_tz: payload.end_datetime_tz }
			: {}),
		location:
			typeof payload.content?.location === "string"
				? payload.content.location
				: null,
	};
}

function detail(value: unknown): string {
	return typeof value === "string"
		? value
		: (JSON.stringify(value) ?? "No operation result was returned");
}

export function outputMutation(input: {
	command: string;
	json?: boolean;
	receipts: MutationReceipt[];
	additionalReceipts?: unknown[];
	verifications?: Map<string, VerificationResult<Event>>;
	status?: MutationStatus;
	result?: unknown;
	errors?: string[];
	warnings?: string[];
}): MutationStatus {
	const statuses = input.receipts.map(
		(receipt) =>
			input.verifications?.get(receipt.event_id)?.status ?? receipt.status,
	);
	const priority: MutationStatus[] = [
		"failed",
		"unknown",
		"mismatch",
		"timeout",
		"pending",
		"accepted",
		"verified",
	];
	const status =
		input.status ??
		priority.find((candidate) => statuses.includes(candidate)) ??
		"accepted";
	const errors = [...(input.errors ?? [])];
	for (const receipt of input.receipts) {
		if (receipt.error !== undefined)
			errors.push(`${receipt.event_id}: ${detail(receipt.error)}`);
		const verification = input.verifications?.get(receipt.event_id);
		if (verification?.error)
			errors.push(`${receipt.event_id}: ${verification.error}`);
		if (verification?.status === "mismatch")
			errors.push(
				`${receipt.event_id}: Mismatch on fields: ${verification.differingFields.join(", ")}`,
			);
	}
	if (input.json) {
		// Workstream H will generalize this versioned envelope to all commands.
		console.log(
			JSON.stringify(
				{
					schema_version: 1,
					command: input.command,
					status,
					receipts: [
						...input.receipts.map((receipt) => {
							const verification = input.verifications?.get(receipt.event_id);
							return verification ? { ...receipt, verification } : receipt;
						}),
						...(input.additionalReceipts ?? []),
					],
					result: input.result ?? null,
					errors,
					warnings: input.warnings ?? [],
				},
				null,
				2,
			),
		);
	} else {
		for (const receipt of input.receipts) {
			const verification = input.verifications?.get(receipt.event_id);
			if (verification) {
				switch (verification.status) {
					case "verified":
						console.log(`✓ Verified: ${receipt.event_id}`);
						break;
					case "pending":
						console.error(
							`… Still pending after 15000ms: ${receipt.event_id}. Re-run with --verify.`,
						);
						break;
					case "mismatch":
						console.error(
							`✗ Mismatch on fields: ${verification.differingFields.join(", ")} (${receipt.event_id})`,
						);
						break;
					case "timeout":
						console.error(
							`⚠ Verification timed out — outcome unknown, no success claimed (${receipt.event_id})`,
						);
						break;
				}
			} else {
				switch (receipt.status) {
					case "accepted":
						console.log(
							`✓ Operation accepted (${receipt.operation_id}) — submitted, not yet confirmed. Re-run with --verify to confirm.`,
						);
						break;
					case "failed":
						console.error(
							`✗ Operation failed: ${detail(receipt.error ?? "Server rejected operation")} (${receipt.event_id})`,
						);
						break;
					case "unknown":
						console.error(
							`⚠ Outcome unknown: ${detail(receipt.error ?? "Operation result missing")}. No success claimed. (${receipt.event_id})`,
						);
						break;
					case "pending":
						console.error(
							`… Operation pending server processing (${receipt.event_id}). Re-run with --verify.`,
						);
						break;
				}
			}
		}
		for (const error of input.errors ?? []) console.error(error);
	}
	if (status !== "accepted" && status !== "verified") {
		const succeeded = input.receipts.some(
			(r) => r.status === "accepted" || (r.status as string) === "verified",
		);
		const failed = input.receipts.some((r) =>
			["failed", "unknown", "mismatch", "timeout"].includes(r.status as string),
		);
		const payloads =
			succeeded && failed ? [{ failed: 1, changed: 1 }] : [];
		process.exitCode = classifyExit(1, errors, payloads);
	}
	return status;
}
