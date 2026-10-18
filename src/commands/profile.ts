import { defineCommand } from "citty";
import {
	createProfile,
	listProfiles,
	profileStatus,
	selectedProfile,
	useProfile,
} from "../lib/profiles";

const json = { type: "boolean" as const, description: "Output JSON" };
function show(value: unknown, asJson?: boolean): void {
	console.log(
		asJson
			? JSON.stringify(value, null, 2)
			: typeof value === "string"
				? value
				: JSON.stringify(value, null, 2),
	);
}
export const profileCommand = defineCommand({
	meta: {
		name: "profile",
		description:
			"Manage isolated Akiflow login profiles (not connected provider accounts)",
	},
	subCommands: {
		list: defineCommand({
			meta: { name: "list", description: "List local profiles" },
			args: { json },
			run: ({ args }) =>
				show(
					{ selected: selectedProfile(), profiles: listProfiles() },
					args.json,
				),
		}),
		status: defineCommand({
			meta: {
				name: "status",
				description: "Show selected profile and storage paths",
			},
			args: { json },
			run: ({ args }) => show(profileStatus(), args.json),
		}),
		create: defineCommand({
			meta: {
				name: "create",
				description: "Create an empty profile; credentials are never copied",
			},
			args: { name: { type: "positional", required: true }, json },
			run: ({ args }) => {
				createProfile(args.name);
				show({ created: args.name, authenticated: false }, args.json);
			},
		}),
		use: defineCommand({
			meta: {
				name: "use",
				description: "Set the default profile for future commands",
			},
			args: { name: { type: "positional", required: true }, json },
			run: ({ args }) => {
				useProfile(args.name);
				show({ default: args.name }, args.json);
			},
		}),
	},
});
