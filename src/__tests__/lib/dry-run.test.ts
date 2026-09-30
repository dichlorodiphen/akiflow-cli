import { describe, expect, test } from "bun:test";
import { previewItem } from "../../lib/dry-run";

describe("dry-run normalized preview", () => {
	test("reports changed fields with null for missing values and excludes transport timestamps", () => {
		expect(
			previewItem(
				{ id: "task", title: "Old", duration: 60 },
				{
					id: "task",
					title: "New",
					date: "2026-06-20",
					global_updated_at: "now",
				},
			),
		).toEqual({
			id: "task",
			title: "New",
			before: { title: "Old", date: null },
			after: { title: "New", date: "2026-06-20" },
			notification_policy: "none",
		});
	});
	test("creation has no before value and explicitly states attendee policy", () => {
		expect(previewItem(null, { id: "event", title: "Meeting" }, "all")).toEqual(
			{
				id: "event",
				title: "Meeting",
				before: null,
				after: { title: "Meeting" },
				notification_policy: "all",
			},
		);
	});
});
