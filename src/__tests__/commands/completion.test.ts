import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { completionCommand } from "../../commands/completion";

describe("completion command", () => {
	let consoleLogSpy: ReturnType<typeof spyOn>;
	let consoleErrorSpy: ReturnType<typeof spyOn>;
	let processExitSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		consoleLogSpy?.mockRestore();
		consoleErrorSpy?.mockRestore();
		processExitSpy?.mockRestore();
	});

	it("generates bash completion script", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("#!/bin/bash");
		expect(output).toContain("_af_completion");
	});

	it("generates zsh completion script", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "zsh" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("#compdef af");
		expect(output).toContain("_af()");
	});

	it("generates fish completion script", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "fish" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("# Fish completion for af");
		expect(output).toContain("complete -c af");
	});

	it("includes all commands in bash completion", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("task");
		expect(output).toContain("event");
		expect(output).toContain("slot");
		expect(output).toContain("project");
		expect(output).toContain("calendar");
		expect(output).not.toContain(" hello");
	});

	it("includes task subcommands in zsh", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "zsh" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("list");
		expect(output).toContain("create");
		expect(output).toContain("complete");
		expect(output).toContain("update");
		expect(output).toContain("plan");
	});

	it("includes project subcommands in fish", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "fish" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("__fish_seen_subcommand_from project");
	});

	it("includes task create flags in bash", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("--today");
		expect(output).toContain("--date");
	});

	it("includes task list flags in bash", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("--inbox");
		expect(output).toContain("--all");
	});

	it("includes event and slot delete commands in bash", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("delete");
		expect(output).toContain("--notify");
	});

	it("includes slot lifecycle flags in bash", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("update");
		expect(output).toContain("--add-task-id");
		expect(output).toContain("--remove-task-id");
		expect(output).toContain("--until");
	});

	it("rejects invalid shell", async () => {
		// given
		consoleErrorSpy = spyOn(console, "error");
		processExitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
		const context = { args: { shell: "invalid" } } as never;

		// when
		try {
			await completionCommand.run?.(context);
		} catch {}

		// then
		expect(consoleErrorSpy).toHaveBeenCalled();
		const errorMsg = consoleErrorSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(errorMsg).toContain("Unknown shell");
	});

	it("handles case-insensitive shell names", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "BASH" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("#!/bin/bash");
	});

	it("bash includes completion registration", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("complete -o bashdefault");
	});

	it("zsh includes completion registration", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "zsh" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("#compdef af");
		expect(output).toContain("_af");
	});

	it("fish includes completion registration", async () => {
		// given
		consoleLogSpy = spyOn(console, "log");
		const context = { args: { shell: "fish" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("complete -c af");
	});
});
