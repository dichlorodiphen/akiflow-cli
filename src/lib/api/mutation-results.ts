import type {
	ApiResponse,
	EventOperation,
	EventOperationPayload,
	MutationReceipt,
	MutationResult,
} from "./types";

/** Match operation IDs, never event IDs or response array positions. */
export function parseEventMutationResult(
	raw: ApiResponse<EventOperation[]>,
	submitted: EventOperationPayload[],
): MutationResult {
	const ids = new Set(submitted.map((operation) => operation.id));
	const returned = new Map(
		(Array.isArray(raw.data) ? raw.data : []).map((operation) => [
			operation.id,
			operation,
		]),
	);
	const failures = new Map(
		(raw.failed ?? [])
			.filter((failure) => ids.has(failure.id ?? ""))
			.map((failure) => [failure.id, failure]),
	);
	const warnings = (raw.failed ?? [])
		.filter((failure) => !ids.has(failure.id ?? ""))
		.map((failure) => ({
			message: "Unmatched envelope failure",
			...failure,
		}));
	const ambiguousEnvelope = raw.success !== true && failures.size === 0;
	const receipts = [...submitted]
		.sort((a, b) => a.client_order - b.client_order)
		.map((operation): MutationReceipt => {
			const record = returned.get(operation.id);
			const failure = failures.get(operation.id);
			const receipt: MutationReceipt = {
				operation_id: operation.id,
				event_id: operation.event_id,
				kind: operation.operation,
				status: "unknown",
				failed_at: record?.failed_at ?? null,
				processed_at: record?.processed_at ?? null,
				result: record?.result ?? null,
			};
			const errors: unknown[] = [...warnings];
			if (!Array.isArray(raw.data) || raw.data.length === 0) {
				errors.push(raw.message ?? "Response omitted operation results");
				if (failure?.error !== undefined) errors.push(failure.error);
			} else if (ambiguousEnvelope) {
				errors.push(
					raw.message ?? "Envelope failure has no identifiable operation ID",
				);
			} else if (
				failure ||
				record?.failed_at != null ||
				record?.status === "failed"
			) {
				receipt.status = "failed";
				errors.push(
					failure?.error ?? record?.result ?? raw.message ?? "Operation failed",
				);
			} else if (record) {
				if (record.status === "pending" && record.processed_at == null) {
					receipt.status = "pending";
				} else if (record.status == null || record.status === "succeeded") {
					receipt.status = "accepted";
				} else {
					errors.push(
						`Unrecognized or contradictory operation status: ${record.status}`,
					);
				}
			}
			if (errors.length > 0)
				receipt.error = errors.length === 1 ? errors[0] : errors;
			return receipt;
		});
	return {
		receipts,
		raw,
		allAccepted: receipts.every((receipt) => receipt.status === "accepted"),
	};
}
