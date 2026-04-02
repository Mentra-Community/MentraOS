# Design: Incidents CLI

## Overview

**What this doc covers:** File-by-file implementation plan for the incidents CLI tool — a standalone package that wraps the existing agent API to let engineers and coding agents browse incidents and fetch logs from the terminal.
**Why this doc exists:** The spec defines what the CLI does. This doc defines exactly how to build it — every file, every function signature, every formatting decision.
**What you need to know first:** [spike.md](./spike.md) for system architecture, [spec.md](./spec.md) for behaviors and decisions.
**Who should read this:** Whoever is implementing this. Read the spec first.

---

## Changes Summary

| File                                            | What     | Notes                                         |
| ----------------------------------------------- | -------- | --------------------------------------------- |
| `cloud/packages/incidents/package.json`         | New      | Package manifest, `bin` entry for CLI         |
| `cloud/packages/incidents/tsconfig.json`        | New      | TypeScript config, strict mode                |
| `cloud/packages/incidents/src/cli.ts`           | New      | Entry point, arg parsing, command routing     |
| `cloud/packages/incidents/src/client.ts`        | New      | HTTP client wrapping agent API                |
| `cloud/packages/incidents/src/commands/list.ts` | New      | `list` command                                |
| `cloud/packages/incidents/src/commands/get.ts`  | New      | `get` command                                 |
| `cloud/packages/incidents/src/commands/logs.ts` | New      | `logs` command                                |
| `cloud/packages/incidents/src/format.ts`        | New      | Output formatting — tables, colors, log lines |
| `cloud/.env.example`                            | Modified | Add `MENTRA_AGENT_API_KEY` placeholder        |

Zero cloud/API changes. This is a client-only package.

---

## Package Config

### `cloud/packages/incidents/package.json`

```json
{
  "name": "@mentra/incidents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "incidents": "bun run src/cli.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  }
}
```

No runtime dependencies. Uses `fetch()` (built into Bun), `process.argv` (built-in), ANSI escape codes (no chalk). The package is `private: true` — it's an internal tool, not published.

### `cloud/packages/incidents/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

---

## Entry Point: `src/cli.ts`

Parses `process.argv`, routes to command handlers. No external CLI framework — three commands don't justify yargs/commander.

```typescript
#!/usr/bin/env bun

import {listCommand} from "./commands/list"
import {getCommand} from "./commands/get"
import {logsCommand} from "./commands/logs"

const USAGE = `
Usage: bun run incidents <command> [options]

Commands:
  get <id>       Show incident details
  logs <id>      Fetch and display incident logs
  list           List recent incidents

Options:
  --help         Show this help message

Run 'bun run incidents <command> --help' for command-specific options.
`.trim()

function parseArgs(argv: string[]): {command: string; args: string[]; flags: Record<string, string | boolean>} {
  // argv[0] = bun, argv[1] = script path, argv[2+] = user args
  const userArgs = argv.slice(2)
  const command = userArgs[0] || ""
  const rest = userArgs.slice(1)

  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith("--")) {
        flags[key] = next
        i++ // skip next
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return {command, args: positional, flags}
}

async function main() {
  const {command, args, flags} = parseArgs(process.argv)

  if (!command || command === "--help" || flags.help) {
    console.log(USAGE)
    process.exit(0)
  }

  switch (command) {
    case "get":
      await getCommand(args, flags)
      break
    case "logs":
      await logsCommand(args, flags)
      break
    case "list":
      await listCommand(args, flags)
      break
    default:
      console.error(`Unknown command: ${command}\n`)
      console.log(USAGE)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(1)
})
```

### `parseArgs` behavior

- `--flag value` → `{ flag: "value" }`
- `--flag` (no value, or next arg starts with `--`) → `{ flag: true }`
- Non-flag args → positional array
- No short flags (`-f`) — not worth the complexity for three commands

---

## HTTP Client: `src/client.ts`

Thin wrapper around `fetch()` + the agent API. Handles auth, host resolution, error formatting.

