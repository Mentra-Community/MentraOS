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
| `MENTRA_CLI_TOKEN` | App/org/CLI-key tools | CLI key from [Developer Console → CLI Keys](https://console.mentra.glass/cli-keys). Sent as `Authorization: Bearer …` to `/api/cli/*` |
| `MENTRA_AGENT_API_KEY` | Incident tools | Agent API key (must match server `MENTRA_AGENT_API_KEY`). Sent as `X-Agent-Key` to `/api/agent/incidents` |
| `MENTRA_ADMIN_JWT` or `MENTRA_ADMIN_TOKEN` | Admin tools | Core/session JWT for a Mentra admin email (`@mentra.glass` / `ADMIN_EMAILS`). **Not** a CLI key |

Only tools whose credentials are configured are registered, plus `console_auth_status` (never prints secrets).

## Cursor configuration

Add to `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mentra-console": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/MentraOS/cloud/packages/console-mcp/src/index.ts"],
      "env": {
        "MENTRA_API_HOST": "https://api.mentra.glass",
        "MENTRA_CLI_TOKEN": "your-cli-key",
        "MENTRA_AGENT_API_KEY": "your-agent-key"
      }
    }
  }
}
```

Restart Cursor after changing MCP config.

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
- **CLI keys:** `cli_key_list`, `cli_key_create`, `cli_key_get`, `cli_key_update`, `cli_key_revoke` (needs `confirm: true`)

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
bun test test/
```

**Integration smoke test** (needs running cloud + credentials):

```bash
# Local
export MENTRA_API_HOST=http://localhost:8002
export MENTRA_CLI_TOKEN=...
export MENTRA_AGENT_API_KEY=...   # must match cloud/.env

bun run smoke
```

Or use `scripts/run-mcp.sh` in Cursor config to load vars from `~/.zshrc` automatically.

## Backend note

CLI key routes are mounted at `/api/cli/cli-keys` (same handlers as `/api/console/cli-keys`) so MCP/CLI can manage keys without browser session auth.
