import { defineCommand } from "citty";

type ShellType = "bash" | "zsh" | "fish";

interface CommandNode {
	description: string;
	flags?: string[];
	subcommands?: Record<string, CommandNode>;
}

const COMMANDS: Record<string, CommandNode> = {
	task: {
		description: "Manage Akiflow tasks",
		subcommands: {
			list: {
				description: "List tasks with filters",
				flags: [
					"--inbox",
					"--all",
					"--done",
					"--trashed",
					"--project",
					"-s",
					"--search",
					"--json",
					"--raw",
					"--plain",
					"--today",
					"--tomorrow",
					"--yesterday",
					"--this-week",
					"--next-week",
					"--this-month",
					"--next-month",
					"--date",
					"--month",
					"--from",
					"--to",
					"--overdue",
					"--status",
					"--planned",
					"--unplanned",
					"--tag",
					"--priority",
					"--connector",
					"--bucket",
					"--recurring",
				],
			},
			create: {
				description: "Create an Akiflow task",
				flags: [
					"--description",
					"-t",
					"--today",
					"--tomorrow",
					"-d",
					"--date",
					"-p",
					"--project",
					"--at",
					"--duration",
					"--json",
				],
			},
			complete: {
				description: "Mark tasks as complete",
				flags: ["--json"],
			},
			update: {
				description: "Update basic task fields",
				flags: [
					"--title",
					"--description",
					"--description-file",
					"--duration",
					"--project",
					"--priority",
					"--json",
				],
			},
			plan: {
				description: "Schedule a task",
				flags: ["--date", "--at"],
			},
			snooze: {
				description: "Push a task back by duration",
				flags: ["--duration"],
			},
			delete: {
				description: "Soft-delete a task",
				flags: [],
			},
		},
	},
	event: {
		description: "Manage timed Google calendar events through Akiflow",
		subcommands: {
			create: {
				description: "Create a timed Google calendar event",
				flags: [
					"-d",
					"--date",
					"--at",
					"--duration",
					"--calendar",
					"--description",
					"--description-file",
					"--location",
					"--json",
				],
			},
			update: {
				description: "Update a timed Google calendar event",
				flags: [
					"-d",
					"--date",
					"--at",
					"--duration",
					"--title",
					"--description",
					"--description-file",
					"--location",
					"--json",
				],
			},
			delete: {
				description: "Soft-delete a timed Google calendar event",
				flags: ["--notify", "--json"],
			},
			attendees: {
				description: "Manage event attendees",
				subcommands: {
					add: {
						description: "Add attendee emails",
						flags: ["--json"],
					},
					remove: {
						description: "Remove attendee emails",
						flags: ["--json"],
					},
				},
			},
		},
	},
	slot: {
		description: "Manage Akiflow task slots",
		subcommands: {
			list: {
				description: "List cached Akiflow task slots",
				flags: ["-s", "--search", "--date", "--from", "--until", "--json"],
			},
			show: {
				description: "Show a cached Akiflow task slot",
				flags: ["--json"],
			},
			create: {
				description: "Create an Akiflow task slot",
				flags: [
					"-d",
					"--date",
					"--at",
					"--duration",
					"--description",
					"--calendar",
					"--task",
					"--task-id",
					"--task-duration",
					"--json",
				],
			},
			update: {
				description: "Update an Akiflow task slot",
				flags: [
					"--title",
					"--date",
					"--at",
					"--duration",
					"--calendar",
					"--add-task-id",
					"--remove-task-id",
					"--json",
				],
			},
			delete: {
				description: "Soft-delete an Akiflow task slot",
				flags: ["--json"],
			},
		},
	},
	batch: {
		description: "Safely mutate selected Akiflow resources in bulk",
		subcommands: {
			events: {
				description: "Batch mutate selected timed Google events",
				subcommands: {
					attendees: {
						description: "Batch manage event attendees",
						subcommands: {
							add: {
								description: "Add attendee emails to selected events",
								flags: [
									"-s",
									"--search",
									"--today",
									"--tomorrow",
									"--yesterday",
									"--this-week",
									"--next-week",
									"--this-month",
									"--next-month",
									"--date",
									"--from",
									"--to",
									"--calendar",
									"--account",
									"--connector",
									"--declined",
									"--execute",
									"--json",
								],
							},
							remove: {
								description: "Remove attendee emails from selected events",
								flags: [
									"-s",
									"--search",
									"--today",
									"--tomorrow",
									"--yesterday",
									"--this-week",
									"--next-week",
									"--this-month",
									"--next-month",
									"--date",
									"--from",
									"--to",
									"--calendar",
									"--account",
									"--connector",
									"--declined",
									"--execute",
									"--json",
								],
							},
						},
					},
					delete: {
						description: "Soft-delete selected events",
						flags: [
							"-s",
							"--search",
							"--today",
							"--tomorrow",
							"--yesterday",
							"--this-week",
							"--next-week",
							"--this-month",
							"--next-month",
							"--date",
							"--from",
							"--to",
							"--calendar",
							"--account",
							"--connector",
							"--declined",
							"--notify",
							"--execute",
							"--json",
						],
					},
				},
			},
			slots: {
				description: "Batch mutate selected Akiflow task slots",
				subcommands: {
					delete: {
						description: "Soft-delete selected task slots",
						flags: [
							"-s",
							"--search",
							"--date",
							"--from",
							"--until",
							"--calendar",
							"--execute",
							"--json",
						],
					},
				},
			},
		},
	},
	convert: {
		description: "Convert between Akiflow surfaces",
		subcommands: {
			tasks: {
				description: "Convert tasks to another surface",
				flags: [
					"--to",
					"--execute",
					"--delete-source",
					"--default-duration",
					"--include-connector-tasks",
					"--calendar",
					"-s",
					"--search",
					"--today",
					"--tomorrow",
					"--yesterday",
					"--this-week",
					"--next-week",
					"--this-month",
					"--next-month",
					"--date",
					"--month",
					"--from",
					"--until",
					"--range-to",
					"--overdue",
					"--status",
					"--planned",
					"--unplanned",
					"--project",
					"--tag",
					"--priority",
					"--connector",
					"--bucket",
					"--recurring",
					"--json",
				],
			},
			slots: {
				description: "Unsupported conversion source",
				flags: ["--to"],
			},
			events: {
				description: "Unsupported conversion source",
				flags: ["--to"],
			},
		},
	},
	project: {
		description: "Inspect Akiflow projects",
		subcommands: {
			list: {
				description: "List projects",
				flags: [],
			},
		},
	},
	calendar: {
		description: "Inspect and resolve Akiflow calendars",
		subcommands: {
			list: {
				description: "List calendars",
				flags: ["--json", "--all"],
			},
			default: {
				description: "Show default event calendar",
				flags: ["--json"],
			},
			resolve: {
				description: "Resolve a calendar",
				flags: ["--json"],
			},
		},
	},
	cal: {
		description: "View calendar timeline",
		flags: [
			"--free",
			"--today",
			"--tomorrow",
			"--yesterday",
			"--this-week",
			"--next-week",
			"--this-month",
			"--next-month",
			"--date",
			"--from",
			"--to",
			"--calendar",
			"--account",
			"--connector",
			"-s",
			"--search",
			"--events",
			"--no-events",
			"--tasks",
			"--no-tasks",
			"--slots",
			"--no-slots",
			"--declined",
			"--all-day-only",
			"--all-day",
			"--no-all-day",
			"--summary",
			"--json",
			"--raw",
		],
	},
	auth: { description: "Manage Akiflow authentication" },
	cache: { description: "Local cache management" },
	doctor: { description: "Diagnostic report" },
	refresh: {
		description: "Sync local cache",
		flags: ["--rebuild", "--json"],
	},
	completion: { description: "Generate shell completion scripts" },
};