```typescript
export interface ClientConfig {
  apiKey: string
  host: string // e.g. "https://api.mentra.glass"
}

export interface PaginatedResponse<T> {
  success: boolean
  data: T[]
  pagination: {
    total: number
    limit: number
    offset: number
    hasMore: boolean
  }
}

export interface SingleResponse<T> {
  success: boolean
  data: T
}

export interface IncidentMeta {
  incidentId: string
  userId: string
  status: string
  summary: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface LogEntry {
  timestamp: number | string
  level: string
  message: string
  source?: string
  metadata?: Record<string, unknown>
}

export interface IncidentLogs {
  incidentId: string
  createdAt: string
  feedback: Record<string, unknown>
  phoneState: Record<string, unknown>
  phoneLogs: LogEntry[]
  cloudLogs: LogEntry[]
  glassesLogs: LogEntry[]
  glassesFirmwareLogs: LogEntry[]
  appTelemetryLogs: Record<string, LogEntry[]>
  attachments?: {filename: string; timestamp: string}[]
}

export function createClient(config: ClientConfig) {
  const {apiKey, host} = config

  async function request<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, host)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v)
      }
    }

    const res = await fetch(url.toString(), {
      headers: {"X-Agent-Key": apiKey},
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`API ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
  }

  return {
    async listIncidents(limit: number, offset: number): Promise<PaginatedResponse<IncidentMeta>> {
      return request("/api/agent/incidents", {
        limit: String(limit),
        offset: String(offset),
      })
    },

    async getIncident(id: string): Promise<SingleResponse<IncidentMeta>> {
      return request(`/api/agent/incidents/${id}`)
    },

    async getIncidentLogs(id: string): Promise<SingleResponse<IncidentLogs>> {
      return request(`/api/agent/incidents/${id}/logs`)
    },
  }
}

export type Client = ReturnType<typeof createClient>
```

### `resolveConfig()` — shared by all commands

```typescript
export function resolveConfig(): ClientConfig {
  const apiKey = process.env.MENTRA_AGENT_API_KEY
  if (!apiKey) {
    console.error("Error: MENTRA_AGENT_API_KEY environment variable is not set.")
    console.error("Set it in cloud/.env or export it in your shell.")
    process.exit(1)
  }

  const host = process.env.MENTRA_API_HOST || "https://api.mentra.glass"

  return {apiKey, host}
}
```

This lives in `client.ts` alongside the client factory. Every command calls `resolveConfig()` → `createClient(config)` at the top.

### Short ID resolution

Short IDs (first 8 chars of UUID) need to be resolved to full UUIDs. This is done by listing incidents and matching the prefix:

```typescript
export async function resolveIncidentId(client: Client, shortId: string): Promise<string> {
  // If it looks like a full UUID, use it directly
  if (shortId.length > 8) {
    return shortId
  }

  // Fetch recent incidents and match prefix
  const res = await client.listIncidents(500, 0)
  const matches = res.data.filter((i) => i.incidentId.startsWith(shortId))

  if (matches.length === 0) {
    throw new Error(`No incident found matching prefix "${shortId}"`)
  }
  if (matches.length > 1) {
    const ids = matches.map((i) => i.incidentId.slice(0, 8)).join(", ")
    throw new Error(`Ambiguous prefix "${shortId}" — matches ${matches.length} incidents: ${ids}`)
  }

  return matches[0].incidentId
}
```

Fetches up to 500 incidents for prefix matching. If the target is older than the last 500 incidents, the user needs to provide the full UUID. Acceptable tradeoff for v1.

---

## Commands

### `src/commands/get.ts`

```typescript
import {createClient, resolveConfig, resolveIncidentId} from "../client"
import {formatIncidentDetail} from "../format"

const USAGE = `
Usage: bun run incidents get <id> [options]

Arguments:
  id              Incident ID (full UUID or first 8 chars)

Options:
  --json          Output raw JSON
  --help          Show this help
`.trim()

export async function getCommand(args: string[], flags: Record<string, string | boolean>) {
  if (flags.help) {
    console.log(USAGE)
    return
  }

  const shortId = args[0]
  if (!shortId) {
    console.error("Error: incident ID required.\n")
    console.log(USAGE)
    process.exit(1)
  }

  const client = createClient(resolveConfig())
  const fullId = await resolveIncidentId(client, shortId)

  // Fetch both metadata and logs (logs contain feedback, phoneState, severity)
  const [meta, logs] = await Promise.all([client.getIncident(fullId), client.getIncidentLogs(fullId)])

  if (flags.json) {
    console.log(JSON.stringify({incident: meta.data, logs: logs.data}, null, 2))
    return
  }

  console.log(formatIncidentDetail(meta.data, logs.data))
}
```

`get` fetches both metadata (MongoDB) and logs (R2) because the useful info is split across both. Metadata has `status`, `summary`, `userId`, timestamps. Logs have `feedback` (user's bug report text, severity rating, system info), `phoneState` (app state snapshot), and all the log arrays.

The two fetches run in parallel since they're independent.

### `src/commands/list.ts`

```typescript
import {createClient, resolveConfig, type IncidentMeta} from "../client"
import {formatIncidentTable} from "../format"

