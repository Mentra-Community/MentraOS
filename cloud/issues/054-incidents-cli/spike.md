# Spike: Incidents CLI

## Overview

**What this doc covers:** A full architecture report on the current incident system (how bug reports flow from user to storage), and a design for a CLI tool that lets engineers and coding agents browse incidents and fetch logs without the web console.
**Why this doc exists:** Today, investigating a bug report requires either the web console (manual, slow for agents) or a bash script that only fetches logs by ID. There's no way to list incidents, filter by severity, search feedback text, or view phone state from the command line. This makes agent-assisted debugging (like we did for issues 051 and 052) dependent on the user pasting logs manually.
**Who should read this:** Cloud engineers, anyone building tooling for incident triage, anyone setting up the CLI for the first time.

---

## Current Incident System Architecture

### Data flow: creation → collection → processing → storage → retrieval

```
USER (mobile app) files bug report
  │
  ├─ POST /api/incidents → R2: skeleton JSON + MongoDB: record (status: processing)
  │                           │
  │                           └─ queueIncidentProcessing() [fire-and-forget async]
  │                                 │
  │                                 ├─ 1. Query BetterStack (cloud logs, 10min window)
  │                                 ├─ 2. Append cloud logs → R2
  │                                 ├─ 3. REQUEST_TELEMETRY → WebSocket → miniapps
  │                                 ├─ 4. Read full incident from R2
  │                                 ├─ 5. LLM generates BugSummary (title, description, severity)
  │                                 ├─ 6. Slack notification (fire-and-forget)
  │                                 └─ 7. MongoDB: status → complete/partial/failed
  │
  ├─ POST /api/incidents/:id/logs → R2: append phoneLogs
  ├─ POST /api/incidents/:id/logs (source: glasses) → R2: append glassesLogs
  ├─ POST /api/incidents/:id/logs (source: glasses_firmware) → R2: append glassesFirmwareLogs
  ├─ POST /api/incidents/:id/attachments → R2: store file + append metadata
  │
  └─ [Miniapps receive REQUEST_TELEMETRY via WebSocket]
       └─ POST /api/incidents/:id/logs (with uploadToken) → R2: append appTelemetryLogs[pkg]

RETRIEVAL:
  ├─ Console Admin:  GET /api/console/admin/incidents/*  (humans, web UI)
  ├─ Agent API:      GET /api/agent/incidents/*           (coding agents)
  └─ CLI:            scripts/fetch-incident-logs.sh       (bash wrapper)
```

### Storage: two layers

**MongoDB (`Incident` collection)** — metadata only:

| Field            | Type   | Notes                                            |
| ---------------- | ------ | ------------------------------------------------ |
| `incidentId`     | string | UUID v4, unique index                            |
| `userId`         | string | User email, compound index with createdAt        |
| `status`         | enum   | `processing` / `complete` / `partial` / `failed` |
| `summary`        | string | LLM-generated title (optional)                   |
| `linearIssueId`  | string | Disabled, always empty                           |
| `linearIssueUrl` | string | Disabled, always empty                           |
| `errorMessage`   | string | Processing failure details                       |
| `createdAt`      | Date   | Auto-managed                                     |
| `updatedAt`      | Date   | Auto-managed                                     |

**Cloudflare R2 (`mentra-incidents` bucket)** — actual log payloads:

Path: `incidents/{incidentId}.json`

```typescript
interface IncidentLogs {
  incidentId: string;
  createdAt: string;
  feedback: Record<string, unknown>; // user's bug report text + system info
  phoneState: Record<string, unknown>; // glasses, core, settings snapshots
  phoneLogs: LogEntry[]; // mobile app console logs
  cloudLogs: LogEntry[]; // BetterStack cloud logs (10min window)
  glassesLogs: LogEntry[]; // ASG client logs
  glassesFirmwareLogs: LogEntry[]; // BES chip logs
  appTelemetryLogs: Record<string, LogEntry[]>; // miniapp logs keyed by packageName
  attachments?: AttachmentMetadata[]; // screenshot references
}

interface LogEntry {
  timestamp: number | string;
  level: string;
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
}
```

