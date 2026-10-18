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
  local cur cword i
  local -a words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words=("\${COMP_WORDS[0]}")
  cword=$COMP_CWORD
  # Remove only complete global booleans before the cursor. Preserve all
  # other words, including inline string values containing flag text.
  for ((i=1; i<\${#COMP_WORDS[@]}; i++)); do
    if (( i < COMP_CWORD )); then
      case "\${COMP_WORDS[i]}" in
        --) return 0 ;;
        --envelope|--envelope=true|--envelope=false|--no-envelope|--no-envelope=true|--no-envelope=false)
          ((cword--)); continue ;;
      esac
    fi
    words+=("\${COMP_WORDS[i]}")
  done

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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function generateZshCompletion(COMMANDS: Record<string, CommandNode>): string {
	const cases = collectCommandPaths(COMMANDS)
		.sort((a, b) => b.path.length - a.path.length)
		.map(({ path, node }) => {
			const condition = path
				.map(
					(segment, index) =>
						`"\${command_words[${index + 2}]}" == ${shellQuote(segment)}`,
				)
				.join(" && ");
			const suggestions = [...subcommandNames(node), ...node.flags]
				.map(shellQuote)
				.join(" ");
			return `
  if [[ ${condition} && $command_current -ge ${path.length + 2} ]]; then
    suggestions=(${suggestions})
    _describe 'argument' suggestions
    return
  fi`;
		})
		.join("");
	return `#compdef af
_af() {
  local -a suggestions command_words
  local command_current=$CURRENT i
  command_words=("\${words[1]}")
  for ((i=2; i<=\${#words}; i++)); do
    if (( i < CURRENT )); then
      case "\${words[i]}" in
        --) return ;;
        --envelope|--envelope=true|--envelope=false|--no-envelope|--no-envelope=true|--no-envelope=false)
          ((command_current--)); continue ;;
      esac
    fi
    command_words+=("\${words[i]}")
  done
  if (( command_current == 2 )); then
    suggestions=(${Object.keys(COMMANDS).map(shellQuote).join(" ")})
    _describe 'command' suggestions
    return
  fi
${cases}
}
_af
`;
}

function generateFishCompletion(COMMANDS: Record<string, CommandNode>): string {
	const lines: string[] = [];
	for (const { path, node } of collectCommandPaths(COMMANDS)) {
		const parent = path.slice(0, -1).join(" ");
		lines.push(
			`complete -c af -f -n '__af_path ${parent}' -a ${shellQuote(path.at(-1) ?? "")} -d ${shellQuote(node.description)}`,
		);
		for (const flag of node.flags) {
			const option = flag.startsWith("--")
				? `-l ${flag.slice(2)}`
				: `-s ${flag.slice(1)}`;
			lines.push(
				`complete -c af -n '__af_path_flags ${path.join(" ")}' ${option} -d ${shellQuote(node.description)}`,
			);
		}
	}
	return `# Fish completion for af
function __af_tokens
    set -l tokens (commandline -opc)
    contains -- -- $tokens; and return 1
    for token in $tokens
        switch $token
            case --envelope --envelope=true --envelope=false --no-envelope --no-envelope=true --no-envelope=false
                continue
        end
        printf '%s\\n' "$token"
    end
end
function __af_path_flags
    set -l tokens (__af_tokens); or return 1
    set -l size (count $argv)
    test (count $tokens) -ge (math $size + 1); or return 1
    if test $size -eq 0
        test (count $tokens) -eq 1
        return
    end
    for i in (seq $size)
        test "$tokens[(math $i + 1)]" = "$argv[$i]"; or return 1
    end
end
function __af_path
    __af_path_flags $argv; or return 1
    set -l tokens (__af_tokens); or return 1
    test (count $tokens) -eq (math (count $argv) + 1)
end
${lines.join("\n")}
`;
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