const USAGE = `
Usage: bun run incidents list [options]

Options:
  --limit <n>     Number of results (default: 20, max: 500)
  --user <email>  Filter by user email (client-side)
  --json          Output raw JSON
  --help          Show this help
`.trim()

export async function listCommand(_args: string[], flags: Record<string, string | boolean>) {
  if (flags.help) {
    console.log(USAGE)
    return
  }

  const limit = Math.min(parseInt(String(flags.limit || "20"), 10), 500)
  const userFilter = flags.user ? String(flags.user).toLowerCase() : null

  const client = createClient(resolveConfig())

  // If filtering by user, fetch max and filter client-side
  const fetchLimit = userFilter ? 500 : limit
  const res = await client.listIncidents(fetchLimit, 0)

  let incidents: IncidentMeta[] = res.data

  if (userFilter) {
    incidents = incidents.filter((i) => i.userId?.toLowerCase().includes(userFilter))
    incidents = incidents.slice(0, limit)
  }

  if (flags.json) {
    console.log(JSON.stringify(incidents, null, 2))
    return
  }

  if (incidents.length === 0) {
    console.log("No incidents found.")
    return
  }

  console.log(formatIncidentTable(incidents))
  console.log(`\n${incidents.length} incidents${res.pagination.hasMore ? ` (${res.pagination.total} total)` : ""}`)
}
```

`--user` is a client-side filter. When active, we fetch 500 (the API max) and filter locally. The API doesn't support `userId` filtering — that's a future enhancement (see spike.md "Future Enhancements").

### `src/commands/logs.ts`

```typescript
import {createClient, resolveConfig, resolveIncidentId, type LogEntry} from "../client"
import {formatLogLines} from "../format"

type LogType = "phone" | "cloud" | "glasses" | "firmware" | "apps" | "all"

const VALID_TYPES: LogType[] = ["phone", "cloud", "glasses", "firmware", "apps", "all"]
const VALID_LEVELS = ["error", "warn", "info", "debug"]

const USAGE = `
Usage: bun run incidents logs <id> [options]

Arguments:
  id                Incident ID (full UUID or first 8 chars)

Options:
  --type <type>     Log type: phone, cloud, glasses, firmware, apps, all (default: all)
  --app <package>   Filter app telemetry by package name
  --level <level>   Filter by minimum level: error, warn, info, debug
  --grep <pattern>  Search log messages (case-insensitive substring)
  --limit <n>       Max entries to display (default: 200)
  --json            Output raw JSON
  --help            Show this help
`.trim()

