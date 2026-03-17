# 044 — CI/CD Build Audit: Dead Code Removal & Build Fixes

## Summary

Mass deletion of dead code across the cloud codebase, driven by the [maintainability audit](../040-cloud-v3-cleanup/maintainability.md) and [CI build audit](./spike.md). This PR removes ~26,000 lines of dead code, 31 unused npm packages, and fixes build order/config issues across CI workflows and Dockerfiles.

## What changed

### 🗑️ LiveKit removal (maintainability §19)

LiveKit was replaced by direct WebSocket + UDP audio transport. The entire stack was dead code:

- **Deleted** `packages/cloud-livekit-bridge/` — entire Go gRPC bridge service (28 files, including compiled binaries)
- **Deleted** `packages/cloud/src/services/session/livekit/` — `LiveKitManager`, `LiveKitClient`, `LiveKitGrpcClient`, `LiveKitTokenService`, `SpeakerManager`
- **Deleted** LiveKit API routes (both Express and Hono versions), `livekit.service.ts`
- **Deleted** `docker/Dockerfile.livekit`, `start.sh` (dual-process Go+Bun launcher), `porter-livekit.yaml`, `porter-2cpu.yaml`
- **Edited** `UserSession.ts`, `AudioManager.ts`, `MicrophoneManager.ts`, `bun-websocket.ts`, `websocket-glasses.service.ts` — removed all LiveKit references
- **Updated** `porter.yaml` → uses `Dockerfile.porter` (no Go build stage), runs `bun run start` directly
- **Updated** `porter-dev.yml`, `porter-debug.yml` → reference `porter.yaml` instead of `porter-livekit.yaml`
- **Removed deps:** `@livekit/rtc-node`, `livekit-server-sdk`, `@grpc/grpc-js`, `@grpc/proto-loader`

### 🗑️ Express mass delete (maintainability §1)

The cloud fully migrated to Hono. All Express code was orphaned — `index.ts` only imports Hono.

- **Deleted** `src/routes/` — 19 Express route files (~7,100 lines)
- **Deleted** `src/api/index.ts` (Express API registration), `src/api/client/`, `src/api/console/`, `src/api/sdk/`, `src/api/public/`
- **Deleted** `src/api/middleware/` (Express middleware — Hono has its own at `api/hono/middleware/`)
- **Deleted** `src/middleware/` (top-level Express middleware — also orphaned)
- **Deleted** `index-express.ts`, `legacy-express.ts`
- **Relocated** design docs from `api/client/docs/` → `packages/cloud/docs/design/`
- **Removed deps:** `express`, `helmet`, `cors`, `cookie-parser`, `pino-http`, `multer`, plus 7 `@types/*` packages
- **Removed** dead root deps: `ts-node`, `ts-node-dev`, `winston`, `@sentry/tracing`, `pm2`, `concurrently`
- **Removed** Express `overrides` from both `package.json` files
- **Cleaned up** old ESLint 7 / prettier / husky devDeps from `packages/cloud` (conflicts with root ESLint 9)

### 🗑️ Azure provider removal (maintainability §2)

Soniox is the only active transcription/translation provider. Azure was fully dead.

- **Deleted** `AzureTranscriptionProvider.ts` (680 lines), `AzureTranslationProvider.ts` (575 lines)
- **Edited** `TranscriptionManager.ts` — removed Azure import, initialization, fallback logic
- **Edited** `TranslationManager.ts` — removed Azure dynamic import and initialization
- **Edited** transcription/translation `types.ts` — removed `AzureProviderConfig`, `AzureErrorType`, `AzureProviderError`, Azure env vars
- **Edited** `pino-logger.ts`, `posthog.service.ts` — removed `AZURE_SPEECH_REGION` env var fallback
- **Removed dep:** `microsoft-cognitiveservices-speech-sdk` (~50 MB installed)

### 🗑️ App communication removal (maintainability §9)

Feature was deprecated — the endpoint returned an empty array with a TODO.

- **Deleted** `api/hono/routes/app-communication.routes.ts`
- **Edited** `hono-app.ts` — removed import and route mount

### 🔧 CI workflow fixes (from [spike.md](./spike.md))

Carried forward from the first commit on this branch:

- **Fixed** cache keys: `bun.lockb` → `bun.lock` across all workflows
- **Fixed** build order: `types → display-utils → sdk → utils → cloud` in `cloud-build.yml`, `cloud-console-build.yml`
- **Added** `display-utils` build step to all relevant pipelines
- **Added** `--frozen-lockfile` to `cloud-build.yml`
- **Added** concurrency group to `cloud-tests.yml`
- **Narrowed** `cloud-tests.yml` path triggers (was `cloud/**`, now specific package paths)

### 🐳 Dockerfile fixes

- **Added** `display-utils` to build chain in `Dockerfile.porter` and `Dockerfile.stress`
- **Fixed** build order in both Dockerfiles

## Risk assessment

| Change            | Risk                                                                                                    | Mitigation                      |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| LiveKit removal   | **Low** — AudioManager has `// we no longer use livekit` comment, no mobile client sends `livekit=true` | Deploying to debug server first |
| Express deletion  | **Low** — `index.ts` has zero Express imports, Express files were orphans                               | Entry point only uses Hono      |
| Azure removal     | **Low** — Soniox is the only provider, Azure env vars not in Doppler                                    | Confirmed zero active config    |
| App communication | **None** — returned empty array, feature deprecated                                                     | —                               |
| Dep cleanup       | **Low** — all confirmed zero imports                                                                    | Build succeeds after removal    |

## Testing plan

- [x] Deploy to `cloud-debug` via `porter-debug.yml` (branch added to triggers)
- [ ] Verify cloud boots and connects to MongoDB
- [ ] Verify glasses WebSocket connection + audio flow (UDP)
- [ ] Verify app WebSocket connection
- [ ] Verify console API routes work
- [ ] Verify transcription (Soniox) still works
- [ ] Verify translation still works

## Stats

```
126 files changed, ~26,000 lines deleted, ~31 npm packages removed
```

## Related docs

- [CI Build Audit spike](./spike.md) — CI workflow issues and fix plan
- [package.json audit](./package-json-audit.md) — full dependency audit with delete/keep rationale
- [Maintainability doc](../040-cloud-v3-cleanup/maintainability.md) — source of truth for §1, §2, §9, §19
