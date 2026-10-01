import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AkiflowClient } from "../../lib/api/client";
import {
	foldVersions,
	readAkiflowResource,
	validateAkiflowPage,
} from "../../lib/reconcile/akiflow-reader";
import {
	googleArgv,
	invokeGoogle,
	probeGoogleIdentities,
	readGoogleCalendar,
	resolveGoogleExecutable,
	validateGooglePage,
} from "../../lib/reconcile/google-reader";
import type { Coverage } from "../../lib/reconcile/types";
import {
	af,
	calendar,
	normalizedA,
	observation,
	window,
} from "./reconcile-fixtures";

let directory: string | undefined;
afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});
function executable(body: string) {
	directory = mkdtempSync(join(tmpdir(), "af reconcile reader "));
	const path = join(directory, "google helper");
	writeFileSync(path, `#!${process.execPath}\n${body}`);
	chmodSync(path, 0o700);
	return path;
}
function coverage(): Coverage {
	return {
		read_start: new Date().toISOString(),
		read_end: null,
		complete: false,
		pages: 0,
	};
}
function page(data: unknown[], sync_token: string, has_next_page = false) {
	return { success: true, data, sync_token, has_next_page };
}

test("repeated_or_missing_cursor_fails", () => {
	expect(() =>
		validateAkiflowPage({ ...page([], ""), sync_token: undefined }, new Set()),
	).toThrow("cursor");
	expect(() =>
		validateAkiflowPage(page([], "same", true), new Set(["same"])),
	).toThrow("cursor");
	expect(() =>
		validateAkiflowPage(
			{ ...page([], "next"), has_next_page: "true" },
			new Set(),
		),
	).toThrow("malformed");
	expect(() =>
		validateAkiflowPage({ ...page([], "next"), success: false }, new Set()),
	).toThrow();
	expect(() => validateAkiflowPage(page([{}], "next"), new Set())).toThrow(
		"identity",
	);
});
test("version folding keeps last live version and tombstones dominate", () => {
	const tombstone = af("a", { deleted_at: "2026-10-01T05:00:00Z" });
	expect(
		foldVersions([af("a"), af("a", { title: "latest" }), tombstone, af("a")]),
	).toEqual([tombstone]);
	expect(foldVersions([af("a"), af("a", { title: "latest" })])[0]?.title).toBe(
		"latest",
	);
});
test("cold read uses preceding response cursor and retains cancellation evidence", async () => {
	const fetchSpy = spyOn(globalThis, "fetch");
	fetchSpy.mockResolvedValueOnce(
		Response.json(page([af("a", { status: "cancelled" })], "one", true)),
	);
	fetchSpy.mockResolvedValueOnce(Response.json(page([af("a")], "two")));
	try {
		const meta = coverage();
		const result = await readAkiflowResource(
			new AkiflowClient({
				readOnly: true,
				credentials: { token: "fake", clientId: "client" },
			}),
			"events",
			meta,
		);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://api.akiflow.com/v5/events?limit=2500",
		);
		expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("sync_token=one");
		expect(result.rows[0]?.status).toBe("confirmed");
		expect(result.evidence).toHaveLength(1);
		expect(meta).toMatchObject({ pages: 2, complete: true });
	} finally {
		fetchSpy.mockRestore();
	}
});
test("Akiflow 1000-page cap fails rather than substituting a partial collection", async () => {
	let calls = 0;
	const client = {
		get: async () => page([], `page-${++calls}`, true),
	} as unknown as AkiflowClient;
	const meta = coverage();
	await expect(readAkiflowResource(client, "events", meta)).rejects.toThrow(
		"1000",
	);
	expect(meta.complete).toBe(false);
	expect(calls).toBe(1000);
});
test("Google argv whitelists only list/get and executable paths remain one argument", () => {
	const path = "/tmp/path with spaces/google reader";
	expect(
		googleArgv(path, "get", { calendarId: "calendar", eventId: "id" }),
	).toEqual([
		path,
		"calendar",
		"events",
		"get",
		"--params",
		'{"calendarId":"calendar","eventId":"id"}',
	]);
	expect(() => googleArgv(path, "delete" as "get", {})).toThrow("list/get");
	expect(() => googleArgv(path, "list", { sendUpdates: "none" })).toThrow(
		"parameter",
	);
});
test("executable precedence is flag then environment then PATH", () => {
	const path = executable("console.log('{}');");
	expect(
		resolveGoogleExecutable(path, { HATCH_GWS_CLI: "/missing", PATH: "" }),
	).toBe(path);
	expect(
		resolveGoogleExecutable(undefined, { HATCH_GWS_CLI: path, PATH: "" }),
	).toBe(path);
	expect(() => resolveGoogleExecutable(undefined, { PATH: "" })).toThrow(
		"hatch_gws_cli",
	);
	const onPath = join(directory ?? "", "hatch_gws_cli");
	writeFileSync(onPath, `#!${process.execPath}\nconsole.log('{}');`);
	chmodSync(onPath, 0o700);
	expect(resolveGoogleExecutable(undefined, { PATH: directory })).toBe(onPath);
	expect(() =>
		resolveGoogleExecutable("/missing/explicit", {
			HATCH_GWS_CLI: path,
			PATH: directory,
		}),
	).toThrow("/missing/explicit");
	chmodSync(path, 0o600);
	expect(() => resolveGoogleExecutable(path)).toThrow("not executable");
});
test("empty_google_page_with_next_token_continues", async () => {
	const path = executable(
		`const p=JSON.parse(process.argv[6]); console.log(JSON.stringify(p.pageToken ? {kind:'calendar#events',items:[{id:'g',status:'cancelled'}],timeZone:'UTC'} : {kind:'calendar#events',items:[],nextPageToken:'two'}));`,
	);
	const meta = {
		...coverage(),
		calendar_id: calendar.origin_id,
		identity_probes: 0,
	};
	const result = await readGoogleCalendar(path, window, meta);
	expect(result.events).toHaveLength(1);
	expect(meta.pages).toBe(2);
	expect(meta.complete).toBe(true);
});
test("flattened or malformed Google collection fails", () => {
	for (const value of [
		[],
		{ items: [] },
		{ kind: "calendar#events" },
		{ kind: "calendar#events", items: [], nextPageToken: 1 },
	])
		expect(() => validateGooglePage(value)).toThrow();
});
test("failed_calendar_never_becomes_empty_source", async () => {
	const path = executable(
		"console.log(JSON.stringify({error:{code:403,message:'permission denied'}})); process.exit(1);",
	);
	const meta = {
		...coverage(),
		calendar_id: calendar.origin_id,
		identity_probes: 0,
	};
	await expect(readGoogleCalendar(path, window, meta)).rejects.toThrow(
		"permission denied",
	);
	expect(meta.complete).toBe(false);
	expect(meta.error).toContain("permission denied");
});
test("Google process failure preserves privsep failure as upstream", async () => {
	const path = executable(
		"console.error('privsep socket denied'); process.exit(1);",
	);
	try {
		await invokeGoogle(path, "list", {});
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toMatchObject({ exitCode: 5 });
		expect(String(error)).toContain("privsep socket denied");
	}
});
test("Google auth is 3, transport is 5, event 404 and 410 are evidence", async () => {
	for (const code of [401, 500, 404, 410]) {
		if (directory) rmSync(directory, { recursive: true, force: true });
		const path = executable(
			`console.log(JSON.stringify({error:{code:${code},message:'structured'}})); process.exit(1);`,
		);
		if (code === 404 || code === 410)
			expect(await invokeGoogle(path, "get", {})).toHaveProperty(
				"error.code",
				code,
			);
		else {
			try {
				await invokeGoogle(path, "get", {});
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toMatchObject({ exitCode: code === 401 ? 3 : 5 });
			}
		}
	}
});
test("Google subprocess timeout is bounded and fails", async () => {
	const path = executable("setTimeout(()=>{}, 10000);");
	await expect(invokeGoogle(path, "list", {}, 30)).rejects.toThrow("timed out");
});
test("identity probes are deduplicated, only observed IDs, and not-found is retained", async () => {
	const path = executable(
		"console.log(JSON.stringify({error:{code:404,message:'not found'}}));",
	);
	const source = observation([]);
	await probeGoogleIdentities(
		path,
		normalizedA([
			af("a"),
			af("b"),
			af("master", {
				origin_id: "series",
				recurring_id: "master",
				recurrence: ["RRULE:FREQ=DAILY"],
			}),
		]),
		[source],
		new Set(),
	);
	expect(source.metadata.identity_probes).toBe(2);
	expect(source.not_found_ids).toEqual(["g1", "series"]);
});

test("timeout bounds pipe capture even after a wrapper exits", async () => {
	let release: (() => void) | undefined;
	let killed = false;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			release = () => controller.close();
		},
	});
	const spawn = spyOn(Bun, "spawn").mockReturnValue({
		stdout,
		stderr: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		exited: Promise.resolve(0),
		kill: () => {
			killed = true;
		},
	} as never);
	try {
		await expect(invokeGoogle("/fake-wrapper", "list", {}, 20)).rejects.toThrow(
			"timed out",
		);
		expect(killed).toBe(true);
	} finally {
		release?.();
		spawn.mockRestore();
	}
});

test("a helper that disappears before spawning is a usage/helper error", async () => {
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw Object.assign(new Error("missing executable"), { code: "ENOENT" });
	});
	try {
		try {
			await invokeGoogle("/missing-helper", "list", {});
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toMatchObject({ exitCode: 2, code: "helper_unexecutable" });
		}
	} finally {
		spawn.mockRestore();
	}
});
