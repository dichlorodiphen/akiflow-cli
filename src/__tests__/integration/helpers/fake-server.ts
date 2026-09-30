import { createServer, type Server } from "node:http";
import type {
	EventOperation,
	EventOperationPayload,
} from "../../../lib/api/types";

export type Row = { id: string; [key: string]: unknown };
export type Resource =
	| "events"
	| "tasks"
	| "time_slots"
	| "labels"
	| "tags"
	| "calendars"
	| "accounts"
	| "contacts";
export interface RecordedRequest {
	/** One-based, assigned on arrival (not completion). */
	index: number;
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: string;
}
type ResponseValue =
	| unknown
	| ((req: RecordedRequest) => unknown | Promise<unknown>);
type Match = {
	index?: number;
	path?: string;
	predicate?: (req: RecordedRequest) => boolean;
};
export type Fault = Match &
	(
		| { type: "latency"; ms: number }
		| { type: "rate-limit"; retryAfter: number }
		| { type: "drop" }
		| { type: "after-apply" }
		| { type: "gate"; wait: Promise<void>; entered: () => void }
	);
export interface FakeServerOptions {
	pageSize?: number;
	duplicatePageBoundaries?: boolean;
	visibilityRequests?: number;
	visibilityMs?: number;
	operationDelayRequests?: number;
	/** Deterministic timestamp origin; increments one millisecond per write. */
	epoch?: string;
	strictBase?: boolean;
}
interface Change {
	revision: number;
	row: Row;
}
interface Cursor {
	resource: Resource;
	revision: number;
	rows?: Row[];
	offset?: number;
	last?: Row;
}
interface Pending {
	due: number;
	at: number;
	publish: () => void;
}
const resources: Resource[] = [
	"events",
	"tasks",
	"time_slots",
	"labels",
	"tags",
	"calendars",
	"accounts",
	"contacts",
];
export class DroppedConnection extends Error {}
const copy = <T>(value: T): T => structuredClone(value);
const json = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) => ({ value, status, headers });

