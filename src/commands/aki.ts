import { defineCommand } from "citty";
import { AkiClient } from "../lib/aki/client";
import { createClient } from "../lib/api/client";

const jsonArg = {
	type: "boolean" as const,
	description:
		"Output JSON (contains requested chat content; not saved locally)",
};
const channelArg = {
	type: "positional" as const,
	required: true as const,
	description: "Exact Aki conversation ID",
};
function boundedInteger(
	value: string | undefined,
	fallback: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
		throw new Error(`Expected an integer between 1 and ${max}`);
	return Number(value);
}
async function handle(action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		console.error(
			"Error:",
			error instanceof Error ? error.message : "Aki request failed",
		);
		process.exitCode = 1;
	}
}
const list = defineCommand({
	meta: {
		name: "list",
		description: "List Aki conversations for this Akiflow login",
	},
	args: {
		json: jsonArg,
		limit: { type: "string", description: "Page size, 1–30 (default 30)" },
		offset: { type: "string", description: "Page offset (default 0)" },
	},
	run: async ({ args }) =>
		handle(async () => {
			const limit = boundedInteger(args.limit, 30, 30);
			if (
				args.offset !== undefined &&
				(!/^\d+$/.test(args.offset) ||
					!Number.isSafeInteger(Number(args.offset)))
			)
				throw new Error("Offset must be a nonnegative integer");
			const client = await AkiClient.connect(createClient());
			const result = await client.list(limit, Number(args.offset ?? 0));
			if (args.json) console.log(JSON.stringify(result, null, 2));
			else
				for (const row of result)
					console.log(
						`${row.channel.id}\t${row.channel.title ?? row.channel.name ?? "Aki chat"}`,
					);
		}),
});
const history = defineCommand({
	meta: {
		name: "history",
		description: "Read an Aki conversation without marking it read",
	},
	args: {
		conversation: channelArg,
		json: jsonArg,
		limit: {
			type: "string",
			description: "Latest messages, 1–100 (default 100)",
		},
		before: {
			type: "string",
			description: "Read messages before this message ID",
		},
	},
	run: async ({ args }) =>
		handle(async () => {
			const limit = boundedInteger(args.limit, 100, 100);
			const client = await AkiClient.connect(createClient());
			const result = await client.history(
				args.conversation,
				limit,
				args.before,
			);
			if (args.json) console.log(JSON.stringify(result, null, 2));
			else
				for (const message of result.messages)
					console.log(
						`${message.user?.id === "aki" ? "Aki" : "You"}: ${message.text ?? "[attachment]"}`,
					);
		}),
});
const create = defineCommand({
	meta: { name: "create", description: "Create an empty Aki conversation" },
	args: {
		title: { type: "string", description: "Conversation title" },
		json: jsonArg,
	},
	run: async ({ args }) =>
		handle(async () => {
			if (
				args.title !== undefined &&
				(!args.title.trim() || args.title.length > 250)
			)
				throw new Error("Title must contain 1–250 characters");
			const client = await AkiClient.connect(createClient());
			const result = await client.create(args.title);
			if (args.json)
				console.log(
					JSON.stringify(
						{
							schema_version: 1,
							command: "aki create",
							status: "verified",
							result: result.channel,
							errors: [],
							warnings: [],
						},
						null,
						2,
					),
				);
			else console.log(result.channel.id);
		}),
});
const send = defineCommand({
	meta: {
		name: "send",
		description:
			"Submit a prompt; Aki can perform server-side task/calendar actions",
	},
	args: {
		prompt: {
			type: "positional",
			required: true,
			description: "Explicit prompt to submit",
		},
		conversation: {
			type: "string",
			required: true,
			description: "Exact conversation ID (create one with aki create)",
		},
		"allow-actions": {
			type: "boolean",
			description:
				"Acknowledge Aki may act on your account; the service exposes no read-only chat mode",
		},
		wait: {
			type: "boolean",
			default: true,
			description:
				"Wait for a posted reply (use --no-wait to return after submission)",
		},
		timeout: {
			type: "string",
			description: "Response wait in seconds, 1–300 (default 120)",
		},
		json: jsonArg,
	},
	run: async ({ args }) =>
		handle(async () => {
			if (!args["allow-actions"])
				throw new Error(
					"Aki may perform server-side actions. Pass --allow-actions to acknowledge; chat has no verified read-only mode.",
				);
			if (!args.prompt.trim()) throw new Error("Prompt cannot be empty");
			const timeout = boundedInteger(args.timeout, 120, 300) * 1000;
			const controller = new AbortController();
			const interrupted = () => controller.abort();
			process.once("SIGINT", interrupted);
			process.once("SIGTERM", interrupted);
			try {
				const client = await AkiClient.connect(createClient());
				const sent = await client.send(
					args.conversation,
					args.prompt,
					controller.signal,
				);
				// Always emit the submission identity before waiting so interruption remains recoverable.
				if (!args.json)
					console.error(
						`Submitted ${sent.id} to ${args.conversation}; inspect history before any manual retry.`,
					);
				const replies =
					args.wait === false
						? []
						: await client.waitForReply(
								args.conversation,
								sent,
								timeout,
								controller.signal,
							);
				if (!args.json && replies.length)
					console.error(
						"Posted reply observed; later replies/actions may continue. Inspect history for updates.",
					);
				const result = {
					conversation_id: args.conversation,
					message_id: sent.id,
					replies,
				};
				if (args.json)
					console.log(
						JSON.stringify(
							{
								schema_version: 1,
								command: "aki send",
								status: replies.length ? "reply_received" : "accepted",
								result,
								errors: [],
								warnings: [
									"Aki may perform server-side actions. No chat content or token is saved locally.",
									"Posted replies were observed; the service does not expose a verified turn-completion marker. Inspect history for later replies.",
								],
							},
							null,
							2,
						),
					);
				else
					for (const reply of replies)
						console.log(
							reply.text ??
								"[Aki returned an attachment; inspect history --json]",
						);
			} finally {
				process.removeListener("SIGINT", interrupted);
				process.removeListener("SIGTERM", interrupted);
			}
		}),
});
const stop = defineCommand({
	meta: {
		name: "stop",
		description:
			"Ask Aki to stop generating (does not undo actions already performed)",
	},
	args: { conversation: channelArg, json: jsonArg },
	run: async ({ args }) =>
		handle(async () => {
			const client = await AkiClient.connect(createClient());
			await client.stop(args.conversation);
			if (args.json)
				console.log(
					JSON.stringify(
						{
							schema_version: 1,
							command: "aki stop",
							status: "accepted",
							result: { conversation_id: args.conversation },
							errors: [],
							warnings: [
								"Stop requested; already performed actions are not undone.",
							],
						},
						null,
						2,
					),
				);
			else
				console.log(
					"Stop requested; already performed actions are not undone.",
				);
		}),
});
export const akiCommand = defineCommand({
	meta: {
		name: "aki",
		description: "Aki assistant conversations (may perform account actions)",
	},
	subCommands: { list, history, create, send, stop },
});
