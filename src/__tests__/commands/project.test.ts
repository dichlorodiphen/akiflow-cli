/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { projectCommand } from "../../commands/project";

describe("project command", () => {
	it("has list subcommand", () => {
		// given
		const subCommands = projectCommand.subCommands as Record<
			string,
			{
				meta?: { name?: string; description?: string };
				run?: (ctx?: unknown) => Promise<void>;
				args?: Record<string, { type?: string }>;
			}
		>;

		// when
		const listCommand = subCommands?.list;

		// then
		expect(listCommand).toBeDefined();
		expect(listCommand?.meta?.name).toBe("list");
	});

	it("project command has correct metadata", () => {
		// given
		const meta = projectCommand.meta as { name?: string; description?: string };

		// when
		const name = meta.name;
		const description = meta.description;

		// then
		expect(name).toBe("project");
		expect(description).toContain("project");
	});

	it("only exposes read-only list subcommand", () => {
		// given
		const subCommands = projectCommand.subCommands as Record<string, unknown>;

		expect(Object.keys(subCommands)).toEqual(["list"]);
	});
});
