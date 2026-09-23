import { describe, expect, test } from "bun:test";
import { spawnCli } from "./helpers/spawn-cli";

describe("af command surface", () => {
	test("help exposes only resource-first top-level commands", async () => {
		const result = await spawnCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("task");
		expect(result.stdout).toContain("event");
		expect(result.stdout).toContain("slot");
		expect(result.stdout).toContain("convert");
		expect(result.stdout).not.toContain(" add ");
		expect(result.stdout).not.toContain(" ls ");
		expect(result.stdout).not.toContain(" do ");
		expect(result.stdout).not.toContain(" block ");
		expect(result.stdout).not.toContain("create|");
		expect(result.stdout).not.toContain("hello");
	});

	test("removed legacy commands fail as unknown commands", async () => {
		for (const command of ["add", "ls", "do", "block", "create", "hello"]) {
			const result = await spawnCli([command]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(`Unknown command ${command}`);
		}
	});

	test("task help exposes canonical task verbs only", async () => {
		const result = await spawnCli(["task", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("list");
		expect(result.stdout).toContain("create");
		expect(result.stdout).toContain("complete");
		expect(result.stdout).toContain("update");
		expect(result.stdout).not.toContain("edit");
		expect(result.stdout).not.toContain("move");
	});
});
