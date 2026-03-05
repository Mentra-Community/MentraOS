# Cloud v3 — Maintainability

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [overview.md](./overview.md) · [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this doc?

This doc catalogs maintainability issues in the MentraOS cloud codebase — dead code, duplicated code, god objects, naming confusion, and technical debt that make the codebase harder to work in than it needs to be.

## Why it matters

The cloud codebase has grown organically. Express and Hono route files are fully duplicated (38 files doing the same thing). Azure transcription code is dead but still wired in. Core services are 1000+ line god objects with TODO comments about splitting them. Auth middleware is misnamed and mixes concerns. Every change carries the risk of touching something that looks alive but isn't, or missing a second copy of something that exists in two places.

This slows down every engineer on every task. Cleaning this up is prerequisite work for shipping SDK v3 and for making the other improvements (reliability, observability, testing) practical.

## System context

See [overview.md](./overview.md) for full system architecture. This doc focuses on the **cloud** component — the Bun/Hono server that sits between mobile clients and mini apps.

---

## Issues

### 1. Express is dead — mass delete

The cloud is mid-migration from Express to Hono. **Every single route file is duplicated:**

- `src/routes/*.ts` — 19 Express route files
- `src/api/hono/routes/*.ts` — 19 Hono route files (same names, same logic)
- `src/api/console/*.ts` — Express console APIs
- `src/api/hono/console/*.ts` — Hono console APIs (duplicated again)

**Decision: Mass delete all Express code.** The Hono routes are already written and working. Express was only kept as a reference in case of Hono bugs, but it's been stable. Delete `src/routes/`, the Express console APIs, Express middleware, Express dependency from `package.json`, and any Express-specific imports/types.

### 2. Azure transcription provider is dead code

Soniox is the only transcription provider in active use. Azure is still fully wired in:

- `AzureTranscriptionProvider.ts` — ~680 lines, full implementation
- `ProviderSelector.ts` — 273 lines of provider selection logic between Azure and Soniox
- `TranscriptionManager.ts` — Azure initialization, Azure fallback logic, Soniox→Azure failover paths
- `microsoft-cognitiveservices-speech-sdk` — dependency in package.json
- Env vars: `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY` still referenced

This isn't deprecated — it's dead. Soniox handles all transcription. Azure should be removed entirely, not kept as a fallback. Removing Azure + simplifying ProviderSelector will cut ~1000 lines and significantly simplify TranscriptionManager (currently 2,201 lines).

### 3. Alibaba transcription provider — China-only, stays

- `AlibabaTranscriptionProvider.ts` — ~617 lines
- Only initialized when `IS_CHINA` flag is set
- Uses its own WebSocket connection to Alibaba's API
- Has a `TODO: Do i need to close the websocket here?????` in the message handler

**Decision: Keep.** China cloud deployment is WIP, separate engineer is responsible. Provider stays, but the TODO and code quality issues should be cleaned up.

### 4. `app.service.ts` is a god object (1,122 lines)

Single file handles: app CRUD, app store operations, developer operations, tool calls, settings push, API key management, app publishing, organization lookups. Has **8+ `TODO(isaiah)` comments** about splitting it:

- `TODO(isaiah): Move this to the new AppManager within new UserSession class.`
- `TODO(isaiah): Move this logic to a new developer service to declutter the app service.` (×5)
- `TODO(isaiah): Consider splitting this into multiple services (appstore.service, developer.service, tools.service)`

This needs to be split into at least: `app-store.service.ts`, `developer.service.ts`, `tools.service.ts`.

### 5. Dashboard mini app needs to die — cloud takes over

Already decided in [039 D31](../039-sdk-v3-api-surface/v2-v3-api-map.md#16-dashboard). The cloud work required:

- **Kill the Dashboard mini app** and **rewrite `DashboardManager`** (~894 lines) — kill the 4-quadrant `SystemContent` model (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`). Replace with system header + full-width body layout. Compose as TextWall using display-utils, send to `ViewType.DASHBOARD`.
- **Kill `SYSTEM_DASHBOARD_PACKAGE_NAME`** privileged app concept — no more special-case routing for the dashboard app.
- **Move existing code from Dashboard mini app into cloud** — weather (OpenWeatherMap), notification summarization (LLM agent), calendar formatting, etc. All this logic already exists in the mini app, just needs to be relocated into the DashboardManager rewrite.

### 6. SDK route paths hardcoded in multiple places

Cloud hardcodes SDK endpoint paths (`/webhook`, `/tool`, `/health`, `/settings`, `/photo-upload`, `/mentra-auth`) in:

- `AppManager.ts` — webhook calls
- `app.service.ts` — tool calls, stop webhook
- `PhotoManager.ts` — photo upload
- `app-settings.routes.ts` — settings push
- `system-app.api.ts` — tool invocation

For SDK v3 these move to `/api/_mentraos/*`. **Decision: mount both old and new paths during transition**, then drop old paths when v2 SDK apps are sunset.

### 7. Auth middleware is confused

- `validateSupabaseToken` in `developer.routes.ts` is named wrong — it actually validates a MentraOS JWT (`coreToken`), not a Supabase token. Has a TODO acknowledging this.
- `unifiedAuthMiddleware` in `apps.routes.ts` mixes client auth, system app auth, and third-party app auth into one middleware. TODO says it should be split.
- `currentOrgId` comes from a request header and is blindly trusted without validation. TODO says it should be validated or moved to a query param.

### 8. Settings system — needs deprecation cleanup

Settings is being deprecated in favor of Storage (039 D29). Cloud-side cleanup:

- `app-settings.routes.ts` — settings push endpoint (exists in both Express and Hono)
- Settings schema management in app service
- Settings-related event broadcasting to connected apps
- MentraOS system settings (`metricSystemEnabled`, `brightness`, etc.) — these are OS-level and need a new home (probably `UserSession` or `DeviceState`)

### 9. Multi-user app communication is deprecated — remove entirely

`app-communication.routes.ts` has the entire `discoverUsers` implementation commented out. The feature is dead and deprecated.

**Decision: Remove entirely.** Delete `app-communication.routes.ts` (both Express and Hono versions), remove all app-to-app APIs from the SDK (see 039 §20 — `discoverAppUsers`, `broadcastToAppUsers`, `sendDirectMessage`, `joinAppRoom`, `leaveAppRoom`, `onAppMessage`, `onAppUserJoined`, `onAppUserLeft`, `onAppRoomUpdated` — all removed).

### 10. `developer.routes.ts` — 1000+ lines, uses `console.log`

- Over 1000 lines in a single route file
- Has a TODO at the top: `TODO(isaiah): refactor this code to use this logger instead of console.log, console.error, etc.`
- Handles developer CRUD, app management, organization management, image uploads (via multer) — all in one file
- Should be split alongside the `app.service.ts` god object cleanup

### 11. `DoubleTextWall` column composition bug

The `ColumnComposer` in `@mentra/display-utils` has a known bug where characters can overflow from the right quadrant to the left side of the screen (off by ~1 character in pixel alignment). This is the bug that partly motivated moving the dashboard away from `DoubleTextWall`. Still needs to be fixed since mini apps may use `showDoubleText()`.

### 12. Dead/stale code scattered throughout

- `REGION` env var falls back to `AZURE_SPEECH_REGION` in the logger — Azure remnant
- `import { systemApps } from './system-apps'` commented out in `app.service.ts`
- Export data endpoint returns empty arrays with TODOs: `apps: [], // TODO: Add installed apps`
- `audio.routes.ts` has a TODO about improving the audio manager for last-10-seconds retrieval
- `transcripts.routes.ts` has a TODO about `startTime/endTime` filter handling
- Various `onMentraosSettingsChange` / `onMentraosSettingChange` duplicate methods in the SDK that need to be removed
- `DisplayManager6.1.ts` — has a version number in the filename

### 13. No consistent error handling pattern

Hono routes use `try/catch` with `c.json({error}, X)` in ad-hoc patterns. No centralized error handler, no standard error response shape, no error codes. Each route file reinvents error handling.

### 14. WebSocket → REST migration leftovers

The cloud previously used WebSocket for some SDK communication paths that have since moved to REST. There may be dead WebSocket handling code paths that no longer receive traffic. Needs an audit to identify and remove.

### 15. Decouple userId from email

Throughout the entire codebase, `userId` **is** the user's email address. This is hardwired everywhere:

- `UserSession.getById(email)` — the static sessions `Map` is keyed by email
- All auth middleware (`clientAuth`, `authenticateConsole`, `authenticateCLI`) extract `email` from JWT and set it as the user identifier via `c.set("email", ...)`
- JWT tokens (`coreToken`) carry `email` as the identity claim — `decoded.email` is used to look up sessions, query MongoDB, authorize requests
- Logger context uses `userId: email` across all middleware and services
- MongoDB documents store email as the user identifier (e.g., `Incident.userId`, organization `members.userId`)
- `account.routes.ts` cleanup logic uses email to find sessions, orgs, and user data
- `app-settings.routes.ts` extracts `decoded.email` and calls it `userId`

This means **login/signup with phone number (or any non-email identity) is impossible** without touching nearly every file in the codebase.

**What needs to happen:**

- Introduce a proper `userId` field (UUID or similar) that is independent of email
- JWT tokens should carry `userId` as the primary claim, with `email` as an optional profile field
- `UserSession` map should be keyed by `userId`, not email
- MongoDB documents should reference `userId`, not email
- Auth middleware should resolve to `userId`, not `email`
- This is a large migration — needs a phased approach where both email-as-id and real-id are supported during transition

### 16. Mini app ↔ cloud WebSocket connection is too fragile

The WebSocket connection between mini apps and the cloud (`/app-ws`) breaks too often. The amount of infrastructure built to work around this fragility tells the story:

- `AppSession` has 7 connection states: `CONNECTING`, `RUNNING`, `GRACE_PERIOD`, `DORMANT`, `RESURRECTING`, `STOPPING`, `STOPPED`
- `AppManager` has resurrection logic (`resurrectDormantApps`), grace period expiry handling, dormant app detection, pending connection tracking
- The SDK defaults to `maxReconnectAttempts: 3` with exponential backoff
- `handleAppConnectionClosed` in `AppManager` (~100 lines) handles the various disconnection scenarios

All of this complexity exists because the underlying WebSocket connection is unreliable. The root cause needs investigation — is it Cloudflare's proxy, Bun's WebSocket implementation, mini app server instability, or something else? Fixing the root cause would let us dramatically simplify `AppSession` state management and `AppManager` lifecycle code.

### 17. Linter is broken — fix and enforce

The linter is not running cleanly and is effectively unenforced:

- The `cloud/packages/cloud` package has `eslint@7.32.0` and `@typescript-eslint@5.9.1` in devDependencies
- The workspace root `cloud/` has `eslint@9.20.1` and `typescript-eslint@8.24.0` — completely different major versions
- The lint script (`eslint src --ext .js,.jsx,.ts,.tsx`) uses the old `--ext` flag syntax which doesn't work with ESLint 9's flat config
- `developer.routes.ts` still uses `console.log` instead of the structured logger (§10) — linter should catch this
- No lint step in CI, so regressions go unnoticed

**What needs to happen:**

- Pick one ESLint version (9.x with flat config) and use it everywhere
- Remove the outdated ESLint 7 + @typescript-eslint 5 from `packages/cloud`
- Fix or suppress all existing lint errors so the codebase passes cleanly
- Add lint to CI so it stays clean

### 18. Mentra-auth flow — no account switching, needs improvement

The `mentra-auth` / authentication flow for mini app webviews has usability and architectural issues:

- **No way to switch accounts.** The `@mentra/react-sdk` auth stores `mentraos_userId` and `mentraos_frontendToken` in `localStorage`. Once authenticated, there's no mechanism to switch to a different account — `clearStoredAuth()` exists but isn't exposed in any user-facing flow.
- **Issuer is hardcoded to old name.** The token verification in `authCore.ts` checks `iss: ['https://prod.augmentos.cloud']` — still references the old AugmentOS branding.
- **The `/mentra-auth` redirect in the SDK** points to `account.mentra.glass/auth` — this is a simple redirect, no error handling, no callback verification, no state parameter for CSRF protection.
- **Token-in-URL pattern is fragile.** The `aos_signed_user_token` is passed as a URL query parameter, extracted once, then stripped from the URL. If the page loads twice before the strip happens, or if the token is cached in browser history, behavior is undefined.

**What needs to happen:**

- Add an explicit "switch account" or "sign out" action to the react-sdk auth provider
- Update the issuer claim to the current `mentra.glass` domain
- Review the auth redirect flow for security (state parameter, proper error handling)
- Consider whether the token-in-URL approach should be replaced with a more robust OAuth-style flow

### 19. Remove LiveKit — it's dead

LiveKit was previously used as an audio transport layer between the mobile client and the cloud. It has been replaced by direct WebSocket and UDP audio transport. However, the code is still fully wired in:

- `services/session/livekit/` — entire directory with 5 files: `LiveKitManager.ts`, `LiveKitClient.ts`, `LiveKitGrpcClient.ts`, `LiveKitTokenService.ts`, `SpeakerManager.ts`
- `packages/cloud-livekit-bridge/` — a separate **Go service** with its own Dockerfile, gRPC proto files, session management
- `UserSession` instantiates `LiveKitManager` and `SpeakerManager` for every session — two of the ~15+ managers that inflate per-session memory (see [scalability.md](./scalability.md) §4)
- `AudioManager` has ~100 lines of LiveKit reconnection logic (`triggerLiveKitReconnect`) — with a comment at the top explicitly saying `// we no longer use livekit`
- `MicrophoneManager` still calls `this.session.liveKitManager.onMicStateChange()`
- `hono-app.ts` mounts LiveKit API routes at `/api/client/livekit`
- LiveKit-related API files exist in both `src/api/client/livekit.api.ts` and `src/api/hono/client/livekit.api.ts`
- `UserSession.livekitRequested` field still exists
- LiveKit npm dependencies and the Go module dependencies in `cloud-livekit-bridge`

**Decision: Remove entirely.** Delete the `livekit/` directory, the `cloud-livekit-bridge` package, all LiveKit API routes, the LiveKit reconnect logic in AudioManager, the SpeakerManager, and all LiveKit dependencies. This will reduce per-session memory footprint and remove a significant chunk of dead code.

---

## Largest files in services/ (for context)

| File                              | Lines | Notes                                           |
| --------------------------------- | ----- | ----------------------------------------------- |
| `TranscriptionManager.ts`         | 2,201 | Biggest. Azure init/fallback logic inflates it  |
| `AppManager.ts`                   | 1,819 | App lifecycle, webhooks, connections            |
| `ManagedStreamingExtension.ts`    | 1,434 | Cloudflare stream management                    |
| `TranslationManager.ts`           | 1,359 | Translation streams                             |
| `app.service.ts`                  | 1,122 | God object (§4)                                 |
| `SonioxTranscriptionProvider.ts`  | 1,091 | Main transcription provider                     |
| `DisplayManager6.1.ts`            | 1,082 | Display management — version number in filename |
| `SonioxTranslationProvider.ts`    | 1,040 |                                                 |
| `CloudflareStreamService.ts`      | 997   |                                                 |
| `AppSession.ts`                   | 908   | Per-app session on cloud side                   |
| `organization.service.ts`         | 899   |                                                 |
| `DashboardManager.ts`             | 894   | Being rewritten (§5)                            |
| `LiveKitManager.ts`               | ~700  | Dead code (§19)                                 |
| `AzureTranscriptionProvider.ts`   | 680   | Dead code (§2)                                  |
| `AlibabaTranscriptionProvider.ts` | 617   | China-only, stays (§3)                          |

---

## Prioritization

### Must-do for v3.0

| #   | Issue                                             | Why                                                                     |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Mass delete Express code                          | Hono routes already working, can't maintain two sets of routes          |
| 2   | Kill Azure provider                               | Dead code, dependency weight, inflates TranscriptionManager             |
| 5   | Dashboard → OS service (rewrite DashboardManager) | Required for new dashboard API                                          |
| 6   | SDK route paths — mount both old + new            | SDK v3 needs `/api/_mentraos/*`, v2 needs old paths during transition   |
| 9   | Remove multi-user app communication               | Deprecated, backend already broken, SDK removing all app-to-app APIs    |
| 19  | Remove LiveKit                                    | Dead code, inflates per-session memory, separate Go service to maintain |
| 17  | Fix linter and enforce in CI                      | No lint enforcement = regressions on every commit                       |

### Should-do for v3.0

| #   | Issue                                   | Why                                                         |
| --- | --------------------------------------- | ----------------------------------------------------------- |
| 8   | Settings deprecation cleanup            | SDK v3 deprecates settings                                  |
| 12  | Dead/stale code sweep                   | General hygiene                                             |
| 7   | Auth middleware cleanup                 | Security concern, naming confusion                          |
| 11  | DoubleTextWall pixel bug                | Mini apps still use `showDoubleText()`                      |
| 16  | Investigate mini app WS fragility       | Root cause fix would simplify AppSession/AppManager heavily |
| 18  | Mentra-auth account switching + cleanup | Usability blocker, stale branding references                |

### Can defer past v3.0

| #   | Issue                          | Why                                                        |
| --- | ------------------------------ | ---------------------------------------------------------- |
| 4   | Split `app.service.ts`         | Big refactor, doesn't block v3                             |
| 10  | Split `developer.routes.ts`    | Same                                                       |
| 13  | Error handling standardization | Nice to have, large scope                                  |
| 14  | WebSocket dead path audit      | Needs investigation first                                  |
| 15  | Decouple userId from email     | Large migration, needed for phone auth but not blocking v3 |

---

## Open Questions

| #   | Question                                     | Notes                                                                                                            |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Q1  | Where do MentraOS system settings live?      | `metricSystemEnabled`, `brightness` — move to `UserSession`? `DeviceState`?                                      |
| Q2  | When to drop old SDK paths?                  | Both old (`/webhook`) and new (`/api/_mentraos/webhook`) mounted during transition. When do we remove old paths? |
| Q3  | Why do mini app WebSockets break so often?   | Cloudflare proxy? Bun WS implementation? Mini app server instability? Needs root cause investigation.            |
| Q4  | userId migration strategy?                   | How to phase the email→UUID migration? Dual-key lookups during transition? What about existing MongoDB docs?     |
| Q5  | What's the right auth flow for mentra-auth?  | Current token-in-URL approach vs. proper OAuth code flow? How should account switching work in webview context?  |
| Q6  | Is any part of LiveKit still used by anyone? | SpeakerManager for audio playback? Any mobile client paths still requesting LiveKit tokens?                      |
