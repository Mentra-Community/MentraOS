# Hono Refactor Route Audit

Route mismatches found between Express and Hono implementations during migration.

## Quick Context

**Problem**: Hono refactor introduced breaking changes - some routes have different paths, methods, or parameter positions compared to Express originals.

**Impact**: 13 breaking route changes across 3 files in `src/routes/`. The `src/api/*` routes are all correct.

## File Paths

| Type | Path |
|------|------|
| Express legacy routes | `packages/cloud/src/routes/*.ts` |
| Express api routes | `packages/cloud/src/api/{client,console,sdk,public}/*.ts` |
| Hono legacy routes | `packages/cloud/src/api/hono/routes/*.ts` |
| Hono api routes | `packages/cloud/src/api/hono/{client,console,sdk,public}/*.ts` |
| Hono app | `packages/cloud/src/hono-app.ts` |

## Breaking Changes (src/routes → api/hono/routes)

### 1. account.routes.ts

| Express | Hono | Issue |
|---------|------|-------|
| `GET /export-status?id=X` | `GET /export-status/:id` | Query param → Path param |
| `GET /download-export/:id` | `GET /export-download/:id` | Path renamed |
| `GET /privacy` | `GET /privacy-settings` | Path renamed |
| `PUT /privacy` | `PUT /privacy-settings` | Path renamed |
| `GET /oauth/app/:packageName` | `GET /app/:packageName` | Prefix removed |
| `POST /oauth/token` | **MISSING** | Route removed entirely |

### 2. apps.routes.ts

| Express | Hono | Issue |
|---------|------|-------|
| `POST /install/:packageName` | `POST /:packageName/install` | Parameter position swapped |
| `POST /uninstall/:packageName` | `POST /:packageName/uninstall` | Parameter position swapped |

### 3. organization.routes.ts

| Express | Hono | Issue |
|---------|------|-------|
| `POST /:orgId/members` | `POST /:orgId/invite` | Path changed |
| `PATCH /:orgId/members/:memberId` | `PUT /:orgId/members/:memberId/role` | Method + path changed |
| `POST /accept/:token` | `POST /:orgId/accept-invite` | Completely different structure |
| `POST /:orgId/invites/resend` | `POST /:orgId/resend-invite` | Path changed |
| `POST /:orgId/invites/rescind` | `POST /:orgId/rescind-invite` | Path changed |

## Already Fixed (this session)

| File | Issue | Fix |
|------|-------|-----|
| audio.routes.ts | `/api/audio/api/audio/:userId` duplicate prefix | Changed to `/:userId` |
| audio.routes.ts | `/api/audio/api/tts` duplicate prefix | Changed to `/tts` |
| audio.routes.ts | Missing `/api/tts` backwards compat | Added `app.get("/api/tts", textToSpeech)` in hono-app.ts |
| transcripts.routes.ts | `/api/transcripts/api/transcripts/:id` duplicate prefix | Changed to `/:appSessionId` |

## Verified OK (src/routes)

All routes match between Express and Hono:

- admin.routes.ts
- app-communication.routes.ts
- app-settings.routes.ts
- app-uptime.routes.ts
- auth.routes.ts
- developer.routes.ts
- error-report.routes.ts
- gallery.routes.ts
- hardware.routes.ts
- onboarding.routes.ts
- permissions.routes.ts
- photos.routes.ts
- streams.routes.ts
- tools.routes.ts
- user-data.routes.ts

## Verified OK (src/api)

All routes match between Express (`src/api/*`) and Hono (`src/api/hono/*`):

### Client APIs (`/api/client/*`)
- calendar.api.ts
- client.apps.api.ts
- device-state.api.ts
- feedback.api.ts
- livekit.api.ts
- location.api.ts
- min-version.api.ts
- notifications.api.ts
- user-settings.api.ts

### Console APIs (`/api/console/*`)
- cli-keys.api.ts
- console.account.api.ts
- console.apps.api.ts
- orgs.api.ts

### SDK APIs (`/api/sdk/*`)
- sdk-version.api.ts
- simple-storage.api.ts

### Public APIs (`/api/public/*`)
- permission.ts / permissions.api.ts

## Fix Options

**Option A**: Update Hono routes to match Express (backwards compatible)
**Option B**: Update clients to use new Hono paths (breaking)
**Option C**: Add aliases in Hono for old paths (both work)

## Status

- [x] Audit all Express routes in `src/routes/`
- [x] Audit all Hono routes in `src/api/hono/routes/`
- [x] Audit all Express routes in `src/api/*`
- [x] Audit all Hono routes in `src/api/hono/*`
- [x] Fix duplicate prefix bugs (audio, transcripts)
- [x] Add /api/tts backwards compat
- [x] Fix account.routes.ts mismatches (6 routes)
- [x] Fix apps.routes.ts mismatches (2 routes)
- [x] Fix organization.routes.ts mismatches (5 routes)
- [ ] Verify with client team which paths are in use