function subcommandNames(node: CommandNode | undefined): string[] {
	return Object.keys(node?.subcommands ?? {});
}

function collectCommandPaths(
	commands: Record<string, CommandNode>,
	prefix: string[] = [],
): Array<{ path: string[]; node: CommandNode }> {
	const paths: Array<{ path: string[]; node: CommandNode }> = [];
	for (const [name, node] of Object.entries(commands)) {
		const path = [...prefix, name];
		paths.push({ path, node });
		if (node.subcommands) {
			paths.push(...collectCommandPaths(node.subcommands, path));
		}
	}
	return paths;
}

function bashPathCondition(path: string[]): string {
	return path
		.map(
			(segment, index) => `"${"${words["}${index + 1}${"]}"}" == "${segment}"`,
		)
		.join(" && ");
}

function generateBashCompletion(): string {
	const commands = Object.keys(COMMANDS).join(" ");
	const cases = collectCommandPaths(COMMANDS)
		.sort((a, b) => b.path.length - a.path.length)
		.map(({ path, node }) => {
			const suggestions = [
				...subcommandNames(node),
				...(node.flags ?? []),
			].join(" ");
			if (!suggestions) return "";
			const nextIndex = path.length + 1;
			return `
  if [[ ${bashPathCondition(path)} && $cword -ge ${nextIndex} ]]; then
    COMPREPLY=($(compgen -W "${suggestions}" -- "$cur"))
    return 0
  fi`;
		})
		.join("");

	return `#!/bin/bash
_af_completion() {
  local cur words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words=("\${COMP_WORDS[@]}")
  cword=$COMP_CWORD

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${commands}" -- "$cur"))
    return 0
  fi
${cases}
  return 0
}
complete -o bashdefault -o default -F _af_completion af
`;
}