/** Behavioral local API. See README.md for controls, protocol and limitations. */
export class FakeAkiflowServer {
	private server: Server | null = null;
	private responders: {
		method: string;
		path: string;
		response: ResponseValue;
		status?: number;
	}[] = [];
	private faults: Fault[] = [];
	private pending: Pending[] = [];
	private cursors = new Map<string, Cursor>();
	private expired = new Set<Resource>();
	private visible = new Map<Resource, Map<string, Row>>();
	private tombstones = new Map<Resource, Map<string, Row>>();
	private changes = new Map<Resource, Change[]>();
	private revisions = new Map<Resource, number>();
	private tick = 0;
	private cursorId = 0;
	private unauthorized = false;
	private refreshedToken: string | null = null;
	private failures: (op: EventOperationPayload) => boolean = () => false;
	private rejectEnvelope = false;
	private operationClients = new Map<string, EventOperation>();
	readonly stores = new Map<Resource, Map<string, Row>>();
	readonly operations = new Map<string, EventOperation>();
	readonly operationHistory: {
		id: string;
		status: EventOperation["status"];
	}[] = [];
	readonly requests: RecordedRequest[] = [];
	readonly options: FakeServerOptions;
	url = "";
	get refreshUrl(): string {
		return `${this.url}/oauth/refreshToken`;
	}
	constructor(options: FakeServerOptions = {}) {
		this.options = { ...options };
		for (const r of resources) {
			this.stores.set(r, new Map());
			this.visible.set(r, new Map());
			this.tombstones.set(r, new Map());
			this.changes.set(r, []);
			this.revisions.set(r, 0);
		}
	}
	private timestamp(): string {
		return new Date(
			Date.parse(this.options.epoch ?? "2026-01-01T00:00:00Z") + ++this.tick,
		).toISOString();
	}
	/** Seed a resource, replacing its contents. Input is cloned, not retained. */
	seed(resource: Resource, rows: Row[]): this {
		this.stores.get(resource)!.clear();
		this.visible.get(resource)!.clear();
		this.tombstones.get(resource)!.clear();
		this.changes.set(resource, []);
		this.revisions.set(resource, 0);
		for (const row of rows) {
			const normalized = this.normalize(resource, row);
			this.stores.get(resource)!.set(row.id, normalized);
			this.publish(resource, normalized);
		}
		return this;
	}
	/** Read canonical state even while GET visibility is delayed. */
	snapshot(resource: Resource): Row[] {
		return copy([...this.stores.get(resource)!.values()]);
	}
	failOperations(predicate: (op: EventOperationPayload) => boolean): this {
		this.failures = predicate;
		return this;
	}
	expireToken(resource: Resource): this {
		this.expired.add(resource);
		return this;
	}
	force401(): this {
		this.unauthorized = true;
		return this;
	}
	schedule(...faults: Fault[]): this {
		this.faults.push(...faults);
		return this;
	}
	/** One-shot deterministic barrier. Always release in a finally block. */
	gate(match: Match): { entered: Promise<void>; release: () => void } {
		let release!: () => void;
		let entered!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const arrived = new Promise<void>((resolve) => {
			entered = resolve;
		});
		this.schedule({ ...match, type: "gate", wait, entered });
		return { entered: arrived, release };
	}
	readonly scenarios = {
		fabricatedAcceptance: (envelope = false): this => {
			this.rejectEnvelope = envelope;
			return this.failOperations(() => true);
		},
		mixedBatch: (predicate: (op: EventOperationPayload) => boolean): this =>
			this.failOperations(predicate),
		staleBaseChain: (delayRequests = 100): this => {
			this.options.visibilityRequests = delayRequests;
			return this;
		},
		lockRace: () =>
			this.gate({ path: "/v5/tasks", predicate: (r) => r.method === "GET" }),
		snooze: (
			id: string,
			datetime = "2026-09-30T16:00:00.000Z",
			zone = "America/Los_Angeles",
		): this =>
			this.seed("tasks", [
				{
					id,
					title: "Timed task",
					date: datetime.slice(0, 10),
					datetime,
					datetime_tz: zone,
					duration: 3600,
				},
			]),
	};
	respondTo(
		method: string,
		path: string,
		response: ResponseValue,
		status?: number,
	): void {
		this.responders.push({ method, path, response, status });
	}
	reset(): void {
		this.responders = [];
		this.faults = [];
		this.pending = [];
		this.cursors.clear();
		this.expired.clear();
		this.requests.length = 0;
		this.operations.clear();
		this.operationHistory.length = 0;
		this.operationClients.clear();
		this.unauthorized = false;
		this.refreshedToken = null;
		this.failures = () => false;
		this.rejectEnvelope = false;
		this.tick = 0;
		this.cursorId = 0;
		for (const r of resources) this.seed(r, []);
	}
	async start(): Promise<string> {
		if (this.server) throw new Error("Fake server already started");
		this.server = createServer(async (req, res) => {
			try {
				let body = "";
				for await (const chunk of req) body += chunk.toString();
				const headers = new Headers();
				for (const [key, value] of Object.entries(req.headers))
					if (value !== undefined)
						headers.set(key, Array.isArray(value) ? value.join(", ") : value);
				const response = await this.dispatch(
					new Request(new URL(req.url ?? "/", this.url).href, {
						method: req.method,
						headers,
						...(body ? { body } : {}),
					}),
				);
				res.writeHead(
					response.status,
					Object.fromEntries(response.headers.entries()),
				);
				res.end(await response.text());
			} catch (error) {
				if (error instanceof DroppedConnection) {
					req.socket.destroy();
					return;
				}
				res.writeHead(500);
				res.end(JSON.stringify({ success: false, message: String(error) }));
			}
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(0, "127.0.0.1", resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string")
			throw new Error("No server address");
		this.url = `http://127.0.0.1:${address.port}`;
		return this.url;
	}
	async stop(): Promise<void> {
		if (this.server) {
			const server = this.server;
			this.server = null;
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
	/** Same engine as HTTP; useful for testing the model without opening a port. */
	async dispatch(req: Request): Promise<Response> {
		const recorded: RecordedRequest = {
			index: this.requests.length + 1,
			method: req.method,
			url: new URL(req.url),
			headers: Object.fromEntries(req.headers.entries()),
			body: "",
		};
		this.requests.push(recorded);
		recorded.body = req.body ? await req.text() : "";
		this.flush();
		const matching = this.faults.filter(
			(f) =>
				(f.index === undefined || f.index === recorded.index) &&
				(f.path === undefined || f.path === recorded.url.pathname) &&
				(!f.predicate || f.predicate(recorded)),
		);
		this.faults = this.faults.filter((f) => !matching.includes(f));
		for (const f of matching) {
			if (f.type === "latency") await Bun.sleep(f.ms);
			if (f.type === "gate") {
				f.entered();
				await f.wait;
			}
		}
		this.flush();
		if (matching.some((f) => f.type === "drop"))
			throw new DroppedConnection("Connection dropped");
		const rate = matching.find((f) => f.type === "rate-limit");
		const afterApply = matching.some((f) => f.type === "after-apply");
		const reply =
			rate?.type === "rate-limit"
				? json({ success: false, message: "Rate limited" }, 429, {
						"Retry-After": String(rate.retryAfter),
					})
				: await this.handle(recorded, afterApply);
		return new Response(
			JSON.stringify(
				afterApply
					? { success: false, message: "Lost response after apply" }
					: reply.value,
			),
			{
				status: afterApply ? 500 : reply.status,
				headers: { "Content-Type": "application/json", ...reply.headers },
			},
		);
	}

	private flush(): void {
		const ready = this.pending.filter(
			(p) => this.requests.length >= p.due && Date.now() >= p.at,
		);
		this.pending = this.pending.filter((p) => !ready.includes(p));
		for (const p of ready) p.publish();
	}
	private normalize(resource: Resource, row: Row, old?: Row): Row {
		const timestamp = this.timestamp();
		const nullFields =
			resource === "events"
				? [
						"origin_recurring_id",
						"end_datetime_tz",
						"original_start_time",
						"original_start_date",
						"color",
						"calendar_color",
						"organizer_id",
						"creator_id",
						"created_by",
						"meeting_url",
						"meeting_solution",
						"meeting_icon",
						"meeting_status",
						"task_id",
						"time_slot_id",
						"url",
						"origin_account_id",
						"origin_calendar_id",
						"origin_updated_at",
						"akiflow_account_id",
						"recurrence_exception_delete",
						"recurrence_sync_retry",
						"availability_config_id",
						"email_confirmation_type",
						"email_confirmation_status",
						"email_reminder_type",
						"email_reminder_status",
						"email_remind_before",
						"email_reminded_at",
						"etag",
						"start_time",
						"end_time",
					]
				: resource === "tasks"
					? [
							"original_date",
							"original_datetime",
							"recurrence_version",
							"dailyGoal",
							"done_at",
							"read_at",
							"listId",
							"section_id",
							"sorting_label",
							"origin",
							"due_date",
							"connector_id",
							"origin_account_id",
							"akiflow_account_id",
							"calendar_id",
							"time_slot_id",
							"trashed_at",
							"plan_unit",
							"plan_period",
							"global_list_id_updated_at",
							"global_tags_ids_updated_at",
						]
					: resource === "time_slots"
						? [
								"recurring_id",
								"label_id",
								"section_id",
								"original_start_time",
								"recurrence",
								"color",
								"global_label_id_updated_at",
								"start_time",
								"end_time",
							]
						: [];
		const defaults = {
			...Object.fromEntries(nullFields.map((field) => [field, null])),
			...(resource === "events"
				? {
						status: "confirmed",
						attendees: [],
						hidden: false,
						declined: false,
						read_only: false,
						recurrence: null,
						recurring_id: null,
						recurrence_exception: false,
						start_date: null,
						end_date: null,
						connector_id: "google",
						start_datetime_tz: "UTC",
						fingerprints: {},
					}
				: resource === "tasks"
					? {
							status: 0,
							done: false,
							date: null,
							datetime: null,
							datetime_tz: null,
							duration: null,
							tags_ids: [],
							links: [],
							recurrence: null,
							recurring_id: null,
							priority: null,
							sorting: 0,
							doc: {},
						}
					: resource === "time_slots"
						? { status: "confirmed", start_datetime_tz: "UTC", calendar_id: "" }
						: {}),
		};
		return {
			...defaults,
			user_id: 42,
			description: null,
			content: {},
			data: {},
			deleted_at: null,
			...old,
			...copy(row),
			title:
				typeof row.title === "string"
					? row.title.trim()
					: (old?.title ?? "Untitled"),
			origin_id:
				old?.origin_id ?? row.origin_id ?? `fake-origin-${crypto.randomUUID()}`,
			created_at: old?.created_at ?? timestamp,
			updated_at: timestamp,
			global_created_at: old?.global_created_at ?? timestamp,
			global_updated_at: timestamp,
		};
	}
	private publish(resource: Resource, row: Row): void {
		const revision = this.revisions.get(resource)! + 1;
		this.revisions.set(resource, revision);
		if (row.deleted_at) {
			this.visible.get(resource)!.delete(row.id);
			this.tombstones.get(resource)!.set(row.id, copy(row));
		} else {
			this.visible.get(resource)!.set(row.id, copy(row));
			this.tombstones.get(resource)!.delete(row.id);
		}
		this.changes.get(resource)!.push({ revision, row: copy(row) });
	}
	private save(resource: Resource, row: Row): void {
		this.stores.get(resource)!.set(row.id, copy(row));
		if (this.options.visibilityRequests || this.options.visibilityMs)
			this.pending.push({
				due: this.requests.length + (this.options.visibilityRequests ?? 0) + 1,
				at: Date.now() + (this.options.visibilityMs ?? 0),
				publish: () => this.publish(resource, row),
			});
		else this.publish(resource, row);
	}
	private page(resource: Resource, req: RecordedRequest) {
		if (this.expired.delete(resource))
			return json(
				{ success: false, message: "Invalid or expired sync_token", data: [] },
				410,
			);
		const token = req.url.searchParams.get("sync_token");
		const cursor = token ? this.cursors.get(token) : undefined;
		if (token && (!cursor || cursor.resource !== resource))
			return json(
				{ success: false, message: "Invalid or expired sync_token", data: [] },
				410,
			);
		const revision = cursor?.rows
			? cursor.revision
			: this.revisions.get(resource)!;
		const rows =
			cursor?.rows ??
			(cursor
				? this.changes
						.get(resource)!
						.filter((c) => c.revision > cursor.revision)
						.map((c) => c.row)
				: [
						...this.visible.get(resource)!.values(),
						...this.tombstones.get(resource)!.values(),
					]);
		const offset = cursor?.offset ?? 0;
		const limit = Math.max(
			1,
			Math.min(
				this.options.pageSize ?? 2500,
				Number(req.url.searchParams.get("limit")) || 2500,
			),
		);
		const data = rows.slice(offset, offset + limit);
		if (this.options.duplicatePageBoundaries && cursor?.last)
			data.unshift(cursor.last);
		const next = offset + limit;
		const hasNext = next < rows.length;
		const syncToken = `${resource}:${++this.cursorId}`;
		this.cursors.set(
			syncToken,
			hasNext
				? {
						resource,
						revision,
						rows: copy(rows),
						offset: next,
						last: copy(data.at(-1)),
					}
				: { resource, revision },
		);
		return json({
			success: true,
			message: null,
			data: copy(data),
			sync_token: syncToken,
			has_next_page: hasNext,
		});
	}
	private submitOperation(
		input: EventOperationPayload,
		forceApply = false,
	): EventOperation {
		const previous = this.operationClients.get(input.id);
		if (previous) return previous;
		const timestamp = this.timestamp();
		const op: EventOperation = {
			...copy(input),
			id: crypto.randomUUID(),
			user_id: 42,
			status: "pending",
			result: null,
			processed_at: null,
			failed_at: null,
			global_created_at: timestamp,
			global_updated_at: timestamp,
		};
		this.operations.set(op.id, op);
		this.operationClients.set(input.id, op);
		this.operationHistory.push({ id: op.id, status: "pending" });
		const apply = () => {
			const old = this.stores.get("events")!.get(op.event_id);
			const base = op.payload.base as Record<string, unknown> | undefined;
			const conflict =
				this.options.strictBase &&
				base &&
				old &&
				Object.entries(base).some(
					([key, value]) => JSON.stringify(old[key]) !== JSON.stringify(value),
				);
			if (
				this.rejectEnvelope ||
				this.failures(input) ||
				(op.operation !== "create" && !old) ||
				conflict
			) {
				op.status = "failed";
				op.failed_at = this.timestamp();
				op.result = {
					error: conflict ? "stale_base" : "operation_rejected",
					message: "Fake provider rejected operation",
				};
			} else {
				const values = (
					op.operation === "create" ? op.payload.event : op.payload.changes
				) as Record<string, unknown> | undefined;
				const row = this.normalize(
					"events",
					{
						...values,
						id: op.event_id,
						calendar_id: op.calendar_id,
						akiflow_account_id: op.account_id,
						connector_id: op.connector_id,
						...(op.operation === "delete"
							? { deleted_at: this.timestamp(), status: "cancelled" }
							: {}),
					},
					old,
				);
				if (values && "location" in values)
					row.content = {
						...(row.content as object),
						location: values.location,
					};
				this.save("events", row);
				op.status = "succeeded";
				op.processed_at = this.timestamp();
				op.result = copy(row);
			}
			op.global_updated_at = this.timestamp();
			this.operationHistory.push({ id: op.id, status: op.status });
		};
		if (this.options.operationDelayRequests && !forceApply)
			this.pending.push({
				due: this.requests.length + this.options.operationDelayRequests + 1,
				at: 0,
				publish: apply,
			});
		else apply();
		return op;
	}
	private async handle(req: RecordedRequest, forceApply = false) {
		const path = req.url.pathname;
		if (path === "/oauth/refreshToken" && req.method === "POST") {
			const payload = JSON.parse(req.body);
			if (
				payload.refresh_token !== "fake-refresh" ||
				payload.client_id !== "10"
			)
				return json({ message: "Invalid refresh credentials" }, 401);
			const jwtPayload = Buffer.from(
				JSON.stringify({ user_id: 42, exp: 4102444800 }),
			).toString("base64url");
			this.refreshedToken = `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.refreshed`;
			return json({
				access_token: this.refreshedToken,
				refresh_token: "fake-refresh",
				expires_in: 3600,
				token_type: "Bearer",
			});
		}
		if (this.unauthorized) {
			this.unauthorized = false;
			return json({ message: "Token expired" }, 401);
		}
		if (
			this.refreshedToken &&
			req.headers.authorization !== `Bearer ${this.refreshedToken}`
		)
			return json({ message: "Old token" }, 401);
		const override = this.responders.findLast(
			(r) => r.method === req.method && r.path === path,
		);
		if (override)
			return json(
				typeof override.response === "function"
					? await override.response(req)
					: override.response,
				override.status,
			);
		if (req.method === "POST" && path === "/v5/event_operations") {
			const inputs = JSON.parse(req.body) as EventOperationPayload[];
			const data = inputs.map((op) => this.submitOperation(op, forceApply));
			return json({
				success: !this.rejectEnvelope,
				message: this.rejectEnvelope ? "Envelope rejected" : null,
				data: copy(data),
				failed: data
					.filter((op) => op.status === "failed")
					.map((op) => ({ id: op.id, message: "Operation failed" })),
			});
		}
		if (req.method === "GET" && path === "/v5/event_operations")
			return json({ success: true, data: copy([...this.operations.values()]) });
		if (path === "/v3/events/modifiers")
			return json({ success: false, message: "Deprecated endpoint" }, 410);
		const resource = path.split("/")[2] as Resource;
		if (resources.includes(resource) && path === `/v5/${resource}`) {
			if (req.method === "GET") return this.page(resource, req);
			if (
				req.method === "PATCH" &&
				(resource === "tasks" || resource === "time_slots")
			) {
				const data = (JSON.parse(req.body) as Row[]).map((input) => {
					const row = this.normalize(
						resource,
						input,
						this.stores.get(resource)!.get(input.id),
					);
					this.save(resource, row);
					return row;
				});
				return json({ success: true, message: null, data: copy(data) });
			}
		}
		if (req.method === "GET" && path.startsWith("/v5/tasks/")) {
			const row = this.visible
				.get("tasks")!
				.get(path.slice("/v5/tasks/".length));
			return json({ success: !!row, data: row ?? null }, row ? 200 : 404);
		}
		return json({ success: false, message: "Not Found" }, 404);
	}
}
