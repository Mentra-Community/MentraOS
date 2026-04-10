# CLI Client (`@mentra/cli`)

## Overview

The Mentra CLI is an npm package (`@mentra/cli`) that provides command-line access to cloud operations for app management, organization management, and publishing. It is designed for developer workflows and CI/CD pipelines.

The CLI endpoints mirror the console endpoints. The cloud uses the same handlers (`consoleAppsApi`, `consoleOrgsApi`) with a `transformCLIToConsole` middleware that maps CLI auth context to console auth context. This means the CLI and Developer Console share identical backend logic - the CLI is effectively a terminal interface to the same API surface.

## Transport

| Transport | Endpoint Prefix | Purpose                        |
| --------- | --------------- | ------------------------------ |
| REST      | `/api/cli/*`    | All CLI-to-cloud communication |

The CLI uses REST exclusively. There are no WebSocket or UDP transports.

## Auth

| Mechanism      | Details                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| Token type     | CLI JWT with DB revocation check                                           |
| Token source   | `mentra auth <token>` - user pastes token from Developer Console           |
| Token storage  | OS keychain (via `keytar` or platform equivalent)                          |
| CI/CD override | `MENTRA_CLI_TOKEN` environment variable                                    |
| Revocation     | Server-side DB check on every request (tokens can be revoked from Console) |

**Auth flow:**

1. User runs `mentra auth <token>` with a CLI key generated from the Developer Console
2. Token is validated against the cloud and stored in the OS keychain
3. All subsequent commands include the token as a Bearer header
4. The `transformCLIToConsole` middleware maps the CLI auth context to a console auth context before passing to shared handlers

## Operations

### App Management

| Command                    | Method(s)        | Endpoint(s)                   | Notes                             |
| -------------------------- | ---------------- | ----------------------------- | --------------------------------- |
| `mentra app list`          | GET              | `/api/cli/apps`               | Lists all apps for the user       |
| `mentra app get <pkg>`     | GET              | `/api/cli/apps/{pkg}`         | Get app details                   |
| `mentra app create`        | POST             | `/api/cli/apps`               | Create a new app                  |
| `mentra app update <pkg>`  | GET, then PUT    | `/api/cli/apps/{pkg}`         | Fetches current, then updates     |
| `mentra app delete <pkg>`  | GET, then DELETE | `/api/cli/apps/{pkg}`         | Confirms app exists, then deletes |
| `mentra app publish <pkg>` | GET, then POST   | `/api/cli/apps/{pkg}/publish` | Validates app, then publishes     |
| `mentra app api-key <pkg>` | GET, then POST   | `/api/cli/apps/{pkg}/api-key` | Validates app, then generates key |
| `mentra app export <pkg>`  | GET              | `/api/cli/apps/{pkg}`         | Reuses app get endpoint           |
| `mentra app import <file>` | POST             | `/api/cli/apps`               | Reuses app create endpoint        |

Several commands (update, delete, publish, api-key) perform a GET before their primary operation. This pre-fetch confirms the app exists and belongs to the user before attempting the mutation.

### Organization Management

| Command                  | Method | Endpoint(s)          | Notes                                |
| ------------------------ | ------ | -------------------- | ------------------------------------ |
| `mentra org list`        | GET    | `/api/cli/orgs`      | Lists all orgs for the user          |
| `mentra org get [id]`    | GET    | `/api/cli/orgs/{id}` | Get org details                      |
| `mentra org switch <id>` | GET    | `/api/cli/orgs/{id}` | Verify org access only (no mutation) |

### Local-Only Commands (No Cloud Calls)

| Command                     | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `mentra auth <token>`       | Store CLI token in OS keychain             |
| `mentra logout`             | Remove stored token from keychain          |
| `mentra whoami`             | Display current auth identity (from token) |
| `mentra cloud list`         | List configured cloud environments         |
| `mentra cloud current`      | Show active cloud environment              |
| `mentra cloud use <env>`    | Switch active cloud environment            |
| `mentra cloud add <url>`    | Add a custom cloud environment             |
| `mentra cloud remove <env>` | Remove a cloud environment                 |

These commands operate entirely on local state (keychain, config files) and never contact the cloud.

## Unique Endpoints

The CLI uses 6 unique REST endpoint paths:

1. `GET /api/cli/apps` - list apps
2. `GET/POST /api/cli/apps/{pkg}` - get app (also PUT, DELETE for update and delete)
3. `POST /api/cli/apps` - create app
4. `POST /api/cli/apps/{pkg}/publish` - publish app
5. `POST /api/cli/apps/{pkg}/api-key` - generate API key
6. `GET /api/cli/orgs` and `GET /api/cli/orgs/{id}` - org listing and details

All of these map to the same console handlers via `transformCLIToConsole`.

## Key Flows

### 1. Developer Auth Flow

```
Developer Console -> Generate CLI Key -> Copy token
Terminal: `mentra auth <token>` -> Cloud validates -> Token stored in OS keychain
```

### 2. App Development Flow

```
mentra app create -> develop locally -> mentra app update <pkg> -> mentra app publish <pkg>
```

### 3. CI/CD Flow

```
Set MENTRA_CLI_TOKEN env var -> mentra app publish <pkg> (no interactive auth needed)
```

## Failure Modes

| Failure                       | Current Behavior                           | Target Behavior                                  |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Token expired or revoked      | 401 error, unclear message                 | Clear message: "Token revoked, re-auth required" |
| Token not found (no auth)     | Generic error                              | Prompt user to run `mentra auth <token>`         |
| Keychain access denied        | Crash or unclear error                     | Graceful fallback with clear permission message  |
| Network unreachable           | Unhandled fetch error                      | Retry with backoff; clear offline message        |
| App not found (GET pre-fetch) | 404 passed through                         | Clear message: "App {pkg} not found"             |
| Publish validation fails      | Error response from cloud                  | Display validation errors in readable format     |
| Rate limited                  | 429 error                                  | Retry with backoff; display wait time            |
| Cloud server error (5xx)      | Raw error displayed                        | Friendly message with retry suggestion           |
| CI/CD token missing           | Falls through to keychain (may fail in CI) | Clear error: "Set MENTRA_CLI_TOKEN for CI usage" |
| Org switch to invalid org     | GET returns 404 or 403                     | Clear message: "Org not found or no access"      |

## Notes

- The `transformCLIToConsole` middleware is a key architectural detail - it means CLI and Console share the same test coverage for backend logic. Testing the CLI transport layer is mostly about verifying the middleware mapping and auth handling.
- The two-step commands (GET then mutate) introduce a minor TOCTOU (time-of-check-time-of-use) window, but this is acceptable for developer tooling where concurrent edits are rare.
- Local-only commands should be tested independently of cloud availability since they never make network requests.
- The `MENTRA_CLI_TOKEN` env var takes precedence over keychain storage, enabling headless CI/CD usage without interactive auth.
