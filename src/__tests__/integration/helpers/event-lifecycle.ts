import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeAkiflowServer } from "./fake-server";

interface Operation {
	id: string;
	event_id: string;
	operation: string;
	payload: {
		event?: Record<string, unknown>;
		changes?: Record<string, unknown>;
	};
}

/** Canonical store deliberately independent of operation acceptance. */
export function eventLifecycle(server: FakeAkiflowServer) {
	const records: Array<Record<string, unknown>> = JSON.parse(
		readFileSync(join(import.meta.dir, "../fixtures/events.json"), "utf8"),
	);
	const control = {
		records,
		apply: true,
		delayReads: 0,
		status: "accepted",
		aggregateUnknown: false,
		mixed: false,
		wrongTitle: false,
	};
	let queued: Operation[] = [];
	function apply(operations: Operation[]) {
		for (const op of operations) {
			let record = records.find((record) => record.id === op.event_id);
			if (!record) {
				record = {
					...records[0],
					id: op.event_id,
					content: {},
					end_datetime_tz: null,
				};
				records.push(record);
			}
			if (op.operation === "delete") {
				record.deleted_at = new Date().toISOString();
				record.status = "cancelled";
			} else {
				const fields = op.payload.event ?? op.payload.changes ?? {};
				Object.assign(record, fields);
				if (fields.location !== undefined)
					record.content = { location: fields.location };
				if (control.wrongTitle) record.title = "Server changed title";
			}
		}
	}
	server.respondTo("GET", "/v5/events", () => {
		if (queued.length > 0 && control.delayReads-- <= 0) {
			apply(queued);
			queued = [];
		}
		return {
			success: true,
			data: records,
			has_next_page: false,
			sync_token: "lifecycle",
		};
	});
	server.respondTo(
		"POST",
		"/v5/event_operations",
		({ body }: { body: string }) => {
			const operations: Operation[] = JSON.parse(body);
			if (control.aggregateUnknown)
				return { success: false, data: operations, failed: [] };
			if (control.apply && control.status === "accepted") {
				if (control.delayReads > 0) queued = operations;
				else apply(operations);
			}
			return {
				success: !control.mixed,
				data: operations
					.filter((_, index) => !control.mixed || index === 0)
					.map((op, index) => ({
						...op,
						status: control.mixed
							? index === 0
								? "failed"
								: "accepted"
							: control.status === "accepted"
								? "succeeded"
								: control.status,
						failed_at:
							control.status === "failed" || (control.mixed && index === 0)
								? "2026-09-30T00:00:00Z"
								: null,
						error:
							control.status === "failed" || (control.mixed && index === 0)
								? "Rejected by fixture"
								: undefined,
					})),
				failed: control.mixed
					? [{ id: operations[0]?.id, error: "Rejected by fixture" }]
					: [],
			};
		},
	);
	return control;
}
