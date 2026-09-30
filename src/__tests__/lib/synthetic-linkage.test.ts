import { expect, spyOn, test } from "bun:test";
import { createSlotCommand } from "../../commands/create";
import { resolveCachedTask } from "../../commands/slot";
import type { Task } from "../../lib/api/types";

const id = "virtual:aaaaaaaa-1111-1111-1111-111111111111:2026-09-30";

test("slot task resolver rejects direct virtual IDs and matching synthetic prefixes", () => {
	const exit = spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit:${code}`);
	});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(() => resolveCachedTask([], id)).toThrow("exit:2");
		expect(() =>
			resolveCachedTask([{ id, title: "Virtual" } as Task], "vir"),
		).toThrow("exit:2");
		expect(error.mock.calls.flat().join(" ")).toContain("Synthetic task ID");
	} finally {
		exit.mockRestore();
		error.mockRestore();
	}
});

test("slot creation preflights synthetic task IDs before parsing time or resolving calendars", async () => {
	const exit = spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit:${code}`);
	});
	const error = spyOn(console, "error").mockImplementation(() => {});
	try {
		await expect(
			createSlotCommand.run?.({ args: { "task-id": id } } as never),
		).rejects.toThrow("exit:2");
		expect(error.mock.calls.flat().join(" ")).toContain("Synthetic task ID");
	} finally {
		exit.mockRestore();
		error.mockRestore();
	}
});
