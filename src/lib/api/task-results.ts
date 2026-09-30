import type { ApiResponse } from "./types";

export interface TaskMutationResult {
	ok: boolean;
	succeededIds: string[];
	failedIds: string[];
	unknownIds: string[];
	errors: string[];
}

/** Aggregate failure cannot identify which task failed. Failure IDs win over data. */
export function checkTaskMutationResult(
	response: ApiResponse<Array<{ id: string }>>,
	requestedIds: readonly string[],
): TaskMutationResult {
	const requested = new Set(requestedIds);
	const returned = new Set((response.data ?? []).map((task) => task.id));
	const failed = new Set((response.failed ?? []).map((failure) => failure.id));
	const result: TaskMutationResult = {
		ok: false,
		succeededIds: [],
		failedIds: [],
		unknownIds: [],
		errors: [],
	};
	if (!response.success)
		result.errors.push(
			response.message ?? "Task mutation envelope reported failure",
		);
	for (const failure of response.failed ?? []) {
		result.errors.push(
			`${failure.id ?? "Unidentified task"}: ${typeof failure.error === "string" ? failure.error : (JSON.stringify(failure.error) ?? "Task mutation failed")}`,
		);
		if (!requested.has(failure.id ?? ""))
			result.errors.push(`Unmatched failure ID: ${failure.id ?? "missing"}`);
	}
	for (const id of requested) {
		if (failed.has(id)) result.failedIds.push(id);
		else if (returned.has(id)) result.succeededIds.push(id);
		else result.unknownIds.push(id);
	}
	result.ok =
		response.success === true &&
		result.failedIds.length === 0 &&
		result.unknownIds.length === 0 &&
		result.errors.length === 0;
	return result;
}
