# Akiflow API Specification

**Base URL**: `https://api.akiflow.com`
**API Version**: v5 (Tasks, Labels, Tags, Time Slots, Contacts) / v3 (Calendars, Events)
**Reverse Engineered**: 2026-02-01

---

## Table of Contents

1. [Authentication](#authentication)
2. [Required Headers](#required-headers)
3. [Tasks API (Full CRUD)](#tasks-api)
4. [Labels API (Projects)](#labels-api)
5. [Tags API](#tags-api)
6. [Time Slots API](#time-slots-api)
7. [Calendars API](#calendars-api)
8. [Events API](#events-api)
9. [User Settings API](#user-settings-api)
10. [Sync Mechanism](#sync-mechanism)
11. [Token Extraction from Arc Browser](#token-extraction)

---

## Authentication

### Token Type

- **JWT Bearer Token** (RS256 signed)
- Token expiry: ~30 minutes from issuance

### How to Obtain Token

Akiflow uses **session-based authentication** via web cookies. The JWT token is obtained after login through the web app and stored in **IndexedDB** (`akiflow_system.internal.akiUserToken`).

For programmatic access, extract the token from browser session using CDP (Chrome DevTools Protocol) or by reading the `remember_web_*` cookie from Arc/Chrome.

---

## Required Headers

| Header | Required | Description |
| -------- | ---------- | ------------- |
| `Authorization` | Yes | `Bearer <JWT_TOKEN>` |
| `Akiflow-Client-Id` | Yes | Client UUID (stored in IndexedDB `akiflow_system.general.clientId`) |
| `Akiflow-Version` | Yes | App version (e.g., `2.66.3`) |
| `Akiflow-Platform` | Yes | Platform identifier (`mac`, `win`, `web`, `ios`, `android`) |
| `Accept` | Yes | `application/json` |
| `Content-Type` | Required for PATCH | `application/json` |

### Example Headers

```bash
-H "Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9..." \
-H "Akiflow-Client-Id: <YOUR_CLIENT_ID>" \
-H "Akiflow-Version: 2.66.3" \
-H "Akiflow-Platform: mac" \
-H "Accept: application/json"
```

---

## Tasks API

**Endpoint**: `/v5/tasks`
**Supported Methods**: `GET`, `PATCH` (upsert pattern - no POST/PUT/DELETE)

### Read Tasks

```bash
GET /v5/tasks?limit=2500
GET /v5/tasks?limit=2500&sync_token=<base64_token>
```

**Query Parameters:**

| Parameter | Type | Description |
| ----------- | ------ | ------------- |
| `limit` | int | Max number of tasks to return (max: 2500) |
| `sync_token` | string | Base64 encoded token for incremental sync |

**Response:**

```json
{
  "success": true,
  "message": null,
  "data": [...],
  "sync_token": "eyJjaGFuZ2VfaWQ...",
  "has_next_page": false
}
```

### Create/Update Tasks (Upsert)

```bash
PATCH /v5/tasks
Content-Type: application/json

[
  {
    "id": "<uuid>",
    "title": "Task title",
    "global_created_at": "2026-02-01T05:39:12.000Z",
    "global_updated_at": "2026-02-01T05:39:12.000Z"
  }
]
```

**Request Body**: Array of task objects

**Required Fields for CREATE:**

| Field | Type | Description |
| ------- | ------ | ------------- |
| `id` | UUID | Client-generated UUID |
| `title` | string | Task title |
| `global_created_at` | ISO8601 | Creation timestamp |
| `global_updated_at` | ISO8601 | Update timestamp |

**Optional Fields:**

| Field | Type | Description |
| ------- | ------ | ------------- |
| `description` | string | Task description |
| `date` | date | Scheduled date (YYYY-MM-DD) |
| `datetime` | ISO8601 | Scheduled datetime |
| `datetime_tz` | string | Timezone (e.g., "Asia/Seoul") |
| `duration` | int | Duration in seconds |
| `priority` | int | Priority level (1 = high) |
| `dailyGoal` | int | Daily goal flag (0/1) |
| `listId` | UUID | Project/Label ID |
| `section_id` | UUID | Section within project |
| `tags_ids` | UUID[] | Array of tag IDs |
| `due_date` | date | Due date |
| `links` | string[] | Array of URLs |
| `content` | object | Additional metadata |
| `calendar_id` | UUID | Linked calendar |
| `recurrence` | string | Recurrence rule (RRULE) |

### Complete Task

```bash
PATCH /v5/tasks
Content-Type: application/json

[
  {
    "id": "<uuid>",
    "done": true,
    "done_at": "2026-02-01T05:40:56.000Z",
    "status": 2,
    "global_updated_at": "2026-02-01T05:40:56.000Z"
  }
]
```

**Status Values:**

- `null` or `0`: Pending
- `1`: In Progress (assumed)
- `2`: Completed

### Uncomplete Task

```bash
PATCH /v5/tasks
Content-Type: application/json

[
  {
    "id": "<uuid>",
    "done": false,
    "done_at": null,
    "status": 0,
    "global_updated_at": "2026-02-01T05:41:00.000Z"
  }
]
```

### Delete Task (Soft Delete)

```bash
PATCH /v5/tasks
Content-Type: application/json

[
  {
    "id": "<uuid>",
    "deleted_at": "2026-02-01T05:41:52.000Z",
    "global_updated_at": "2026-02-01T05:41:52.000Z"
  }
]
```

### Task Object Schema

```typescript
interface Task {
  id: string;                          // UUID
  user_id: number;                     // User ID
  recurring_id: string | null;         // Parent recurring task ID
  title: string;                       // Task title
  description: string | null;          // Description/notes
  date: string | null;                 // Scheduled date (YYYY-MM-DD)
  datetime: string | null;             // Scheduled datetime (ISO8601)
  datetime_tz: string | null;          // Timezone
  original_date: string | null;        // Original date (for rescheduled)
  original_datetime: string | null;    // Original datetime
  duration: number | null;             // Duration in seconds
  recurrence: string | null;           // RRULE string
  recurrence_version: number | null;   // Recurrence version
  status: number | null;               // Status (0=pending, 2=done)
  priority: number | null;             // Priority (1=high)
  dailyGoal: number | null;            // Daily goal flag
  done: boolean;                       // Completion status
  done_at: string | null;              // Completion timestamp
  read_at: string | null;              // Read timestamp
  listId: string | null;               // Project/Label UUID
  section_id: string | null;           // Section UUID
  tags_ids: string[];                  // Tag UUIDs
  sorting: number;                     // Sort order (timestamp-based)
  sorting_label: number | null;        // Sort within label
  origin: string | null;               // Source type
  due_date: string | null;             // Due date
  connector_id: string | null;         // Integration connector (slack, notion, etc.)
  origin_id: string | null;            // External ID
  origin_account_id: string | null;    // External account ID
  akiflow_account_id: string | null;   // Linked Akiflow account
  doc: object;                         // Integration-specific data
  calendar_id: string | null;          // Calendar UUID
  time_slot_id: string | null;         // Time slot UUID
  links: string[];                     // Attached URLs
  content: object;                     // AI predictions, event settings
  trashed_at: string | null;           // Trash timestamp
  plan_unit: string | null;            // Planning unit
  plan_period: string | null;          // Planning period
  global_list_id_updated_at: string | null;
  global_tags_ids_updated_at: string | null;
  global_created_at: string;           // Creation timestamp
  global_updated_at: string;           // Update timestamp
  data: object;                        // Additional data
  deleted_at: string | null;           // Soft delete timestamp
}
```

---

## Labels API

**Endpoint**: `/v5/labels`
**Supported Methods**: `GET`, `PATCH`

Labels represent **Projects** in the Akiflow UI.

### Read Labels

```bash
GET /v5/labels?limit=2500
GET /v5/labels?limit=2500&sync_token=<token>
```

### Label Object Schema

```typescript
interface Label {
  id: string;                    // UUID
  user_id: number;               // User ID
  parent_id: string | null;      // Parent label (for folders)
  title: string;                 // Project name
  icon: string | null;           // Icon identifier
  color: string | null;          // Color palette (e.g., "palette-blueberry")
  sorting: number;               // Sort order
  type: string | null;           // Label type
  global_created_at: string;     // Creation timestamp
  global_updated_at: string;     // Update timestamp
  data: object;                  // Additional data
  deleted_at: string | null;     // Soft delete timestamp
}
```

**Available Colors:**

- `palette-blueberry`
- `palette-cobalt`
- `palette-violet`
- `palette-grape`
- `palette-tangerine`
- `palette-mint`
- etc.

---

## Tags API

**Endpoint**: `/v5/tags`
**Supported Methods**: `GET`, `PATCH`

### Read Tags

```bash
GET /v5/tags?limit=2500
GET /v5/tags?limit=2500&sync_token=<token>
```

---

## Time Slots API

**Endpoint**: `/v5/time_slots`
**Supported Methods**: `GET`, `PATCH`

Time slots represent **calendar blocks** in the planner.

### Read Time Slots

```bash
GET /v5/time_slots?limit=2500
GET /v5/time_slots?limit=2500&sync_token=<token>
```

### Time Slot Object Schema

```typescript
interface TimeSlot {
  id: string;                      // UUID
  user_id: number;                 // User ID
  recurring_id: string | null;     // Parent recurring slot
  calendar_id: string;             // Calendar UUID
  label_id: string | null;         // Linked project
  section_id: string | null;       // Section
  status: string;                  // "confirmed" | "tentative"
  title: string;                   // Slot title
  description: string | null;      // Description
  original_start_time: string | null;
  start_time: string;              // Start datetime (ISO8601)
  end_time: string;                // End datetime (ISO8601)
  start_datetime_tz: string;       // Timezone
  recurrence: string | null;       // RRULE
  color: string | null;            // Color override
  content: object;                 // Additional data
  global_label_id_updated_at: string | null;
  global_created_at: string;       // Creation timestamp
  global_updated_at: string;       // Update timestamp
  data: object;                    // Additional data
  deleted_at: string | null;       // Soft delete timestamp
}
```

---

## Calendars API

**Endpoint**: `/v3/calendars`
**Supported Methods**: `GET`

### Read Calendars

```bash
GET /v3/calendars?per_page=2500&with_deleted=false
GET /v3/calendars?per_page=2500&with_deleted=true&updatedAfter=<ISO8601>
```

---

## Events API

### Current v5 API (verified 2026-08-19)

Event reads use `GET /v5/events`. Create, update, and delete writes use
`POST /v5/event_operations`. `POST /v3/events` now returns HTTP 410 with
`This endpoint has been deprecated. Please use the V5 API.`

Create operations use a client-generated operation ID and event ID:

```json
[
  {
    "id": "<operation-uuid>",
    "event_id": "<event-uuid>",
    "connector_id": "google",
    "account_id": "<akiflow-account-id>",
    "calendar_id": "<akiflow-calendar-id>",
    "operation": "create",
    "payload": {
      "event": {
        "title": "Meeting",
        "description": "Discuss launch",
        "start_time": "2026-06-20T20:00:00.000Z",
        "end_time": "2026-06-20T20:30:00.000Z",
        "start_datetime_tz": "America/Los_Angeles",
        "location": "Office"
      }
    },
    "result": null,
    "processed_at": null,
    "failed_at": null,
    "client_order": 0,
    "global_created_at": "2026-08-19T12:00:00.000Z",
    "deleted_at": null,
    "global_updated_at": "2026-08-19T12:00:00.000Z"
  }
]
```

The accepted operation initially has `status: "pending"`; Akiflow processes it
asynchronously against the connected calendar provider.

Updates use `operation: "patch"` with `payload.base` containing the pre-edit
provider fields and `payload.changes` containing the desired fields. Supplying
the desired fields as both base and changes causes a provider conflict.

Deletes use `operation: "delete"` with
`payload: { "send_updates": true | false }`.

The legacy attendee-modifier endpoint, `POST /v3/events/modifiers`, returns
HTTP 410 and is never called. Attendee add/remove ride the v5 path as an
explicit `operation: "patch"` whose `payload.changes.attendees` carries the
full merged attendee list (existing members preserved, new ones marked
`needsAction`), with operation-level `payload.send_updates` controlling guest
notifications. Patch-level `send_updates` provider semantics have not been
independently captured; the field is emitted with the delete-documented shape
and tests assert exactly what goes on the wire.

### Legacy v3 capture (historical)

**Endpoint**: `/v3/events`
**Supported Methods**: `GET`, `POST` (create/update sync payload)

### Read Events

```bash
GET /v3/events?per_page=2500&with_deleted=false
GET /v3/events?per_page=2500&with_deleted=true&updatedAfter=<ISO8601>
GET /v3/events?cursor=<base64>&with_deleted=false&per_page=2500
```

### Event Modifiers

```bash
GET /v3/events/modifiers?per_page=2500&with_deleted=false
POST /v3/events/modifiers
```

### Create Timed Event

Captured from Akiflow Web `2.74.24` on 2026-06-19. The web client builds a draft event model, strips `data`, `user_id`, and `fingerprints` in `getEntityForRemote()`, then calls `v3.postEvents(...)`, which is `POST /v3/events`.

CLI create support is intentionally narrow: timed, non-recurring Google Calendar events with no attendees, no conference link, no reminders, and no all-day mode.

```bash
POST /v3/events
Content-Type: application/json
```

Request body is an array of event objects:

```json
[
  {
    "title": "Meeting",
    "description": "Discuss launch",
    "start_time": "2026-06-20T20:00:00.000Z",
    "end_time": "2026-06-20T20:30:00.000Z",
    "id": "<client-generated-uuid>",
    "status": "confirmed",
    "start_datetime_tz": "America/Los_Angeles",
    "creator_id": "<calendar-origin-id>",
    "organizer_id": "<calendar-origin-id>",
    "origin_id": null,
    "connector_id": "google",
    "akiflow_account_id": "<akiflow-account-id>",
    "origin_account_id": "<google-account-id>",
    "recurring_id": null,
    "origin_recurring_id": null,
    "calendar_id": "<akiflow-calendar-id>",
    "origin_calendar_id": "<google-calendar-id>",
    "original_start_time": null,
    "original_start_date": null,
    "start_date": null,
    "end_date": null,
    "end_datetime_tz": null,
    "origin_updated_at": null,
    "etag": null,
    "content": {
      "sendUpdates": "all",
      "location": "Office"
    },
    "attendees": [],
    "recurrence": null,
    "recurrence_exception": false,
    "declined": false,
    "read_only": false,
    "hidden": false,
    "url": null,
    "meeting_status": null,
    "meeting_url": null,
    "meeting_icon": null,
    "meeting_solution": null,
    "color": null,
    "calendar_color": "#7986cb",
    "task_id": null,
    "time_slot_id": null,
    "recurrence_exception_delete": false,
    "recurrence_sync_retry": null,
    "errors": null,
    "global_created_at": null,
    "deleted_at": null,
    "global_updated_at": "2026-06-19T22:42:58.271Z"
  }
]
```

Response shape matches other Akiflow API envelopes:

```json
{
  "success": true,
  "message": null,
  "data": [{ "...": "created event" }]
}
```

Legacy cleanup/delete behavior: the web UI deleted events by clearing event fields, setting `status` to `"cancelled"`, soft-deleting with `deleted_at`, then syncing through the same v3 events path.

### Update Timed Event

Captured behavior uses the same endpoint and full event object array as creation:

```bash
POST /v3/events
Content-Type: application/json
```

The web client sends the event model back through `v3.postEvents(...)`. For CLI v1, update starts from the cached event, refuses all-day/recurring/hidden/deleted/read-only/non-Google events, strips local-only `data`, `user_id`, and `fingerprints`, preserves unspecified fields and attendees, and changes only the requested timing/basic fields.

Required update changes for timed events:

```json
{
  "id": "<existing-event-id>",
  "start_time": "2026-06-20T20:00:00.000Z",
  "end_time": "2026-06-20T20:30:00.000Z",
  "start_datetime_tz": "America/Los_Angeles",
  "end_datetime_tz": "America/Los_Angeles",
  "start_date": null,
  "end_date": null,
  "content": {
    "sendUpdates": "all",
    "location": "Office"
  },
  "global_updated_at": "2026-06-19T22:42:58.271Z"
}
```

Optional legacy update changes: `title`, `description`, and `content.location`. Existing attendees were preserved on the event object.

### Update Attendees

Captured from Akiflow Web on 2026-06-19. The UI creates an event modifier record rather than posting the full event object for attendee list edits.

```bash
POST /v3/events/modifiers
Content-Type: application/json
```

Request body is an array of event modifier objects:

```json
[
  {
    "id": "<client-generated-uuid>",
    "akiflow_account_id": "<akiflow-account-id>",
    "event_id": "<existing-event-id>",
    "calendar_id": "<akiflow-calendar-id>",
    "action": "attendees/updateList",
    "content": {
      "attendeeEmailsToAdd": ["julia@example.com"],
      "attendeeEmailsToRemove": [],
      "attendeeResponseStatusesByEmail": {
        "julia@example.com": "needsAction"
      },
      "sendUpdates": "all"
    },
    "processed_at": null,
    "failed_at": null,
    "result": null,
    "attempts": 0,
    "global_created_at": "2026-06-19T22:42:58.271Z",
    "deleted_at": null,
    "global_updated_at": "2026-06-19T22:42:58.271Z"
  }
]
```

For attendee removal, `attendeeEmailsToAdd` is empty and `attendeeEmailsToRemove` contains existing attendee email addresses. `attendeeResponseStatusesByEmail` is only needed when adding attendees.

---

## User Settings API

**Endpoint**: `/v5/user/settings`
**Supported Methods**: `GET`, `PATCH`

### Read Settings

```bash
GET /v5/user/settings
```

### Update Settings

```bash
PATCH /v5/user/settings
Content-Type: application/json

{
  "client_id": "<uuid>",
  "settings": {
    "general": [
      {"key": "timezoneOffset", "value": -540, "updatedAt": 1769924267129},
      {"key": "timezoneName", "value": "Asia/Seoul", "updatedAt": 1769924267129}
    ],
    "shareAvailability": [
      {"key": "baseUrlPath", "value": "", "updatedAt": 1769924267128}
    ]
  }
}
```

---

## Sync Mechanism

Akiflow uses an **optimistic offline-first architecture** with incremental sync:

1. **Initial Sync**: `GET /v5/tasks?limit=2500` (no sync_token)
2. **Incremental Sync**: `GET /v5/tasks?limit=2500&sync_token=<token>`
3. **Sync Token**: Base64 encoded JSON containing `change_id` and `ts` (timestamp)

### Sync Token Format

```json
{
  "change_id": 691444480,
  "ts": "2026-02-01T05:34:05.589885Z"
}
```

The server returns a new `sync_token` with each response. Use it for the next request to get only changed items.

---

## Token Extraction

### From Arc Browser (Python)

```python
import browser_cookie3

# Get Akiflow cookies from Arc
cj = browser_cookie3.arc(domain_name='akiflow.com')

# The remember_web_* cookie authenticates the session
for cookie in cj:
    if 'remember_web_' in cookie.name:
        print(f"Session Cookie: {cookie.value}")
```

### From Playwright/CDP

```javascript
// After login, capture API requests via CDP
const client = await page.context().newCDPSession(page);
await client.send('Network.enable');

client.on('Network.requestWillBeSent', (params) => {
  if (params.request.url.includes('api.akiflow.com')) {
    console.log('Authorization:', params.request.headers.Authorization);
    console.log('Client-Id:', params.request.headers['Akiflow-Client-Id']);
  }
});
```

### From IndexedDB (Browser Console)

```javascript
// Open akiflow_system database
const request = indexedDB.open('akiflow_system');
request.onsuccess = (e) => {
  const db = e.target.result;

  // Get client ID
  const tx1 = db.transaction(['general'], 'readonly');
  const store1 = tx1.objectStore('general');
  store1.getAll().onsuccess = (e) => console.log('General:', e.target.result);

  // Get internal data (includes aki tokens)
  const tx2 = db.transaction(['internal'], 'readonly');
  const store2 = tx2.objectStore('internal');
  store2.getAll().onsuccess = (e) => console.log('Internal:', e.target.result);
};
```

---

## curl Examples

### Create Task

```bash
curl -X PATCH "https://api.akiflow.com/v5/tasks" \
  -H "Authorization: Bearer <token>" \
  -H "Akiflow-Client-Id: <uuid>" \
  -H "Akiflow-Version: 2.66.3" \
  -H "Akiflow-Platform: mac" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '[{
    "id": "'"$(uuidgen | tr '[:upper:]' '[:lower:]')"'",
    "title": "My new task",
    "date": "2026-02-01",
    "global_created_at": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'",
    "global_updated_at": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
  }]'
```

### Complete Task (curl example)

```bash
curl -X PATCH "https://api.akiflow.com/v5/tasks" \
  -H "Authorization: Bearer <token>" \
  -H "Akiflow-Client-Id: <uuid>" \
  -H "Akiflow-Version: 2.66.3" \
  -H "Akiflow-Platform: mac" \
  -H "Content-Type: application/json" \
  -d '[{
    "id": "<task-uuid>",
    "done": true,
    "done_at": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'",
    "status": 2,
    "global_updated_at": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
  }]'
```

### Delete Task

```bash
curl -X PATCH "https://api.akiflow.com/v5/tasks" \
  -H "Authorization: Bearer <token>" \
  -H "Akiflow-Client-Id: <uuid>" \
  -H "Akiflow-Version: 2.66.3" \
  -H "Akiflow-Platform: mac" \
  -H "Content-Type: application/json" \
  -d '[{
    "id": "<task-uuid>",
    "deleted_at": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'",
    "global_updated_at": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
  }]'
```

### List Tasks

```bash
curl -X GET "https://api.akiflow.com/v5/tasks?limit=100" \
  -H "Authorization: Bearer <token>" \
  -H "Akiflow-Client-Id: <uuid>" \
  -H "Akiflow-Version: 2.66.3" \
  -H "Akiflow-Platform: mac" \
  -H "Accept: application/json"
```

---

## Notes

1. **Upsert Pattern**: Akiflow uses PATCH with arrays for all create/update/delete operations. There's no POST endpoint for tasks.

2. **Soft Delete**: Entities are soft-deleted by setting `deleted_at`. They can be restored by setting it back to `null`.

3. **Client-Side Timestamps**: The client is responsible for generating `global_created_at`, `global_updated_at`, and `id` (UUID).

4. **Sync Token Validity**: Sync tokens may expire. If a sync request fails, fall back to full sync without token.

5. **Rate Limits**: Not officially documented. Standard practice: 100-200 requests/minute should be safe.

---

## Other Endpoints (Discovered)

| Endpoint | Description |
| ---------- | ------------- |
| `/v5/accounts` | Connected accounts (Google, Notion, Slack, etc.) |
| `/v5/contacts` | Contact list |
| `/v3/notion/sync-now` | Trigger Notion sync |
| `/web/api/v2/user` | Web user info |
| `/web/api/pusherAuth` | Pusher authentication for real-time updates |
| `/aki/api/v1/chat/token` | AI chat token |

---

> Generated by reverse engineering Akiflow web app (v2.66.3).

---

## Recurrence (Workstream J, 2026-09-30)

### Event recurrence fields

| Field | Type | Notes |
| ----- | ---- | ----- |
| `recurrence` | `string[] \| null` | Array of RRULE strings, e.g. `["RRULE:FREQ=WEEKLY;BYDAY=MO"]` |
| `recurring_id` | `string \| null` | Series master ID for instances; master has `recurring_id === id` |
| `origin_recurring_id` | `string \| null` | Provider-side series ID |
| `original_start_time` | `string \| null` | **Occurrence anchor**: the instance's original start instant. This is the stable identity for per-instance operations — never use current `start_time`, which moves with edits. |
| `original_start_date` | `string \| null` | Date portion of the anchor |
| `recurrence_exception` | `boolean` | Whether this record is an exception to the series |
| `recurrence_exception_delete` | `boolean` | Whether the exception is a deletion |

### Capability status (unconfirmed)

- **Akiflow recurrence-exception writes**: NOT confirmed. The Akiflow API's support for per-instance edits (exceptions) is unknown as of 2026-09-30. The CLI gates exception writes behind `AF_AKIFLOW_EXCEPTION_WRITES=1` (explicit opt-in, disposable fixtures only). Default: refuse.
- **Per-instance edits**: route via Google Calendar API directly (fallback adapter), using the event's observed `origin_id` as the Google event ID. Instance address: `<googleEventId>_<originalStartTimestamp>`. All Google writes use `sendUpdates=none`.
- **Series delete**: truncate via RRULE UNTIL on the master, or delete the master. Never loop instances.

### Identity rule

Provider identity comes ONLY from observed `origin_id` / provider fields. The CLI never title-searches to guess a provider ID. Ambiguous or missing identity refuses to mutate.
