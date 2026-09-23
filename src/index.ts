#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import { authCommand } from "./commands/auth";
import { batchCommand } from "./commands/batch";
import { cacheCommand } from "./commands/cache";
import { cal } from "./commands/cal";
import { calendarCommand } from "./commands/calendar";
import { completionCommand } from "./commands/completion";
import { convertCommand } from "./commands/convert";
import { doctorCommand } from "./commands/doctor";
import { eventCommand } from "./commands/event";
import { projectCommand } from "./commands/project";
import { refreshCommand } from "./commands/refresh";
import { slotCommand } from "./commands/slot";
import { taskCommand } from "./commands/task";

const main = defineCommand({
	meta: {
		name: "af",
		description: "Akiflow CLI - Task management and automation",
		// Version comes from package.json so `af --version` matches the
		// release the binary was built from. The `just release` recipe
		// bumps `tools/akiflow-cli/package.json:version` in lockstep
		// with the workspace Cargo.toml + Formula/*.rb files, and bun's
		// `--compile` bundles the json import into the binary at build
		// time. Without this, the version was hardcoded and silently
		// drifted from the release tag — homebrew tap formula tests
		// caught it on v0.3.3.
		version: pkg.version,
	},
	subCommands: {
		task: taskCommand,
		event: eventCommand,
		slot: slotCommand,
		batch: batchCommand,
		convert: convertCommand,
		cal,
		calendar: calendarCommand,
		project: projectCommand,
		auth: authCommand,
		cache: cacheCommand,
		doctor: doctorCommand,
		refresh: refreshCommand,
		completion: completionCommand,
	},
});

runMain(main);
