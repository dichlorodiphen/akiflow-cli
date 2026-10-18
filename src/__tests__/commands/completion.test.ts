import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const context = { args: { shell: "fish" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("__af_path_flags project list");
	});

	it("includes task create flags in bash", async () => {
		// given
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
		const context = { args: { shell: "bash" } } as never;

		// when
		await completionCommand.run?.(context);

		// then
		const output = consoleLogSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.join("\n");
		expect(output).toContain("delete");
		expect(output).toContain("--send-updates");
		expect(output).not.toContain("--notify");
	});

	it("includes slot lifecycle flags in bash", async () => {
		// given
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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
		consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
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

it.each([
	"bash",
	"zsh",
	"fish",
])("includes reconcile and its flags in %s completion", async (shell) => {
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		await completionCommand.run?.({ args: { shell } } as never);
		const output = log.mock.calls.map((call) => String(call[0])).join("\n");
		expect(output).toContain("reconcile");
		expect(output).toContain(shell === "fish" ? "google-cmd" : "--google-cmd");
		for (const flag of [
			"today",
			"tomorrow",
			"date",
			"from",
			"to",
			"timezone",
			"calendar",
			"json",
		])
			expect(output).toContain(shell === "fish" ? flag : `--${flag}`);
	} finally {
		log.mockRestore();
	}
});

it.skipIf(!existsSync("/bin/zsh"))(
	"zsh completes nested attendee flags in the executing shell",
	async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			await completionCommand.run?.({ args: { shell: "zsh" } } as never);
			const script = String(log.mock.calls.at(-1)?.[0]).replace(/_af\n$/, "");
			const result = spawnSync(
				"/bin/zsh",
				[
					"-f",
					"-c",
					`${script}
_describe() { printf '%s\\n' "\${suggestions[@]}"; }
words=(af event attendees add '')
CURRENT=5
_af
`,
				],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout.split("\n")).toContain("--send-updates");
			expect(result.stdout).not.toContain("--duration");
		} finally {
			log.mockRestore();
		}
	},
);

it("fish scopes duplicate verb names to the full resource path", async () => {
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		await completionCommand.run?.({ args: { shell: "fish" } } as never);
		const script = String(log.mock.calls.at(-1)?.[0]);
		expect(script).toContain("-n '__af_path_flags event create' -l rrule");
		expect(script).not.toContain("-n '__af_path_flags task create' -l rrule");
	} finally {
		log.mockRestore();
	}
});

for (const shell of ["bash", "zsh"] as const) {
	it.skipIf(!existsSync(`/bin/${shell}`))(
		`${shell} resolves completion after global envelope booleans`,
		async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});
			let script: string;
			try {
				await completionCommand.run?.({ args: { shell } } as never);
				script = String(log.mock.calls.at(-1)?.[0]);
			} finally {
				log.mockRestore();
			}
			if (shell === "zsh") script = script.replace(/_af\n$/, "");
			const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
			for (const specimen of [
				{ words: ["af", "--envelope", ""], wanted: "task" },
				{
					words: ["af", "--no-envelope=false", "event", "attendees", "add", ""],
					wanted: "--send-updates",
				},
				{
					words: ["af", "event", "--envelope=true", "attendees", "add", ""],
					wanted: "--send-updates",
				},
				{
					words: [
						"af",
						"--envelope=false",
						"task",
						"create",
						"Title --envelope",
						"--tag=--envelope",
						"",
					],
					wanted: "--date",
				},
				{
					words: ["af", "--envelope", "task", "create", "--", "--envelope", ""],
					wanted: undefined,
				},
			]) {
				const words = specimen.words.map(quote).join(" ");
				const run =
					shell === "bash"
						? `
COMP_WORDS=(${words})
COMP_CWORD=${specimen.words.length - 1}
_af_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`
						: `
_describe() { printf '%s\\n' "\${suggestions[@]}"; }
words=(${words})
CURRENT=${specimen.words.length}
_af
`;
				const result = spawnSync(
					`/bin/${shell}`,
					["-f", "-c", `${script}\n${run}`],
					{ encoding: "utf8" },
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				if (specimen.wanted)
					expect(result.stdout.split("\n")).toContain(specimen.wanted);
				else expect(result.stdout.trim()).toBe("");
			}
		},
	);
}
