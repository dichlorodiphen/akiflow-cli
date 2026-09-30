import type { ArgsDef, CommandDef, Resolvable } from "citty";

export async function resolveDefinition<T>(
	value: Resolvable<T> | undefined,
	fallback: T,
): Promise<T> {
	return value === undefined
		? fallback
		: await (typeof value === "function"
				? (value as () => T | Promise<T>)()
				: value);
}

export interface CommandNode {
	description: string;
	flags: string[];
	subcommands?: Record<string, CommandNode>;
}

export const GLOBAL_ARGS: ArgsDef = {
	envelope: {
		type: "boolean",
		description: "Use version 1 JSON output envelope (migration opt-in)",
	},
};

/** The same resolved citty definitions feed validation and shell completions. */
export async function commandManifest(
	command: CommandDef,
): Promise<Record<string, CommandNode>> {
	const children = await resolveDefinition(command.subCommands, {});
	const result: Record<string, CommandNode> = {};
	for (const [name, value] of Object.entries(children)) {
		const child = await resolveDefinition(value, {});
		const meta = await resolveDefinition(child.meta, {});
		const args: ArgsDef = {
			...GLOBAL_ARGS,
			...(await resolveDefinition<ArgsDef>(child.args, {})),
		};
		const flags = Object.entries(args).flatMap(([key, arg]) => {
			if (arg.type === "positional") return [];
			const aliases =
				"alias" in arg
					? typeof arg.alias === "string"
						? [arg.alias]
						: (arg.alias ?? [])
					: [];
			return [
				`--${key}`,
				...aliases.map((alias) => `${alias.length === 1 ? "-" : "--"}${alias}`),
				...(arg.type === "boolean" ? [`--no-${key}`] : []),
			];
		});
		const subcommands = await commandManifest(child);
		result[name] = {
			description: meta.description ?? "",
			flags,
			...(Object.keys(subcommands).length ? { subcommands } : {}),
		};
	}
	return result;
}
