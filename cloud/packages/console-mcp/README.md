# @mentra/console-mcp

MCP server for the **MentraOS Developer Console**. Exposes MiniApp management, organization tools, incident triage, and optional internal admin review to Cursor and other MCP clients.

This is separate from the [docs MCP](https://docs.mentraglass.com/mcp) (`mentraos-docs`), which only covers SDK documentation.

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- Credentials for the API surfaces you need (see below)

## Environment variables

| Variable | Required for | Description |
|----------|--------------|-------------|
| `MENTRA_API_HOST` | No | API base URL. Default: `https://api.mentra.glass`. Local dev: `http://localhost:8002` |
| `MENTRA_CLI_TOKEN` | App/org tools | CLI key from [Developer Console → CLI Keys](https://console.mentra.glass/cli-keys). Sent as `Authorization: Bearer …` to `/api/cli/*`. Create keys in the dashboard only — not via MCP. |
| `MENTRA_AGENT_API_KEY` | Incident tools | Agent API key (must match server `MENTRA_AGENT_API_KEY`). Sent as `X-Agent-Key` to `/api/agent/incidents` |
| `MENTRA_ADMIN_JWT` or `MENTRA_ADMIN_TOKEN` | Admin tools | Core/session JWT for a Mentra admin email (`@mentra.glass` / `ADMIN_EMAILS`). **Not** a CLI key |

Only tools whose credentials are configured are registered, plus `console_auth_status` (never prints secrets).

## Cursor configuration

Add to `~/.cursor/mcp.json` or project `.cursor/mcp.json`.

**Recommended:** use `scripts/run-mcp.sh`. It resolves Bun when Cursor spawns MCP with a minimal `PATH`, and can load `MENTRA_*` exports from `~/.zshrc` (without sourcing the whole file, which would break stdio JSON-RPC).

```json
{
  "mcpServers": {
    "mentra-console": {
      "command": "/absolute/path/to/MentraOS/cloud/packages/console-mcp/scripts/run-mcp.sh",
      "args": []
    }
  }
}
```

Or pass credentials explicitly in `env` (useful for CI or when keys are not in `~/.zshrc`):

```json
{
  "mcpServers": {
    "mentra-console": {
      "command": "/absolute/path/to/MentraOS/cloud/packages/console-mcp/scripts/run-mcp.sh",
      "args": [],
      "env": {
        "MENTRA_API_HOST": "https://api.mentra.glass",
        "MENTRA_CLI_TOKEN": "your-cli-key",
        "MENTRA_AGENT_API_KEY": "your-agent-key"
      }
    }
  }
}
```

For local cloud dev, set `MENTRA_API_HOST` to `http://localhost:8002` and ensure `MENTRA_AGENT_API_KEY` matches `cloud/.env`.

Restart Cursor after changing MCP config. In **Cursor Settings → MCP**, `mentra-console` should show as connected (not errored).

### Verify in Cursor

Ask the agent to call `console_auth_status`. You should see your API host and which capability groups are enabled (`developer`, `incidents`, `admin`) — never secrets.

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| MCP server **errored** / `bun: not found` | Use `run-mcp.sh` (not bare `bun`), or set `"env": { "BUN": "/Users/you/.bun/bin/bun" }` |
| Only `console_auth_status` + incident tools | Set `MENTRA_AGENT_API_KEY` for incidents; `MENTRA_CLI_TOKEN` for app/org tools |
| Incident tools return 401 | Key must match server `MENTRA_AGENT_API_KEY` (see `cloud/.env` locally) |
| `run-mcp.sh` loads nothing from shell | Keys must be `export MENTRA_AGENT_API_KEY=...` lines in `~/.zshrc` |

## Run locally

```bash
cd cloud/packages/console-mcp
export MENTRA_CLI_TOKEN=...
bun run start
```

## Tools (by capability)

### Developer (`MENTRA_CLI_TOKEN`)

- **Apps:** `app_list`, `app_get`, `app_create`, `app_update`, `app_delete` (needs `confirm: true`), `app_publish`, `app_regenerate_api_key`, `app_move_org`
- **Orgs:** `org_list`, `org_get`, `org_create`, `org_update`, `org_delete`, `org_invite_member`, `org_change_member_role`, `org_remove_member`, `org_resend_invite`, `org_rescind_invite`, `org_accept_invite`

`app_create` only accepts fields allowed by the backend: `packageName`, `name`, `description`, `publicUrl`, `appType`, `tools`, `permissions`, `settings`, `hardwareRequirements`, `onboardingInstructions`, `orgId`.

### Incidents (`MENTRA_AGENT_API_KEY`)

- `incident_list`, `incident_get`, `incident_get_logs` (bounded output, default 200 lines; supports `logType`, `grep`, `level`, short UUID prefixes)

### Admin (`MENTRA_ADMIN_JWT`)

- `admin_check`, `admin_app_stats`, `admin_apps_submitted`, `admin_app_get`, `admin_app_approve`, `admin_app_reject` (requires non-empty `notes`)

## Resources and prompts

- Resources: `mentra://apps`, `mentra://apps/{packageName}`, `mentra://incidents/recent`, `mentra://incidents/{incidentId}/summary`
- Prompts: `debug-incident`, `create-miniapp-checklist`, `review-submission`

## Tests

**Unit tests** (no API):

```bash
cd cloud/packages/console-mcp
bun test
```

**Integration smoke test** (hits live API; needs credentials):

```bash
cd cloud/packages/console-mcp
export MENTRA_API_HOST=https://api.mentra.glass   # or http://localhost:8002
export MENTRA_AGENT_API_KEY=...                   # must match cloud/.env when local
export MENTRA_CLI_TOKEN=...                       # optional, for app/org checks

bun run smoke
```

Smoke test prints capability detection, API reachability, and skips groups whose env vars are unset.

**Manual stdio check** (optional):

```bash
cd cloud/packages/console-mcp
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"console_auth_status","arguments":{}}}' \
  | bash scripts/run-mcp.sh
```

The last JSON line should be a `console_auth_status` result with `host` and `capabilities`.
