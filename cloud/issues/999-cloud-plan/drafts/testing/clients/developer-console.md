# Developer Console

## Overview

The Developer Console is a React SPA served at `console.mentra.glass`. It is the primary interface for developers to manage their apps, organizations, and CLI keys. All interactions go through REST endpoints under the `/api/console/*` namespace.

## Transport

| Transport | Endpoint Prefix  | Purpose                |
| --------- | ---------------- | ---------------------- |
| REST      | `/api/console/*` | All console operations |

The console uses REST exclusively - there is no WebSocket or UDP transport.

## Auth

Authentication uses a Console JWT, signed and verified with the `CONSOLE_AUTH_JWT_SECRET` environment variable. The JWT is issued after the developer logs in through the console's auth flow and is sent as a Bearer token on all requests.

All endpoints require a valid Console JWT unless otherwise noted.

## Operations

### Account

| Method | Endpoint               | Purpose             | Auth Required |
| ------ | ---------------------- | ------------------- | ------------- |
| GET    | `/api/console/account` | Get current account | Yes           |

### Apps CRUD

| Method | Endpoint                         | Purpose                   | Auth Required |
| ------ | -------------------------------- | ------------------------- | ------------- |
| GET    | `/api/console/apps`              | List all apps for account | Yes           |
| POST   | `/api/console/apps`              | Create a new app          | Yes           |
| GET    | `/api/console/apps/:packageName` | Get app details           | Yes           |
| PUT    | `/api/console/apps/:packageName` | Update app configuration  | Yes           |
| DELETE | `/api/console/apps/:packageName` | Delete an app             | Yes           |

### App Actions

| Method | Endpoint                                 | Purpose                     | Auth Required |
| ------ | ---------------------------------------- | --------------------------- | ------------- |
| POST   | `/api/console/apps/:packageName/publish` | Publish app to the store    | Yes           |
| POST   | `/api/console/apps/:packageName/api-key` | Generate or rotate API key  | Yes           |
| POST   | `/api/console/apps/:packageName/move`    | Move app to a different org | Yes           |

### Organizations

| Method | Endpoint                   | Purpose                   | Auth Required |
| ------ | -------------------------- | ------------------------- | ------------- |
| GET    | `/api/console/orgs`        | List all orgs for account | Yes           |
| POST   | `/api/console/orgs`        | Create a new org          | Yes           |
| GET    | `/api/console/orgs/:orgId` | Get org details           | Yes           |
| PUT    | `/api/console/orgs/:orgId` | Update org settings       | Yes           |
| DELETE | `/api/console/orgs/:orgId` | Delete an org             | Yes           |

### Org Members

| Method | Endpoint                                     | Purpose             | Auth Required |
| ------ | -------------------------------------------- | ------------------- | ------------- |
| POST   | `/api/console/orgs/:orgId/members`           | Invite a new member | Yes           |
| PATCH  | `/api/console/orgs/:orgId/members/:memberId` | Update member role  | Yes           |
| DELETE | `/api/console/orgs/:orgId/members/:memberId` | Remove a member     | Yes           |

### Invites

| Action  | Purpose                           | Auth Required |
| ------- | --------------------------------- | ------------- |
| Resend  | Resend a pending invitation email | Yes           |
| Rescind | Cancel a pending invitation       | Yes           |

### CLI Keys

| Method | Endpoint                       | Purpose                      | Auth Required |
| ------ | ------------------------------ | ---------------------------- | ------------- |
| GET    | `/api/console/cli-keys`        | List all CLI keys            | Yes           |
| POST   | `/api/console/cli-keys`        | Create a new CLI key         | Yes           |
| GET    | `/api/console/cli-keys/:keyId` | Get CLI key details          | Yes           |
| PATCH  | `/api/console/cli-keys/:keyId` | Update CLI key (e.g. rename) | Yes           |
| DELETE | `/api/console/cli-keys/:keyId` | Revoke a CLI key             | Yes           |

### Admin (Admin Only)

| Method | Endpoint                           | Purpose               | Auth Required    |
| ------ | ---------------------------------- | --------------------- | ---------------- |
| GET    | `/api/console/admin/incidents`     | List all incidents    | Yes (admin only) |
| GET    | `/api/console/admin/incidents/:id` | View incident details | Yes (admin only) |

Admin endpoints require the Console JWT to belong to an account whose email is in the `ADMIN_EMAILS` whitelist.

## Key Flows

### Create and Publish an App

1. Developer logs in to `console.mentra.glass` and obtains a Console JWT
2. `POST /api/console/apps` - create the app with package name, metadata, and configuration
3. Developer configures the app (manifest, tools, permissions) via `PUT /api/console/apps/:packageName`
4. `POST /api/console/apps/:packageName/publish` - submit the app for publication to the store

### Create an Organization and Invite Members

1. `POST /api/console/orgs` - create a new org with a name
2. `POST /api/console/orgs/:orgId/members` - invite members by email
3. Members receive an invitation email and accept via the console
4. `POST /api/console/apps/:packageName/move` - optionally move existing apps into the org

### Generate a CLI Key

1. `POST /api/console/cli-keys` - create a new CLI key with a descriptive name
2. Copy the generated token (shown only once)
3. Use in the CLI via `mentra auth <token>` or set as `MENTRA_CLI_TOKEN` for CI/CD

## Failure Modes

| Failure                      | Current Behavior                                   | Target Behavior                                       |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Console JWT expired          | 401 on next request; user must re-login            | Auto-refresh or prompt re-login with state preserved  |
| Publish with missing fields  | 400 with validation errors                         | Same - clear error messages surfaced in the UI        |
| Delete app while running     | App deleted; running sessions may become orphaned  | Graceful shutdown of running sessions before delete   |
| Delete org with active apps  | Blocked or cascading delete depending on config    | Clear warning with confirmation; cascade if confirmed |
| API key rotation             | Old key invalidated immediately                    | Grace period or confirmation to avoid breaking CI/CD  |
| Network timeout on publish   | Silent failure; developer unsure if publish worked | Retry with idempotency; clear success/failure status  |
| Admin endpoint without admin | 403 Forbidden                                      | Same - no information leakage about admin routes      |
| Concurrent edits to same app | Last write wins; no conflict detection             | Optimistic locking or conflict detection              |