function zshCommandEntries(commands: Record<string, CommandNode>): string {
	return Object.entries(commands)
		.map(([name, node]) => `'${name}:${node.description}'`)
		.join("\n    ");
}

function generateZshCompletion(): string {
	const main = zshCommandEntries(COMMANDS);
	const cases = Object.entries(COMMANDS)
		.map(([name, node]) => {
			const subs = node.subcommands ? zshCommandEntries(node.subcommands) : "";
			const flags = (node.flags ?? []).map((flag) => `'${flag}'`).join(" ");
			return `
        ${name})
          ${subs ? `_describe 'subcommand' "(${subs})"` : `_arguments ${flags}`}
          ;;`;
		})
		.join("");

	return `#compdef af
_af() {
  local -a commands=(
    ${main}
  )
  _arguments -C '1: :->command' '*::arg:->args'
  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case \${words[2]} in${cases}
      esac
      ;;
  esac
}
_af
`;
}

function fishLines(
	prefix: string[],
	commands: Record<string, CommandNode>,
): string[] {
	const parent = prefix.at(-1);
	const condition = parent
		? `__fish_seen_subcommand_from ${parent}`
		: "__fish_use_subcommand_from_list";
	const lines = Object.entries(commands).map(
		([name, node]) =>
			`complete -c af -f -n "${condition}" -a "${name}" -d "${node.description}"`,
	);

	for (const [name, node] of Object.entries(commands)) {
		if (node.flags) {
			for (const flag of node.flags) {
				if (!flag.startsWith("--")) continue;
				lines.push(
					`complete -c af -n "__fish_seen_subcommand_from ${name}" -l ${flag.slice(2)} -d "${node.description}"`,
				);
			}
		}
		if (node.subcommands)
			lines.push(...fishLines([...prefix, name], node.subcommands));
	}

	return lines;
}

function generateFishCompletion(): string {
	return `# Fish completion for af\n${fishLines([], COMMANDS).join("\n")}\n`;
}

export const completionCommand = defineCommand({
	meta: {
		name: "completion",
		description: "Generate shell completion scripts",
	},
	args: {
		shell: {
			type: "positional",
			description: "Shell type (bash, zsh, or fish)",
			required: true,
		},
	},
	run: async (context) => {
		const shell = (context.args.shell as string).toLowerCase() as ShellType;

		if (!["bash", "zsh", "fish"].includes(shell)) {
			console.error(
				`Error: Unknown shell "${shell}". Supported shells: bash, zsh, fish`,
			);
			process.exit(1);
		}

		if (shell === "bash") console.log(generateBashCompletion());
		if (shell === "zsh") console.log(generateZshCompletion());
		if (shell === "fish") console.log(generateFishCompletion());
	},
});
