import type { AkiflowClient } from "./api/client";
import type { Event } from "./api/types";
import {
	type VerificationOptions,
	type VerificationResult,
	verifyEventFields,
} from "./verification";

/** Reuse bounded fresh pagination; expose attendee membership as a comparison field. */
export async function verifyEventAttendees(
	client: Pick<AkiflowClient, "get">,
	id: string,
	present: readonly string[],
	absent: readonly string[],
	opts: VerificationOptions = {},
): Promise<VerificationResult<Event>> {
	const originals = new Map<string, Event>();
	const comparisonClient: Pick<AkiflowClient, "get"> = {
		get: async <T>(
			path: string,
			params?: { sync_token?: string; limit?: number },
		) => {
			const response = await client.get<Event[]>(path, params);
			return {
				...response,
				data: response.data?.map((event) => {
					originals.set(event.id, event);
					const emails = new Set(
						(event.attendees ?? []).map((attendee) =>
							typeof attendee === "object" &&
							attendee !== null &&
							"email" in attendee &&
							typeof attendee.email === "string"
								? attendee.email.toLowerCase()
								: undefined,
						),
					);
					const matches =
						present.every((email) => emails.has(email.toLowerCase())) &&
						absent.every((email) => !emails.has(email.toLowerCase()));
					return { ...event, title: matches ? "matched" : "mismatch" };
				}) as T,
			};
		},
	};
	const result = await verifyEventFields(
		comparisonClient,
		id,
		{ title: "matched" },
		opts,
	);
	return {
		...result,
		observed: result.observed ? (originals.get(id) ?? null) : null,
		differingFields: result.differingFields.map((field) =>
			field === "title" ? "attendees" : field,
		),
	};
}