export async function logsCommand(args: string[], flags: Record<string, string | boolean>) {
  if (flags.help) {
    console.log(USAGE)
    return
  }

  const shortId = args[0]
  if (!shortId) {
    console.error("Error: incident ID required.\n")
    console.log(USAGE)
    process.exit(1)
  }

  const logType = String(flags.type || "all") as LogType
  if (!VALID_TYPES.includes(logType)) {
    console.error(`Error: invalid log type "${logType}". Valid: ${VALID_TYPES.join(", ")}`)
    process.exit(1)
  }

  const levelFilter = flags.level ? String(flags.level).toLowerCase() : null
  if (levelFilter && !VALID_LEVELS.includes(levelFilter)) {
    console.error(`Error: invalid level "${levelFilter}". Valid: ${VALID_LEVELS.join(", ")}`)
    process.exit(1)
  }

  const grepPattern = flags.grep ? String(flags.grep).toLowerCase() : null
  const appFilter = flags.app ? String(flags.app) : null
  const limit = parseInt(String(flags.limit || "200"), 10)

  const client = createClient(resolveConfig())
  const fullId = await resolveIncidentId(client, shortId)
  const res = await client.getIncidentLogs(fullId)
  const data = res.data

  // Collect logs based on --type
  let entries: Array<LogEntry & {_source: string}> = []

  if (logType === "all" || logType === "phone") {
    entries.push(...(data.phoneLogs || []).map((e) => ({...e, _source: "phone"})))
  }
  if (logType === "all" || logType === "cloud") {
    entries.push(...(data.cloudLogs || []).map((e) => ({...e, _source: "cloud"})))
  }
  if (logType === "all" || logType === "glasses") {
    entries.push(...(data.glassesLogs || []).map((e) => ({...e, _source: "glasses"})))
  }
  if (logType === "all" || logType === "firmware") {
    entries.push(...(data.glassesFirmwareLogs || []).map((e) => ({...e, _source: "firmware"})))
  }
  if (logType === "all" || logType === "apps") {
    for (const [pkg, logs] of Object.entries(data.appTelemetryLogs || {})) {
      if (appFilter && !pkg.includes(appFilter)) continue
      entries.push(...logs.map((e) => ({...e, _source: `app:${pkg}`})))
    }
  }

  // Sort by timestamp (ascending — oldest first)
  entries.sort((a, b) => {
    const ta = typeof a.timestamp === "number" ? a.timestamp : new Date(a.timestamp).getTime()
    const tb = typeof b.timestamp === "number" ? b.timestamp : new Date(b.timestamp).getTime()
    return ta - tb
  })

  // Apply filters
  if (levelFilter) {
    const levelPriority: Record<string, number> = {error: 0, warn: 1, info: 2, debug: 3}
    const minPriority = levelPriority[levelFilter] ?? 3
    entries = entries.filter((e) => (levelPriority[e.level?.toLowerCase()] ?? 3) <= minPriority)
  }

  if (grepPattern) {
    entries = entries.filter((e) => e.message?.toLowerCase().includes(grepPattern))
  }

  // Apply limit
  const truncated = entries.length > limit
  entries = entries.slice(0, limit)

  if (flags.json) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }

  if (entries.length === 0) {
    console.log("No log entries found matching filters.")
    return
  }

  console.log(formatLogLines(entries))

  if (truncated) {
    console.log(`\n... truncated at ${limit} entries. Use --limit to show more.`)
  }
}
```

### Level filtering logic

`--level warn` means "show warn and above" (i.e., warn + error). Uses a priority map where lower number = higher severity. Entries with a priority ≤ the requested level pass the filter.

### Timestamp handling

The `LogEntry.timestamp` field is inconsistent across log sources — sometimes a unix epoch (number), sometimes an ISO string. The sort normalizes both to milliseconds via `new Date().getTime()`.

---

## Output Formatting: `src/format.ts`

All terminal formatting in one file. Uses ANSI escape codes directly — no chalk dependency.

### ANSI color helpers

```typescript
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const CYAN = "\x1b[36m"
const GRAY = "\x1b[90m"
const WHITE = "\x1b[37m"

function c(color: string, text: string): string {
  return `${color}${text}${RESET}`
}
```

### `formatIncidentTable(incidents: IncidentMeta[]): string`

For `list` command. Fixed-width columns, truncated to terminal width.

```typescript
export function formatIncidentTable(incidents: IncidentMeta[]): string {
  const header = [pad("ID", 10), pad("Status", 12), pad("User", 28), pad("Summary", 40), pad("Created", 20)].join("  ")

  const separator = "-".repeat(header.length)

  const rows = incidents.map((i) => {
    const shortId = i.incidentId.slice(0, 8)
    const status = colorStatus(i.status)
    const user = pad(i.userId || "—", 28)
    const summary = pad(i.summary || "—", 40)
    const created = pad(formatTimestamp(i.createdAt), 20)
    return [pad(shortId, 10), pad(status, 12), user, summary, created].join("  ")
  })

  return [c(BOLD, header), separator, ...rows].join("\n")
}
```

Helper functions:

```typescript
function pad(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + "…"
  return str.padEnd(width)
}

function colorStatus(status: string): string {
  switch (status) {
    case "complete":
      return c(GREEN, status)
    case "processing":
      return c(YELLOW, status)
    case "failed":
      return c(RED, status)
    case "partial":
      return c(YELLOW, status)
    default:
      return status
  }
}