Attachments stored separately: `incidents/{incidentId}/attachments/{timestamp}-{filename}`

R2 operations use per-incident in-memory locks (promise queue) to prevent race conditions from concurrent appends.

### APIs: three access surfaces

**Client API** (`/api/incidents`) — mobile app, auth: Bearer coreToken (JWT)

| Method | Path                             | Purpose                                   |
| ------ | -------------------------------- | ----------------------------------------- |
| POST   | `/api/incidents`                 | Create incident                           |
| POST   | `/api/incidents/:id/logs`        | Upload phone/glasses/firmware/app logs    |
| POST   | `/api/incidents/:id/attachments` | Upload screenshots (max 5, max 10MB each) |

**Console Admin API** (`/api/console/admin/incidents`) — web UI, auth: console session + isMentraAdmin

| Method | Path                         | Purpose                                  |
| ------ | ---------------------------- | ---------------------------------------- |
| GET    | `/`                          | List incidents (paginated)               |
| GET    | `/:id`                       | Get incident metadata                    |
| GET    | `/:id/logs`                  | Get full logs from R2                    |
| GET    | `/:id/attachments/:filename` | Proxy attachment image with Content-Type |

**Agent API** (`/api/agent/incidents`) — coding agents, auth: `X-Agent-Key` header

| Method | Path        | Purpose                            |
| ------ | ----------- | ---------------------------------- |
| GET    | `/`         | List incidents (limit, offset)     |
| GET    | `/:id`      | Get incident metadata from MongoDB |
| GET    | `/:id/logs` | Get full logs from R2              |

The agent API is what the CLI will use. It's missing: severity/status filtering, text search, and attachment access.

### Processing pipeline

`cloud/packages/cloud/src/services/incidents/incident-processor.service.ts`

Runs as a fire-and-forget async call (no job queue). Steps:

1. Fetch cloud logs from BetterStack — SQL query filtering by userId, 10-minute window, max 1000 entries
2. Append cloud logs to R2
3. Send `REQUEST_TELEMETRY` via WebSocket to all connected miniapps (5-minute upload token)
4. Read full incident back from R2
5. LLM summary via `generateBugSummary()` — temperature 0.3, max 500 tokens, produces title + description + affected components + severity. Falls back to raw user text on failure.
6. Slack notification to `#feedback` channel (webhook) — severity color-coded, includes "View Logs" button linking to console
7. Update MongoDB: `status → complete/partial/failed`, save `summary`

Linear ticket creation: fully built but disabled (commented out). Email notification: also disabled. Only Slack is active.

### Notable gaps

1. **No job queue** — if the server restarts during processing, the incident stays `processing` forever with no retry
2. **No log size limits** on phone/glasses uploads — only attachments are bounded (5 files, 10MB)
3. **App telemetry requires WebSocket** — if a miniapp is disconnected at report time, its telemetry isn't collected (upload token expires in 5 minutes)
4. **R2 locks are in-memory** — lost on restart, don't work across pods
5. **Agent API has no filtering** — can only list with limit/offset, no severity, status, or text search

---

## CLI Design

### Primary workflow

The core use case is: someone gives you an incident ID, you pull everything and investigate.

```
1. Get ID:     "c3f3e699-43fa-45e2-a6d3-09c64ab64980"
2. Get info:   bun run incidents get c3f3e699
3. Phone logs: bun run incidents logs c3f3e699 --type phone
4. Cloud logs: bun run incidents logs c3f3e699 --type cloud
5. Search:     bun run incidents logs c3f3e699 --grep "disconnect"
```

The `list` command is secondary — for when you don't have an ID and need to find one.

### Scope: no API changes

The existing agent API already supports everything the CLI needs:

- `GET /api/agent/incidents` — list with limit/offset
- `GET /api/agent/incidents/:id` — metadata from MongoDB
- `GET /api/agent/incidents/:id/logs` — full logs from R2

All filtering (severity, user, date, grep) is done **client-side in the CLI**. Not efficient at scale, but fine for now — the incident volume is manageable. API-side filtering (add query params, add severity to MongoDB) is a separate future issue.

### Location

New package at `cloud/packages/incidents/`. Separate from the cloud server — it's a client tool, not a server component. Has its own `package.json` with minimal dependencies.

