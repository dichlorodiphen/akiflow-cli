import { describe, expect, it } from "bun:test";
import type { AkiflowClient } from "../../lib/api/client";
import type { ApiResponse } from "../../lib/api/types";
import {
	verifyEventDeleted,
	verifyEventFields,
	verifyTaskDeleted,
	verifyTaskFields,
} from "../../lib/verification";

const event = {
	id: "synthetic-event",
	title: "Meeting",
	description: "Discussion",
	content: { location: "Office" },
	start_time: "2026-06-20T16:00:00Z",
	end_time: "2026-06-20T16:30:00Z",
	start_datetime_tz: "America/Los_Angeles",
	end_datetime_tz: "America/Los_Angeles",
	status: "confirmed",
	deleted_at: null,
};
const expected = {
	title: "Meeting",
	description: "Discussion",
	location: "Office",
	start_time: "2026-06-20T09:00:00-07:00",
	end_time: "2026-06-20T16:30:00.000Z",
	start_datetime_tz: "America/Los_Angeles",
	end_datetime_tz: "America/Los_Angeles",
};
const bounds = { timeoutMs: 150, pollIntervalMs: 1 };
function transport(
	handler: (
		path: string,
		params: { sync_token?: string; limit?: number },
	) => Promise<ApiResponse<unknown[]>> | ApiResponse<unknown[]>,
) {
	const calls: Array<{
		path: string;
		params: { sync_token?: string; limit?: number };
	}> = [];
	return {
		calls,
		client: {
			async get<T>(
				path: string,
				params: { sync_token?: string; limit?: number } = {},
			): Promise<ApiResponse<T>> {
				calls.push({ path, params });
				return (await handler(path, params)) as ApiResponse<T>;
			},
		} satisfies Pick<AkiflowClient, "get">,
	};
}
const page = (data: unknown[], extra = {}): ApiResponse<unknown[]> => ({
	success: true,
	message: null,
	data,
	...extra,
});