function formatTimestamp(ts: string | number): string {
  const d = new Date(ts)
  return d.toISOString().replace("T", " ").slice(0, 19)
}
```

### `formatIncidentDetail(meta: IncidentMeta, logs: IncidentLogs): string`

For `get` command. Multi-section display pulling from both metadata and R2 logs.

```typescript
export function formatIncidentDetail(meta: IncidentMeta, logs: IncidentLogs): string {
  const lines: string[] = []
  const feedback = logs.feedback || {}
  const phoneState = logs.phoneState || {}

  // Header
  lines.push(c(BOLD, `Incident ${meta.incidentId}`))
  lines.push("")

  // Status + timestamps
  lines.push(`${c(BOLD, "Status:")}       ${colorStatus(meta.status)}`)
  lines.push(`${c(BOLD, "Created:")}      ${formatTimestamp(meta.createdAt)}`)
  lines.push(`${c(BOLD, "Updated:")}      ${formatTimestamp(meta.updatedAt)}`)
  lines.push(`${c(BOLD, "User:")}         ${meta.userId || "—"}`)

  // LLM Summary
  if (meta.summary) {
    lines.push("")
    lines.push(c(BOLD, "Summary:"))
    lines.push(`  ${meta.summary}`)
  }

  // Feedback (user's bug report)
  if (Object.keys(feedback).length > 0) {
    lines.push("")
    lines.push(c(BOLD, "Feedback:"))

    if (feedback.expectedBehavior) lines.push(`  Expected: ${feedback.expectedBehavior}`)
    if (feedback.actualBehavior) lines.push(`  Actual:   ${feedback.actualBehavior}`)
    if (feedback.severityRating) lines.push(`  Severity: ${feedback.severityRating}/5`)
    if (feedback.additionalContext) lines.push(`  Context:  ${feedback.additionalContext}`)
  }

  // System info from feedback
  const sysInfo = (feedback.systemInfo || {}) as Record<string, unknown>
  if (Object.keys(sysInfo).length > 0) {
    lines.push("")
    lines.push(c(BOLD, "System Info:"))
    for (const [k, v] of Object.entries(sysInfo)) {
      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    }
  }

  // Phone state snapshot (summarized)
  if (Object.keys(phoneState).length > 0) {
    lines.push("")
    lines.push(c(BOLD, "Phone State:"))
    const keys = Object.keys(phoneState)
    for (const k of keys) {
      const val = phoneState[k]
      if (typeof val === "object" && val !== null) {
        lines.push(`  ${k}: ${JSON.stringify(val).slice(0, 120)}${JSON.stringify(val).length > 120 ? "…" : ""}`)
      } else {
        lines.push(`  ${k}: ${val}`)
      }
    }
  }

  // Log counts
  lines.push("")
  lines.push(c(BOLD, "Log Counts:"))
  lines.push(`  Phone:    ${(logs.phoneLogs || []).length}`)
  lines.push(`  Cloud:    ${(logs.cloudLogs || []).length}`)
  lines.push(`  Glasses:  ${(logs.glassesLogs || []).length}`)
  lines.push(`  Firmware: ${(logs.glassesFirmwareLogs || []).length}`)

  const appLogs = logs.appTelemetryLogs || {}
  const appKeys = Object.keys(appLogs)
  if (appKeys.length > 0) {
    lines.push(`  Apps:`)
    for (const pkg of appKeys) {
      lines.push(`    ${pkg}: ${appLogs[pkg].length}`)
    }
  }

  // Attachments
  if (logs.attachments && logs.attachments.length > 0) {
    lines.push("")
    lines.push(c(BOLD, `Attachments (${logs.attachments.length}):`))
    for (const att of logs.attachments) {
      lines.push(`  ${att.filename}`)
    }
  }

  return lines.join("\n")
}
```

### `formatLogLines(entries: Array<LogEntry & { _source: string }>): string`

For `logs` command. One line per log entry, color-coded by level.

```typescript
export function formatLogLines(entries: Array<LogEntry & {_source: string}>): string {
  return entries
    .map((e) => {
      const ts = c(GRAY, formatTimestamp(e.timestamp))
      const level = colorLevel(e.level || "info")
      const source = c(CYAN, `[${e._source}]`)
      const msg = e.message || ""
      return `${ts} ${level} ${source} ${msg}`
    })
    .join("\n")
}

