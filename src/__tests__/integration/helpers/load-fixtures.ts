import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeAkiflowServer, Resource, Row } from "./fake-server";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

const RESOURCES: Array<{ resource: Resource; file: string }> = [
	{ resource: "tasks", file: "tasks.json" },
	{ resource: "events", file: "events.json" },
	{ resource: "time_slots", file: "time-slots.json" },
	{ resource: "labels", file: "labels.json" },
	{ resource: "tags", file: "tags.json" },
	{ resource: "calendars", file: "calendars.json" },
	{ resource: "accounts", file: "accounts.json" },
	{ resource: "contacts", file: "contacts.json" },
];

/**
 * Seed canonical stores for every v5 resource. GETs use behavioral cursors
 * and observe mutations. Tests can override individual endpoints by
 * calling server.respondTo() after this.
 */
export function loadAllFixtures(
	server: FakeAkiflowServer,
	_syncToken?: string,
): void {
	for (const { resource, file } of RESOURCES) {
		let data: Row[] = [];
		try {
			data = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
		} catch {
			data = [];
		}
		server.seed(resource, data);
	}
	// Settings + client registration — minimal canned responses
	server.respondTo("GET", "/v5/user/settings", {
		success: true,
		message: null,
		data: { timezone: "America/New_York" },
	});
	server.respondTo("POST", "/v5/clients", {
		success: true,
		message: null,
		data: { id: "client-1" },
	});
}
