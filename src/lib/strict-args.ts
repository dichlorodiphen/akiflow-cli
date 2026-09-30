import type { ArgDef, CommandDef } from "citty";
import { GLOBAL_ARGS, resolveDefinition } from "./command-tree";
import { UsageError } from "./exit-codes";

// citty has no variadic positional definition. These resource verbs explicitly
// accept a list in their documented positional contract.
const VARIADIC_PATHS = new Set([
	"task complete",
	"event attendees add",
	"event attendees remove",
	"batch events attendees add",
	"batch events attendees remove",
]);

export interface ValidatedArgs {
	command: string;
	values: Record<string, string | boolean>;
}

/** Validate raw argv before citty can run setup, auth, or cache operations. */
export async function validateArgv(
	root: CommandDef,
	argv: string[],
): Promise<ValidatedArgs> {
	let command = root;
	const path: string[] = [];
	const values: Record<string, string | boolean> = {};
	const positionals: string[] = [];
	let terminated = false;
	let help = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		const args = {
			...GLOBAL_ARGS,
			...(await resolveDefinition(command.args, {})),
		};
		const options = new Map<string, { name: string; definition: ArgDef }>();
		for (const [name, definition] of Object.entries(args)) {
			if (definition.type === "positional") continue;
			options.set(name, { name, definition });
			for (const alias of "alias" in definition
				? typeof definition.alias === "string"
					? [definition.alias]
					: (definition.alias ?? [])
				: [])
				options.set(alias, { name, definition });
		}
		if (!terminated && token === "--") {
			terminated = true;
			continue;
		}
		if (!terminated && ["--help", "-h", "--version", "-v"].includes(token)) {
			help = true;
			continue;
		}
		if (!terminated && token.startsWith("-") && token !== "-") {
			const long = token.startsWith("--");
			const spelling = token.slice(long ? 2 : 1);
			const eq = spelling.indexOf("=");
			const key = eq < 0 ? spelling : spelling.slice(0, eq);
			const inline = eq < 0 ? undefined : spelling.slice(eq + 1);
			const keys = long || options.has(key) || eq >= 0 ? [key] : [...key];
			for (let k = 0; k < keys.length; k++) {
				const item = keys[k] ?? "";
				const negative = long && item.startsWith("no-") && !options.has(item);
				const option = options.get(negative ? item.slice(3) : item);
				if (!option || (negative && option.definition.type !== "boolean"))
					throw new UsageError(`Unknown flag ${token}`);
				if (option.definition.type === "boolean") {
					if (inline !== undefined && !["true", "false"].includes(inline))
						throw new UsageError(`Invalid boolean value ${token}`);
					values[option.name] =
						inline === undefined ? !negative : inline === "true";
				} else {
					const bundled =
						keys.length > 1 ? keys.slice(k + 1).join("") : undefined;
					const value = inline ?? (bundled || argv[++i]);
					if (
						value === undefined ||
						(!inline && !bundled && value.startsWith("-"))
					)
						throw new UsageError(`Missing value for ${token}`);
					if (
						option.definition.type === "enum" &&
						!option.definition.options?.includes(value)
					)
						throw new UsageError(`Invalid value ${value} for ${token}`);
					values[option.name] = value;
					break;
				}
			}
			continue;
		}
		const children = await resolveDefinition(command.subCommands, {});
		if (!terminated && Object.keys(children).length && !positionals.length) {
			const child = children[token];
			if (!child) throw new UsageError(`Unknown command ${token}`);
			command = await resolveDefinition(child, {});
			path.push(token);
			continue;
		}
		positionals.push(token);
		const declared = Object.values(args).filter(
			(arg) => arg.type === "positional",
		);
		if (
			positionals.length > declared.length &&
			!VARIADIC_PATHS.has(path.join(" "))
		)
			throw new UsageError(`Unexpected positional ${token}`);
	}
	const args = await resolveDefinition(command.args, {});
	if (!help) {
		let index = 0;
		for (const [name, arg] of Object.entries(args)) {
			if (arg.type === "positional") {
				if (arg.required && !positionals[index])
					throw new UsageError(`Missing positional ${name}`);
				index++;
			} else if (
				arg.required &&
				arg.default === undefined &&
				values[name] === undefined
			)
				throw new UsageError(`Missing required flag --${name}`);
		}
	}
	if (values.execute && values["dry-run"])
		throw new UsageError("Contradictory flags --execute and --dry-run");
	return { command: path.join(" ") || "af", values };
}
