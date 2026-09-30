import type { AkiflowClient } from "./api/client";
import { checkTaskMutationResult } from "./api/task-results";
import type { ApiResponse, TimeSlot } from "./api/types";
import { classifyExit } from "./output-contract";
import {
	type ExpectedTaskFields,
	verifyTaskDeleted,
	verifyTaskFields,
	verifyTimeSlotFields,
} from "./verification";
import { verificationOptions } from "./verify-flag";

export interface TaskReceipt {
	id: string;
	resource: "task" | "slot";
	status:
		| "accepted"
		| "verified"
		| "failed"
		| "unknown"
		| "pending"
		| "mismatch"
		| "timeout";
	error?: string;
	differingFields?: string[];
}
export interface TaskOutcome {
	receipts: TaskReceipt[];
	errors: string[];
	ok: boolean;
}

export async function taskMutationOutcome(
	client: AkiflowClient,
	response: ApiResponse<Array<{ id: string }>>,
	payloads: Array<{ id: string }>,
	verify: boolean,
	resource: "task" | "slot" = "task",
): Promise<TaskOutcome> {
	const checked = checkTaskMutationResult(
		response,
		payloads.map((p) => p.id),
	);
	const receipts: TaskReceipt[] = [];
	for (const id of new Set(payloads.map((p) => p.id))) {
		const receipt: TaskReceipt = {
			id,
			resource,
			status: checked.failedIds.includes(id)
				? "failed"
				: checked.succeededIds.includes(id)
					? "accepted"
					: "unknown",
		};
		if (receipt.status !== "accepted")
			receipt.error =
				checked.errors.join("; ") || "No matching result returned";
		if (verify && receipt.status === "accepted") {
			const payload = payloads.find((p) => p.id === id);
			const expected = Object.fromEntries(
				Object.entries(payload ?? {}).filter(
					([key]) =>
						!["id", "global_created_at", "global_updated_at"].includes(key),
				),
			);
			const result =
				resource === "slot"
					? await verifyTimeSlotFields(
							client,
							id,
							expected as Partial<TimeSlot>,
							verificationOptions(),
						)
					: "deleted_at" in expected
						? await verifyTaskDeleted(client, id, verificationOptions())
						: await verifyTaskFields(
								client,
								id,
								expected as ExpectedTaskFields,
								verificationOptions(),
							);
			receipt.status = result.status;
			receipt.differingFields = result.differingFields;
			if (result.error) receipt.error = result.error;
		}
		receipts.push(receipt);
	}
	return {
		receipts,
		errors: checked.errors,
		ok:
			checked.ok &&
			receipts.every((r) => r.status === (verify ? "verified" : "accepted")),
	};
}

export function unknownTaskOutcome(
	ids: string[],
	error: unknown,
	resource: "task" | "slot" = "task",
): TaskOutcome {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		errors: [message],
		receipts: ids.map((id) => ({
			id,
			resource,
			status: "unknown",
			error: message,
		})),
	};
}

export function printTaskMutation(
	command: string,
	json: boolean,
	outcomes: TaskOutcome[],
	result: unknown,
): boolean {
	const receipts = outcomes.flatMap((o) => o.receipts);
	const errors = outcomes.flatMap((o) => o.errors);
	const ok = outcomes.every((o) => o.ok);
	const status =
		["failed", "unknown", "timeout", "mismatch", "pending"].find((status) =>
			receipts.some((r) => r.status === status),
		) ??
		(receipts.every((r) => r.status === "verified")
			? "verified"
			: ok
				? "accepted"
				: "unknown");
	if (json) {
		// Workstream H will generalize this versioned receipt envelope to all commands.
		console.log(
			JSON.stringify(
				{
					schema_version: 1,
					command,
					status,
					receipts,
					result,
					errors,
					warnings:
						status === "accepted"
							? [
									"Submitted, not yet confirmed. Re-run with --verify to confirm.",
								]
							: [],
				},
				null,
				2,
			),
		);
	} else {
		for (const receipt of receipts) {
			if (receipt.status === "accepted")
				console.log(
					`✓ Operation accepted (${receipt.id}) — submitted, not yet confirmed. Re-run with --verify to confirm.`,
				);
			else if (receipt.status === "verified")
				console.log(`✓ Verified: ${receipt.id}`);
			else if (receipt.status === "failed")
				console.error(
					`✗ Operation failed: ${receipt.id}: ${receipt.error ?? "Server rejected mutation"}`,
				);
			else if (receipt.status === "mismatch")
				console.error(
					`✗ Mismatch on fields: ${receipt.differingFields?.join(", ")} (${receipt.id})`,
				);
			else if (receipt.status === "timeout")
				console.error(
					`⚠ Verification timed out — outcome unknown, no success claimed (${receipt.id})`,
				);
			else if (receipt.status === "pending")
				console.error(
					`… Still pending after 15000ms (${receipt.id}). Re-run with --verify.`,
				);
			else
				console.error(
					`⚠ Outcome unknown: ${receipt.id}: ${receipt.error ?? "No matching result"}. No success claimed.`,
				);
		}
		for (const error of errors) console.error(error);
	}
	if (!ok) process.exitCode = classifyExit(1, errors, []);
	return ok;
}
