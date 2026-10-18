import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveProjectId } from "../../commands/create";
import { AkiflowClient } from "../../lib/api/client";
import type { Label } from "../../lib/api/types";

const project = (
	id: string,
	title: string,
	deleted_at: string | null = null,
) => ({ id, title, deleted_at });
let mocked: ReturnType<typeof spyOn> | undefined;
afterEach(() => mocked?.mockRestore());
test("task project selection uses full paginated inventory, explicit IDs and refuses ambiguous titles", async () => {
	mocked = spyOn(AkiflowClient.prototype, "getLabels").mockImplementation(
		async (options) => ({
			success: true,
			message: null,
			data: (options?.syncToken
				? [project("second", "Work"), project("trash", "Gone", "2026-01-01")]
				: [project("first", "Work")]) as Label[],
			has_next_page: !options?.syncToken,
			sync_token: "next",
		}),
	);
	expect(await resolveProjectId("second")).toBe("second");
	await expect(resolveProjectId("work")).rejects.toThrow("Ambiguous");
	await expect(resolveProjectId("trash")).rejects.toThrow("not found");
});
