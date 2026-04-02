# @mentra/incidents

CLI tool for browsing incidents and fetching logs from the Mentra agent API.

## Setup

Set your API key in the environment:

```bash
export MENTRA_AGENT_API_KEY=your-api-key
```

Optionally override the API host (defaults to `https://api.mentra.glass`):

```bash
export MENTRA_API_HOST=http://localhost:3000
```

## Usage

```bash
cd cloud/packages/incidents

# List recent incidents
bun run incidents list
bun run incidents list --limit 5
bun run incidents list --user someone@gmail.com
bun run incidents list --json

# Get incident details (full UUID or first 8 chars)
bun run incidents get c3f3e699
bun run incidents get 550e8400-e29b-41d4-a716-446655440000
bun run incidents get c3f3e699 --json

# Fetch incident logs
bun run incidents logs c3f3e699
bun run incidents logs c3f3e699 --type phone
bun run incidents logs c3f3e699 --type cloud --level error
bun run incidents logs c3f3e699 --grep "disconnect"
bun run incidents logs c3f3e699 --type apps --app com.example.myapp
bun run incidents logs c3f3e699 --json
```

## Commands

### `list`

List recent incidents in a table format.

| Flag             | Description                               |
| ---------------- | ----------------------------------------- |
| `--limit <n>`    | Number of results (default: 20, max: 500) |
| `--user <email>` | Filter by user email (client-side)        |
| `--json`         | Output raw JSON                           |

### `get <id>`

Show full incident details including feedback, system info, phone state, and log counts.

| Flag     | Description     |
| -------- | --------------- |
| `--json` | Output raw JSON |

### `logs <id>`

Fetch and display incident logs, sorted chronologically.

| Flag               | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `--type <type>`    | Log type: phone, cloud, glasses, firmware, apps, all (default: all) |
| `--app <package>`  | Filter app telemetry by package name                                |
| `--level <level>`  | Minimum level: error, warn, info, debug                             |
| `--grep <pattern>` | Case-insensitive substring search on messages                       |
| `--limit <n>`      | Max entries to display (default: 200)                               |
| `--json`           | Output raw JSON                                                     |

## Short IDs

You can use the first 8 characters of an incident UUID instead of the full ID. The CLI will resolve it by searching recent incidents. If the prefix is ambiguous (matches multiple incidents), you'll be asked to provide more characters.

## Environment Variables

| Variable               | Required | Description                                             |
| ---------------------- | -------- | ------------------------------------------------------- |
| `MENTRA_AGENT_API_KEY` | Yes      | Agent API key for authentication                        |
| `MENTRA_API_HOST`      | No       | API host override (default: `https://api.mentra.glass`) |
