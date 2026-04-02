# Spec: Incidents CLI

## Overview

**What this doc covers:** Specification for a CLI tool that lets engineers and coding agents browse incidents and fetch logs from the command line, wrapping the existing agent API.
**Why this doc exists:** Investigating bug reports currently requires the web console (slow, manual, unusable by agents) or a bash script that only fetches logs by ID. There's no way to list incidents, filter logs by type/level, or search log text from the terminal. This blocks agent-assisted debugging workflows.
**What you need to know first:** [spike.md](./spike.md) — covers the full incident system architecture, storage layers, and API surfaces.
**Who should read this:** Cloud engineers, anyone building tooling for incident triage, anyone setting up the CLI for the first time.

## The Problem in 30 Seconds

Today's debugging flow for a bug report:

1. Open `console.mentra.glass/admin/incidents/{id}` in a browser, or
2. Run `./scripts/fetch-incident-logs.sh {id}` which dumps raw JSON to stdout

Neither works well for agents. The web console can't be used programmatically. The bash script has no listing, no filtering, no formatting — just a raw JSON blob. When an agent needs to investigate an incident (like issues 051 and 052), a human has to manually paste logs into the conversation.

The CLI gives agents and engineers three commands: find an incident (`list`), inspect it (`get`), and read its logs (`logs`) — with filtering, formatting, and grep built in.

## Spec

### Scope: zero API changes

The CLI wraps the three existing agent API endpoints:

| Endpoint                            | CLI command |
| ----------------------------------- | ----------- |
| `GET /api/agent/incidents`          | `list`      |
| `GET /api/agent/incidents/:id`      | `get`       |
| `GET /api/agent/incidents/:id/logs` | `logs`      |

All filtering (by user, log type, log level, grep) happens **client-side** in the CLI. The API returns full payloads; the CLI narrows them down. Not efficient at scale, but incident volume is low enough that this is fine today. API-side filtering is a separate future issue.

### Auth

| Variable               | Required | Default                    | Purpose                                 |
| ---------------------- | -------- | -------------------------- | --------------------------------------- |
| `MENTRA_AGENT_API_KEY` | Yes      | —                          | Sent as `X-Agent-Key` header            |
| `MENTRA_API_HOST`      | No       | `https://api.mentra.glass` | API base URL (override for dev/staging) |

The key lives in `cloud/.env` (gitignored). The CLI fails immediately with a clear error if the key is missing. The key is never logged or included in output.

### Package location

`cloud/packages/incidents/` — separate package, not part of the cloud server. It's a client tool with its own `package.json` and zero server dependencies.

### Running

```
cd cloud/packages/incidents
bun run src/cli.ts <command> [options]
```

### Command: `get <id>`

Show incident details: feedback text, severity, system info, phone state, LLM summary, timestamps.

```
bun run src/cli.ts get c3f3e699
bun run src/cli.ts get c3f3e699-43fa-45e2-a6d3-09c64ab64980

Options:
  --json    Output raw JSON instead of formatted display
```

**ID resolution:** Accepts a full UUID or a short prefix (first 8 characters). On short prefix: fetches the incident list and finds the first match where `incidentId` starts with the given prefix. If zero or multiple matches, error with a clear message.

**Formatted output includes:**

- Incident ID (full), status, created/updated timestamps
- LLM summary (title + description)
- User feedback: expected behavior, actual behavior, severity rating
- System info: app version, platform, device, OS, glasses connection status, network type
- Phone state snapshot: running apps, glasses info, core state

### Command: `logs <id>`

Fetch and display logs for an incident, filtered by type and content.

```
bun run src/cli.ts logs c3f3e699 --type phone
bun run src/cli.ts logs c3f3e699 --type cloud --level error
bun run src/cli.ts logs c3f3e699 --grep "disconnect"

Options:
  --type <type>       Log type: phone, cloud, glasses, firmware, apps, all (default: all)
  --app <package>     Filter app telemetry by package name (only with --type apps)
  --level <level>     Filter by log level: error, warn, info, debug
  --grep <pattern>    Search log messages (case-insensitive substring match)
  --limit <n>         Max log entries to display (default: 200)
  --json              Output raw JSON instead of formatted log lines
```

**ID resolution:** Same short-prefix behavior as `get`.

**Log types map to R2 fields:**

| `--type` value | R2 field(s)                              |
| -------------- | ---------------------------------------- |
| `phone`        | `phoneLogs`                              |
| `cloud`        | `cloudLogs`                              |
| `glasses`      | `glassesLogs`                            |
| `firmware`     | `glassesFirmwareLogs`                    |
| `apps`         | `appTelemetryLogs` (all packages)        |
| `all`          | All of the above, merged chronologically |

