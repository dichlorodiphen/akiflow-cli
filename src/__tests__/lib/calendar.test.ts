import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Calendar } from "../../lib/api/types";
import * as cache from "../../lib/cache";
import {
	CalendarResolutionError,
	findDefaultEventCalendar,
	getDefaultCalendarId,
	isGoogleCalendar,
	isPrimaryCalendar,
	isVisibleActiveCalendar,
	isWritableVisibleCalendar,
	resolveCalendarFromList,
} from "../../lib/calendar";

function calendar(overrides: Partial<Calendar> = {}): Calendar {
	return {
		id: "cal-personal",
		user_id: 1,
		akiflow_account_id: "akiflow-account-1",
		akiflow_primary: true,
		primary: true,
		connector_id: "google",
		origin_id: "person@example.com",
		origin_account_id: "google-account-1",
		title: "Personal",
		description: null,
		timezone: "America/Los_Angeles",
		color: "#7986cb",
		icon: null,
		read_only: false,
		hidden_at: null,
		url: null,
		sync_status: null,
		last_synced_at: null,
		clear_job_id: null,
		settings: {},
		content: {},
		data: {},
		fingerprints: {},
		etag: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		deleted_at: null,
		...overrides,
	};
}

describe("calendar helpers", () => {
	let readResourceSpy: ReturnType<typeof spyOn> | undefined;

	afterEach(() => {
		readResourceSpy?.mockRestore();
		readResourceSpy = undefined;
	});

	it("identifies writable visible primary Google calendars", () => {
		const personal = calendar();

		expect(isVisibleActiveCalendar(personal)).toBe(true);
		expect(isWritableVisibleCalendar(personal)).toBe(true);
		expect(isPrimaryCalendar(personal)).toBe(true);
		expect(isGoogleCalendar(personal)).toBe(true);
		expect(findDefaultEventCalendar([personal])?.id).toBe("cal-personal");
	});

	it("resolves by id, origin id, exact title, then unique title substring", () => {
		const calendars = [
			calendar({
				id: "cal-id",
				origin_id: "person@example.com",
				title: "Personal",
			}),
			calendar({
				id: "cal-work",
				origin_id: "work@example.com",
				title: "Work Calendar",
				primary: false,
				akiflow_primary: false,
			}),
		];

		expect(resolveCalendarFromList(calendars, "cal-id").id).toBe("cal-id");
		expect(resolveCalendarFromList(calendars, "work@example.com").id).toBe(
			"cal-work",
		);
		expect(resolveCalendarFromList(calendars, "personal").id).toBe("cal-id");
		expect(resolveCalendarFromList(calendars, "work").id).toBe("cal-work");
	});

	it("rejects ambiguous title matches with candidates", () => {
		const calendars = [
			calendar({ id: "cal-1", title: "Team Calendar" }),
			calendar({
				id: "cal-2",
				title: "Team Planning",
				primary: false,
				akiflow_primary: false,
			}),
		];

		expect(() => resolveCalendarFromList(calendars, "Team")).toThrow(
			CalendarResolutionError,
		);
		expect(() => resolveCalendarFromList(calendars, "Team")).toThrow(
			"ambiguous",
		);
	});

	it("excludes hidden and deleted calendars unless requested", () => {
		const hidden = calendar({
			id: "hidden-cal",
			title: "Hidden",
			hidden_at: "2026-06-19T00:00:00.000Z",
		});
		const deleted = calendar({
			id: "deleted-cal",
			title: "Deleted",
			deleted_at: "2026-06-19T00:00:00.000Z",
		});

		expect(() => resolveCalendarFromList([hidden], "hidden-cal")).toThrow(
			"not found",
		);
		expect(
			resolveCalendarFromList([hidden], "hidden-cal", { includeHidden: true })
				.id,
		).toBe("hidden-cal");
		expect(() => resolveCalendarFromList([deleted], "deleted-cal")).toThrow(
			"not found",
		);
		expect(
			resolveCalendarFromList([deleted], "deleted-cal", {
				includeDeleted: true,
			}).id,
		).toBe("deleted-cal");
	});

	it("returns the default writable primary calendar id from the cache", async () => {
		readResourceSpy = spyOn(cache, "readResource").mockResolvedValue([
			calendar({
				id: "read-only-primary",
				read_only: true,
			}),
			calendar({
				id: "default-cal",
				title: "Default",
				read_only: false,
			}),
		] as any);

		const result = await getDefaultCalendarId({} as any);

		expect(result).toBe("default-cal");
		expect(readResourceSpy).toHaveBeenCalledWith(
			expect.anything(),
			"calendars",
		);
	});
});
