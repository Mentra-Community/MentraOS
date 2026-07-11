# @mentra/console-mcp

MCP server for **MentraOS Cloud V2 report triage**. Exposes the admin reports API (bug reports, feedback, automatic reports filed from the Mentra App) to Cursor and other MCP clients.

This replaces the incident tools of the legacy server at `cloud/packages/console-mcp`, which targeted the V1 `/api/agent/incidents` API (`X-Agent-Key`). The `cloud/` tree is frozen; V1 incidents are superseded by Cloud V2 reports. The legacy server's V1 app/org/admin tools remain there until `cloud/` is removed.

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- An admin bearer token (see below)
- A core deployment that serves `/api/admin/reports` (the admin report triage API)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MENTRA_ADMIN_TOKEN` | Yes (for report tools) | Bearer token for the admin API: an org API key (`msk_...`) whose synthetic email `api-key@{keyId}.local` is allowlisted via `CLOUD_CORE_ADMIN_EMAILS`, or a WorkOS access token of an admin user |
| `MENTRA_CORE_URL` | No | Core API base URL; overrides `MENTRA_ENV`. Local dev: `http://localhost:3000` |
| `MENTRA_ENV` | No | `prod` (default) \| `staging` \| `dev` — picks the matching core deployment |

Core hosts: prod `https://core.mentraglass.com`, staging `https://core.staging.us-west-2.mentraglass.com`, dev `https://core.dev.us-west-2.mentraglass.com`.

**Note:** `msk_` API keys are env-pinned — a key minted for prod will not authenticate against staging or dev. Match the key to `MENTRA_ENV`/`MENTRA_CORE_URL`.

Only tools whose credentials are configured are registered, plus `console_auth_status` (never prints secrets).

## Cursor configuration

Add to `~/.cursor/mcp.json` or project `.cursor/mcp.json`.

**Recommended:** use `scripts/run-mcp.sh`. It resolves Bun when Cursor spawns MCP with a minimal `PATH`, and can load `MENTRA_*` exports from `~/.zshrc` (without sourcing the whole file, which would break stdio JSON-RPC).

```json
{
  "mcpServers": {
    "mentra-console": {
      "command": "/absolute/path/to/MentraOS/cloud-v2/packages/console-mcp/scripts/run-mcp.sh",
      "args": []
    }
  }
}
```

Or pass credentials explicitly in `env`:

```json
{
  "mcpServers": {
    "mentra-console": {
      "command": "/absolute/path/to/MentraOS/cloud-v2/packages/console-mcp/scripts/run-mcp.sh",
      "args": [],
      "env": {
        "MENTRA_ENV": "prod",
        "MENTRA_ADMIN_TOKEN": "msk_..."
      }
    }
  }
}
```

Restart Cursor after changing MCP config, then ask the agent to call `console_auth_status` (add `verify: true` to confirm the token against `/api/admin/me`).

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| MCP server **errored** / `bun: not found` | Use `run-mcp.sh` (not bare `bun`), or set `"env": { "BUN": "/Users/you/.bun/bin/bun" }` |
| Only `console_auth_status` registered | Set `MENTRA_ADMIN_TOKEN` |
| 401 unauthorized | Token rejected — check the key isn't revoked and matches the environment (`msk_` keys are env-pinned) |
| 403 forbidden | Token is valid but its email isn't in `CLOUD_CORE_ADMIN_EMAILS` (for `msk_` keys, allowlist `api-key@{keyId}.local`) |
| 404 on every report | Wrong id — or this core deployment doesn't serve the admin reports API yet |

## Run locally

```bash
cd cloud-v2/packages/console-mcp
export MENTRA_ADMIN_TOKEN=msk_...
bun run start
```

## Tools

- `report_list` — recent reports, newest first; filters: `kind` (bug/feedback/automatic), `status` (collecting/ready/closed), `limit`, `before` (ISO timestamp, for paging), `userId` (client-side); `full: true` for raw documents
- `report_get` — one report by full `rep_...` id or short prefix: report document, diagnostic context (`includeContext: false` to omit), and artifact/asset metadata
- `report_get_logs` — merged log bundles across the report's `logs` artifacts (bounded output, default 200 lines; `source`, `level`, `grep`, `limit`, `json` filters)
- `report_get_artifact` — one artifact payload by `art_...` id: screenshots inline as images, JSON/text inline as text, binaries/oversized payloads as a ready-to-run `curl` command
- `console_auth_status` — host + capability status; `verify: true` calls `/api/admin/me`

Report ids look like `rep_01ARZ...` (ULID) and appear in reports Slack notifications and the admin console. Short prefixes are resolved against the most recent ~600 reports.

## Resources and prompts

- Resources: `mentra://reports/recent`, `mentra://reports/{reportId}/summary`
- Prompt: `debug-report`

## Tests

**Unit tests** (no API):

```bash
cd cloud-v2/packages/console-mcp
bun test
```

**Integration smoke test** (hits a live core; needs credentials):

```bash
cd cloud-v2/packages/console-mcp
export MENTRA_ADMIN_TOKEN=msk_...
export MENTRA_ENV=dev            # or MENTRA_CORE_URL=http://localhost:3000
bun run smoke
```

**Manual stdio check** (optional):

```bash
cd cloud-v2/packages/console-mcp
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"console_auth_status","arguments":{}}}' \
  | bash scripts/run-mcp.sh
```

The last JSON line should be a `console_auth_status` result with `coreUrl` and `capabilities`.