**Formatted output:** One line per log entry, color-coded by level:

```
[2025-01-15 10:23:45.123] [ERROR] [phone] Connection lost to glasses
[2025-01-15 10:23:45.456] [WARN]  [cloud] WebSocket heartbeat missed for user@email.com
[2025-01-15 10:23:46.789] [INFO]  [phone] Attempting BLE reconnect...
[2025-01-15 10:23:47.012] [DEBUG] [cloud] Audio buffer flushed (1600 bytes)
```

Colors: red = error, yellow = warn, white = info, gray = debug.

**Filtering order:** type → app → level → grep → limit. All filters are AND'd.

### Command: `list`

List recent incidents. Secondary command — for when you don't have an ID and need to find one.

```
bun run src/cli.ts list
bun run src/cli.ts list --limit 50
bun run src/cli.ts list --user johndoe@gmail.com

Options:
  --limit <n>         Number of results (default: 20, max: 500)
  --user <email>      Filter by user email (client-side filter on userId field)
  --json              Output raw JSON instead of table
```

**Table output:**

```
ID        Status    Summary                              User                    Created
c3f3e699  complete  BLE disconnect during transcription   johndoe@gmail.com       2025-01-15 10:23
a1b2c3d4  complete  AI not responding after app switch    jane@example.com        2025-01-15 09:45
f9e8d7c6  partial   Camera freeze on photo capture        test@mentra.glass       2025-01-14 18:30
```

ID column shows first 8 characters (the short prefix usable with `get` and `logs`).

**`--user` filtering:** Client-side. Fetches the full list from the API, then filters where `userId` matches the given email. The API's `limit` param is set high enough to cover the requested output limit after filtering.

### Error handling

| Scenario                       | Behavior                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Missing `MENTRA_AGENT_API_KEY` | Exit 1, print: `Error: MENTRA_AGENT_API_KEY not set`                            |
| API returns 401                | Exit 1, print: `Error: Invalid API key`                                         |
| API returns 404                | Exit 1, print: `Error: Incident not found: {id}`                                |
| API returns 5xx                | Exit 1, print: `Error: API error ({status}): {message}`                         |
| Network failure                | Exit 1, print: `Error: Cannot reach {host}: {error}`                            |
| Short prefix matches 0         | Exit 1, print: `Error: No incident found matching '{prefix}'`                   |
| Short prefix matches 2+        | Exit 1, print: `Error: Ambiguous prefix '{prefix}', matches: {id1}, {id2}, ...` |
| Unknown command                | Exit 1, print usage help                                                        |
| No command given               | Exit 0, print usage help                                                        |

## Decision Log

| Decision                                        | Alternatives considered                        | Why we chose this                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate package at `cloud/packages/incidents/` | Add to cloud server package; standalone repo   | It's a client tool, not a server component. Putting it in the cloud package would add CLI deps to the server. A separate repo would complicate monorepo workflows. `cloud/packages/` is where shared tooling lives.                                        |
| Bun + TypeScript, not bash                      | Extend `fetch-incident-logs.sh`; Python script | Bash can't reasonably do table formatting, colored output, JSON filtering, or short-prefix ID matching. The rest of the cloud monorepo is TypeScript/Bun — consistent tooling, shared `tsconfig` conventions, no new runtime.                              |
| Client-side filtering, no API changes           | Add query params to agent API                  | Incident volume is low (~tens per day). Fetching a full list and filtering locally is fast enough. API changes require cloud deployment, DB index changes (severity isn't in MongoDB), and coordination. The CLI ships immediately with zero backend work. |
| `process.argv` parsing, no CLI framework        | yargs, commander, clipanion                    | Three commands, ~6 flags each. A CLI framework adds a dependency for something achievable in ~40 lines of argument parsing. If we add 10+ commands later, revisit.                                                                                         |
| ANSI codes directly, no chalk                   | chalk, kleur, picocolors                       | We need exactly 4 colors (red, yellow, white, gray) and bold. That's 8 ANSI escape sequences. A color library is overkill.                                                                                                                                 |
| Short prefix = first 8 chars of UUID            | Full UUID only; fuzzy search                   | UUIDs are hex — 8 chars gives 4 billion possible values, collision in a dataset of hundreds is effectively impossible. Typing 8 chars vs 36 is the difference between usable and annoying.                                                                 |
