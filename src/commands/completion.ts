import { defineCommand } from "citty";

type ShellType = "bash" | "zsh" | "fish";

import { type CommandNode, commandManifest } from "../lib/command-tree";

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

function generateBashCompletion(COMMANDS: Record<string, CommandNode>): string {
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

function generateZshCompletion(COMMANDS: Record<string, CommandNode>): string {
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

function generateFishCompletion(COMMANDS: Record<string, CommandNode>): string {
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
			process.exit(2);
		}

		const { main } = await import("../command-tree");
		const COMMANDS = await commandManifest(main);

		if (shell === "bash") console.log(generateBashCompletion(COMMANDS));
		if (shell === "zsh") console.log(generateZshCompletion(COMMANDS));
		if (shell === "fish") console.log(generateFishCompletion(COMMANDS));
	},
});