describe("fresh event verification", () => {
	it("verifies all fields on later pages and normalizes instants", async () => {
		const fake = transport((_path, params) =>
			params.sync_token
				? page([event])
				: page([], { has_next_page: true, sync_token: "page-2" }),
		);
		const result = await verifyEventFields(
			fake.client,
			event.id,
			expected,
			bounds,
		);
		expect(result.status).toBe("verified");
		expect(result.observed).toMatchObject(event);
		expect(fake.calls.map((call) => call.path)).toEqual([
			"/v5/events",
			"/v5/events",
		]);
		expect(fake.calls.map((call) => call.params.sync_token)).toEqual([
			undefined,
			"page-2",
		]);
	});
	it("polls invisibility then verifies, restarting each scan uncached", async () => {
		let scans = 0;
		const fake = transport(() => page(++scans === 1 ? [] : [event]));
		expect(
			(await verifyEventFields(fake.client, event.id, expected, bounds)).status,
		).toBe("verified");
		expect(scans).toBe(2);
		expect(
			fake.calls.every((call) => call.params.sync_token === undefined),
		).toBe(true);
	});
	it("returns pending for a single scan without a visible event", async () => {
		const fake = transport(() => page([]));
		expect(
			(
				await verifyEventFields(fake.client, event.id, expected, {
					...bounds,
					singlePoll: true,
				})
			).status,
		).toBe("pending");
	});
	it("polls explicitly pending observed differences then verifies", async () => {
		let scans = 0;
		const fake = transport(() =>
			page([
				++scans === 1 ? { ...event, title: "Old", status: "pending" } : event,
			]),
		);
		expect(
			(await verifyEventFields(fake.client, event.id, expected, bounds)).status,
		).toBe("verified");
		expect(scans).toBe(2);
	});
	it("reports each requested difference including exact zone strings", async () => {
		for (const [field, value] of Object.entries({
			title: "Other",
			description: "Other",
			location: "Other",
			start_time: "2026-06-20T16:01:00Z",
			end_time: "2026-06-20T16:31:00Z",
			start_datetime_tz: "US/Pacific",
			end_datetime_tz: "US/Pacific",
		})) {
			const different =
				field === "location"
					? { ...event, content: { location: value } }
					: { ...event, [field]: value };
			const fake = transport(() => page([different]));
			const result = await verifyEventFields(
				fake.client,
				event.id,
				expected,
				bounds,
			);
			expect(result.status).toBe("mismatch");
			expect(result.differingFields).toEqual([field]);
		}
	});
	it("never verifies tombstones or invalid timestamps", async () => {
		const fake = transport(() =>
			page([{ ...event, deleted_at: "2026-06-21T00:00:00Z" }]),
		);
		expect(
			(await verifyEventFields(fake.client, event.id, {}, bounds)).status,
		).toBe("mismatch");
		const invalid = transport(() =>
			page([{ ...event, start_time: "invalid" }]),
		);
		expect(
			(
				await verifyEventFields(
					invalid.client,
					event.id,
					{ start_time: "invalid" },
					bounds,
				)
			).status,
		).toBe("mismatch");
	});
	it("returns timeout and never success when visibility never arrives", async () => {
		const fake = transport(() => page([]));
		const result = await verifyEventFields(fake.client, event.id, expected, {
			timeoutMs: 10,
			pollIntervalMs: 2,
		});
		expect(result.status).toBe("timeout");
		expect(result.status).not.toBe("verified");
	});
	it("bounds a hung HTTP read and refuses late success", async () => {
		const fake = transport(
			() =>
				new Promise((resolve) => setTimeout(() => resolve(page([event])), 50)),
		);
		expect(
			(
				await verifyEventFields(fake.client, event.id, expected, {
					timeoutMs: 5,
					pollIntervalMs: 1,
				})
			).status,
		).toBe("timeout");
	});
	it("rejects cursor cycles, page exhaustion and failure envelopes without claiming success", async () => {
		for (const handler of [
			() => page([event], { has_next_page: true, sync_token: "same" }),
			() => ({ success: false, message: "denied", data: [event] }),
		]) {
			const fake = transport(handler);
			const result = await verifyEventFields(fake.client, event.id, expected, {
				...bounds,
				singlePoll: true,
			});
			expect(result.status).toBe("pending");
			expect(result.error).toBeDefined();
		}
		const fake = transport(() =>
			page([event], { has_next_page: true, sync_token: "next" }),
		);
		const result = await verifyEventFields(fake.client, event.id, expected, {
			...bounds,
			singlePoll: true,
			maxPages: 1,
		});
		expect(result.status).toBe("pending");
		expect(result.error).toContain("page limit");
	});
	it("folds later canonical versions before comparison", async () => {
		const fake = transport((_path, params) =>
			params.sync_token
				? page([{ ...event, read_only: true, title: "Canonical" }])
				: page([event], { has_next_page: true, sync_token: "next" }),
		);
		const result = await verifyEventFields(
			fake.client,
			event.id,
			{ title: "Canonical" },
			bounds,
		);
		expect(result.status).toBe("verified");
		expect(result.observed?.read_only).toBe(true);
	});
	it("validates bounds and does no reads for an elapsed deadline", async () => {
		const fake = transport(() => page([event]));
		expect(
			(
				await verifyEventFields(fake.client, event.id, expected, {
					timeoutMs: 0,
				})
			).status,
		).toBe("timeout");
		expect(fake.calls).toHaveLength(0);
		await expect(
			verifyEventFields(fake.client, event.id, expected, { pollIntervalMs: 0 }),
		).rejects.toBeInstanceOf(RangeError);
	});
});

it("verifies tasks with fresh paginated reads too", async () => {
	const fake = transport(() =>
		page([
			{
				id: "task",
				title: "Task",
				datetime: "2026-06-20T16:00:00Z",
				datetime_tz: "America/Los_Angeles",
				done: true,
			},
		]),
	);
	const result = await verifyTaskFields(
		fake.client,
		"task",
		{
			title: "Task",
			datetime: "2026-06-20T09:00:00-07:00",
			datetime_tz: "America/Los_Angeles",
			done: true,
		},
		bounds,
	);
	expect(result.status).toBe("verified");
	expect(fake.calls[0]?.path).toBe("/v5/tasks");
});

describe("fresh deletion verification", () => {
	it("requires an observed tombstone rather than an absent record", async () => {
		const absent = transport(() => page([]));
		expect(
			(
				await verifyEventDeleted(absent.client, event.id, {
					...bounds,
					singlePoll: true,
				})
			).status,
		).toBe("pending");
		const live = transport(() => page([event]));
		expect(
			(
				await verifyEventDeleted(live.client, event.id, {
					...bounds,
					singlePoll: true,
				})
			).status,
		).toBe("pending");
		const tombstone = transport(() =>
			page([{ ...event, deleted_at: "2026-06-20T16:00:01Z" }]),
		);
		expect(
			(await verifyEventDeleted(tombstone.client, event.id, bounds)).status,
		).toBe("verified");
		expect(
			(await verifyTaskDeleted(tombstone.client, event.id, bounds)).status,
		).toBe("verified");
	});
});
