import { expect, spyOn } from "bun:test";
import { AkiflowClient } from "../../lib/api/client";
import type { MutationResult } from "../../lib/api/types";

/** Unknown receipts must exit nonzero without fabricated event state. */
export async function expectReceiptOnlyCommandFailure(action: () => unknown) {
	const exit = spyOn(process, "exit").mockImplementation(() => {
		throw new Error("receipt-only exit");
	});
	const mutation = spyOn(AkiflowClient.prototype, "createEvents");
	try {
		await Promise.resolve().then(action);
		expect(process.exitCode).toBe(1);
		expect(mutation).toHaveBeenCalledTimes(1);
		const result = await (mutation.mock.results[0]
			?.value as Promise<MutationResult>);
		expect(result.receipts).toHaveLength(1);
		expect(result.receipts[0]?.event_id).toBe(
			mutation.mock.calls[0]?.[0]?.[0]?.id,
		);
		expect(result.receipts[0]?.status).toBe("unknown");
		expect(result.allAccepted).toBe(false);
		expect("data" in result).toBe(false);
		return result;
	} finally {
		mutation.mockRestore();
		exit.mockRestore();
		process.exitCode = 0;
	}
}