### Auth

Reads `MENTRA_AGENT_API_KEY` from environment. The key should live in `cloud/.env` (gitignored). The CLI fails with a clear message if the key is missing. The key is never logged or included in output.

The API host defaults to `https://api.mentra.glass` but can be overridden via `MENTRA_API_HOST` env var (for testing against dev/staging).

### Commands

**`get <id>`** — the main command. Show incident details.

```
bun run incidents get c3f3e699

Options:
  --json              Output raw JSON
```

Output: formatted display of feedback text (expected/actual behavior), severity rating, system info (app version, platform, device, OS, glasses status, wearable, network, build info), phone state snapshot, LLM summary, running apps, timestamps.

Accepts full UUID or a short prefix (first 8 chars) — the CLI matches against the list.

**`logs <id>`** — fetch and display logs for an incident

```
bun run incidents logs c3f3e699 --type phone
bun run incidents logs c3f3e699 --type cloud --level error
bun run incidents logs c3f3e699 --grep "disconnect"

Options:
  --type <type>       Log type: phone, cloud, glasses, firmware, apps, all (default: all)
  --app <package>     Filter app telemetry by package name
  --level <level>     Filter by log level: error, warn, info, debug
  --grep <pattern>    Search log messages (case-insensitive substring match)
  --limit <n>         Max log entries to display (default: 200)
  --json              Output raw JSON
```

Output: formatted log entries, color-coded by level (red=error, yellow=warn, white=info, gray=debug). Each line: `[timestamp] [level] [source] message`. Filtered client-side.

**`list`** — list recent incidents (secondary, for finding IDs)

```
bun run incidents list
bun run incidents list --limit 50
bun run incidents list --user johndoe@gmail.com

Options:
  --limit <n>         Number of results (default: 20, max: 500)
  --user <email>      Filter by user email (client-side filter)
  --severity <n>      Filter by severity >= n (client-side, requires fetching logs for each)
  --json              Output raw JSON
```

Output: table with columns `ID (short) | Status | Summary | User | Created`

Note: `--user` and `--severity` filtering happens client-side after fetching the list from the API. `--user` is cheap (metadata includes userId). `--severity` is expensive (severity is in R2 logs, not MongoDB metadata) — for v1, skip it or just show it without filtering.

### Package structure

```
cloud/packages/incidents/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts           # Entry point, arg parsing, command routing
│   ├── client.ts        # HTTP client wrapping the agent API
│   ├── commands/
│   │   ├── list.ts      # list command
│   │   ├── get.ts       # get command
│   │   └── logs.ts      # logs command
│   └── format.ts        # Output formatting (table, colors, log lines)
└── README.md
```

### Running it

```bash
# From the incidents package
cd cloud/packages/incidents
bun run src/cli.ts get c3f3e699
bun run src/cli.ts logs c3f3e699 --type phone

# Or via package.json script alias
bun run incidents get c3f3e699
```

---

## Future Enhancements (separate issues, not v1)

**API-side filtering:** Add `userId`, `severity`, `since` query params to `GET /api/agent/incidents`. Requires adding `severity` to the MongoDB Incident model (available at creation time from `feedback.severityRating`). Eliminates client-side filtering overhead.

**Remote-triggered incident report:** New `POST /api/agent/incidents/request` endpoint that takes a `userId` and pushes a `REQUEST_INCIDENT_REPORT` message via the glasses WebSocket to the user's phone. The phone collects current logs + phone state and auto-submits a bug report. Captures state at the exact moment of the issue instead of whenever the user gets around to filing. Requires client changes (new message type handler in mobile).

**Attachment access:** The agent API doesn't have an attachment endpoint (console API does). Add `GET /api/agent/incidents/:id/attachments/:filename` to the agent API if the CLI needs to fetch screenshots.

---

## Next Steps

1. Build the CLI package — zero API changes, just the client tool
2. Add `MENTRA_AGENT_API_KEY` to `cloud/.env.example` with a placeholder value
3. Test against prod agent API with real incident data
4. Separate issue for API-side filtering enhancements
5. Separate issue for remote-triggered incident reports