function colorLevel(level: string): string {
  const l = level.toLowerCase()
  const padded = l.padEnd(5)
  switch (l) {
    case "error":
      return c(RED, padded)
    case "warn":
      return c(YELLOW, padded)
    case "info":
      return c(WHITE, padded)
    case "debug":
      return c(GRAY, padded)
    default:
      return c(DIM, padded)
  }
}
```

Output looks like:

```
2025-01-15 09:23:01 error [cloud]  WebSocket connection dropped for user@example.com
2025-01-15 09:23:01 warn  [phone]  Reconnection attempt 3/5
2025-01-15 09:23:02 info  [phone]  BLE reconnected to G1
2025-01-15 09:23:02 debug [cloud]  Session resumed, restoring subscriptions
```

---

## `.env.example` Change

Add to `cloud/.env.example`:

```
# Agent API key for incidents CLI (used by cloud/packages/incidents)
MENTRA_AGENT_API_KEY=
```

Just the placeholder. The actual key is set per-developer in `cloud/.env` (gitignored).

---

## Running the CLI

```bash
# Load env vars (assumes cloud/.env has MENTRA_AGENT_API_KEY set)
cd cloud/packages/incidents

# Direct execution
bun run src/cli.ts list
bun run src/cli.ts get c3f3e699
bun run src/cli.ts logs c3f3e699 --type phone --grep "disconnect"

# Via package.json script alias
bun run incidents list
bun run incidents get c3f3e699
bun run incidents logs c3f3e699 --type cloud --level error
```

For use from the repo root or other directories, the `MENTRA_AGENT_API_KEY` env var needs to be loaded. If using `dotenv`, source `cloud/.env` first. Alternatively, export it in your shell profile.

---

## Testing

### Manual verification against prod

No automated tests for v1 — this is a read-only CLI wrapping a stable API. Test manually:

| Test                  | Command                                                                  | Expected                                         |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| List incidents        | `bun run incidents list`                                                 | Table with recent incidents, short IDs, statuses |
| List with limit       | `bun run incidents list --limit 5`                                       | Exactly 5 rows                                   |
| List with user filter | `bun run incidents list --user someone@gmail.com`                        | Only incidents from that user                    |
| List JSON             | `bun run incidents list --json`                                          | Valid JSON array                                 |
| Get by short ID       | `bun run incidents get <first-8-chars>`                                  | Full incident detail display                     |
| Get by full UUID      | `bun run incidents get <full-uuid>`                                      | Same as above                                    |
| Get JSON              | `bun run incidents get <id> --json`                                      | Valid JSON object                                |
| Ambiguous short ID    | `bun run incidents get a`                                                | Error: "Ambiguous prefix"                        |
| Nonexistent ID        | `bun run incidents get 00000000`                                         | Error: "No incident found"                       |
| All logs              | `bun run incidents logs <id>`                                            | All log types, sorted by time                    |
| Phone logs only       | `bun run incidents logs <id> --type phone`                               | Only phone logs                                  |
| Level filter          | `bun run incidents logs <id> --level error`                              | Only error-level entries                         |
| Grep filter           | `bun run incidents logs <id> --grep "disconnect"`                        | Only matching messages                           |
| Combined filters      | `bun run incidents logs <id> --type cloud --level warn --grep "timeout"` | Intersection of all filters                      |
| Logs JSON             | `bun run incidents logs <id> --json`                                     | Valid JSON array of log entries                  |
| Missing API key       | `unset MENTRA_AGENT_API_KEY && bun run incidents list`                   | Clear error message                              |
| Invalid API key       | `MENTRA_AGENT_API_KEY=bad bun run incidents list`                        | API 401 error                                    |
| Custom host           | `MENTRA_API_HOST=http://localhost:3000 bun run incidents list`           | Hits local server                                |

### Edge cases

- Incident with no logs in R2 (status: `processing`) → `get` shows metadata, log counts all 0
- Incident with no feedback → `get` skips the Feedback section
- Empty `appTelemetryLogs` → `logs --type apps` shows "No log entries found"
- Very long log messages → not truncated (terminal wraps)
- Non-UTF8 in log messages → should pass through, Bun handles encoding

---

## Rollout

1. Create the package (`cloud/packages/incidents/`) with all files listed above
2. Add `MENTRA_AGENT_API_KEY` to `cloud/.env.example`
3. Test against prod with real incident IDs
4. Update `AGENTS.md` "Bug Report Logs" section to mention the new CLI as the preferred tool over `fetch-incident-logs.sh`
