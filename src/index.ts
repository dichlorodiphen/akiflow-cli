#!/usr/bin/env bun
import { renderUsage, runCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { main } from "./command-tree";
import { validateDateSelectors } from "./lib/date-selector";
import { EXIT_CODES } from "./lib/exit-codes";
import { installOutputContract, setOutputCommand } from "./lib/output-contract";
import { selectProfile } from "./lib/profiles";
import { type ValidatedArgs, validateArgv } from "./lib/strict-args";

const argv = process.argv.slice(2);
installOutputContract(argv, "af");
let validated: ValidatedArgs;
try {
	validated = await validateArgv(main, argv);
	setOutputCommand(validated.command);
	if (!validated.help && !validated.version)
		selectProfile(
			typeof validated.values.profile === "string"
				? validated.values.profile
				: undefined,
		);
	if (
		!validated.help &&
		!validated.version &&
		["task list", "cal", "audit", "reconcile"].includes(validated.command)
	)
		validateDateSelectors(validated.values);
	if (
		!validated.help &&
		!validated.version &&
		(validated.command === "slot list" ||
			validated.command.startsWith("batch "))
	)
		validateDateSelectors({
			...validated.values,
			to: validated.values.to ?? validated.values.until,
		});
} catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : error}`);
	process.exit(EXIT_CODES.validation);
}
// Use one validated interpretation for dispatch. citty's raw parser treats inline
// booleans as strings and makes any --no-* override later positive flags.
try {
	if (validated.version) {
		console.log(pkg.version);
	} else if (
		validated.help ||
		(validated.definition.subCommands && !validated.definition.run)
	) {
		console.log(await renderUsage(validated.definition, validated.parent));
	} else {
		const flags = Object.entries(validated.values).flatMap(([name, value]) => {
			if (name === "envelope" || name === "profile") return [];
			if (typeof value === "boolean")
				return [value ? `--${name}` : `--no-${name}`];
			return [`--${name}=${value}`];
		});
		const definition = validated.definition;
		await runCommand(
			{
				...definition,
				run: definition.run
					? (context) =>
							definition.run?.({
								...context,
								args: Object.assign(context.args, validated.repeatedValues),
							})
					: undefined,
			},
			{ rawArgs: [...flags, "--", ...validated.positionals] },
		);
	}
} catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}
