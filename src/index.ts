#!/usr/bin/env bun
import { runMain } from "citty";
import { main } from "./command-tree";
import { validateDateSelectors } from "./lib/date-selector";
import { EXIT_CODES } from "./lib/exit-codes";
import { installOutputContract, setOutputCommand } from "./lib/output-contract";
import { validateArgv } from "./lib/strict-args";

const argv = process.argv.slice(2);
installOutputContract(argv, "af");
try {
	const validated = await validateArgv(main, argv);
	setOutputCommand(validated.command);
	if (["task list", "cal", "audit"].includes(validated.command))
		validateDateSelectors(validated.values);
	if (
		validated.command === "slot list" ||
		validated.command.startsWith("batch ")
	)
		validateDateSelectors({
			...validated.values,
			to: validated.values.to ?? validated.values.until,
		});
} catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : error}`);
	process.exit(EXIT_CODES.validation);
}
const terminator = argv.indexOf("--");
const dispatchArgs = argv.filter(
	(token, index) =>
		(terminator >= 0 && index >= terminator) ||
		!/^--(?:no-)?envelope(?:=.*)?$/.test(token),
);
await runMain(main, { rawArgs: dispatchArgs });
