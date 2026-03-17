# 044 — package.json & Dead Code Audit

> Companion to [spike.md](./spike.md) (CI workflow fixes).
> This document audits every `package.json` in the cloud workspace and maps all dead code identified in [maintainability.md](../040-cloud-v3-cleanup/maintainability.md) to concrete delete/edit operations.

---

## Summary

| Category                 | Files removed                 | Lines removed (approx) | Deps removed       |
| ------------------------ | ----------------------------- | ---------------------- | ------------------ |
| LiveKit (§19)            | ~35 files + entire Go package | ~2,500                 | 4 npm + Go modules |
| Express (§1)             | ~32 files                     | ~9,800                 | 6 npm + 8 @types   |
| Azure providers (§2)     | 2 files + edits               | ~1,300                 | 1 npm              |
| App communication (§9)   | 2 files + edits               | ~250                   | 0                  |
| Root package.json cruft  | —                             | —                      | 7 npm              |
| Cloud package.json cruft | —                             | —                      | 5 npm              |
| **Total**                | **~71 files**                 | **~13,850**            | **~31 packages**   |

---

## 1. LiveKit removal (maintainability §19)

LiveKit was replaced by direct WebSocket + UDP audio transport. The entire stack is dead: a Go gRPC bridge, TypeScript managers, API routes, Dockerfiles, porter configs, and `start.sh`.

### Delete entirely

| Path                                                    | What                                                                                                                       | Lines |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/cloud-livekit-bridge/`                        | Entire Go service (28 files, Dockerfile, proto, docs)                                                                      | —     |
| `packages/cloud/src/services/session/livekit/`          | `LiveKitManager.ts`, `LiveKitClient.ts`, `LiveKitGrpcClient.ts`, `LiveKitTokenService.ts`, `SpeakerManager.ts`, `index.ts` | 1,922 |
| `packages/cloud/src/services/client/livekit.service.ts` | Token minting service                                                                                                      | 120   |
| `packages/cloud/src/api/client/livekit.api.ts`          | Express LiveKit API                                                                                                        | 150   |
| `packages/cloud/src/api/hono/client/livekit.api.ts`     | Hono LiveKit API                                                                                                           | 160   |
| `docker/Dockerfile.livekit`                             | Multi-stage Go + Bun Dockerfile                                                                                            | 99    |
| `porter-livekit.yaml`                                   | Porter config (livekit variant)                                                                                            | 44    |
| `porter-2cpu.yaml`                                      | Porter config (references Dockerfile.livekit)                                                                              | 37    |
| `start.sh`                                              | Dual-process launcher (Go bridge + Bun)                                                                                    | 62    |

### Edit — remove LiveKit references

| File                                                                  | What to remove                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloud/src/services/session/UserSession.ts`                  | `import LiveKitManager`, `import SpeakerManager`, `liveKitManager` property, `speakerManager` property, `livekitRequested` field, `liveKitManager.dispose()` in cleanup |
| `packages/cloud/src/services/session/AudioManager.ts`                 | `triggerLiveKitReconnect()` method (~100 lines), all LiveKit reconnect logic, `liveKitManager` references                                                               |
| `packages/cloud/src/services/session/MicrophoneManager.ts`            | `this.session.liveKitManager.onMicStateChange()` call (line 132), commented-out livekit lines                                                                           |
| `packages/cloud/src/services/websocket/bun-websocket.ts`              | `livekitRequested` param parsing, all LiveKit bridge status/rejoin logic in `handleGlassesConnectionInit`, LiveKit info in CONNECTION_ACK                               |
| `packages/cloud/src/services/websocket/websocket-glasses.service.ts`  | Same as above — `livekitRequested` param, bridge status checks, CONNECTION_ACK LiveKit payload                                                                          |
| `packages/cloud/src/services/websocket/types.ts`                      | `livekitRequested: boolean` from WebSocket data type                                                                                                                    |
| `packages/cloud/src/hono-app.ts`                                      | `livekitApi` import (line 25), `/api/client/livekit` route mount (line 263), noise filter for `/api/livekit/token` (line 120)                                           |
| `packages/cloud/src/api/hono/index.ts`                                | `livekitApi` re-export                                                                                                                                                  |
| `packages/cloud/src/api/hono/client/index.ts`                         | `livekitApi` re-export                                                                                                                                                  |
| `packages/cloud/src/services/session/handlers/app-message-handler.ts` | Remove commented-out LiveKit playback/stop references (cosmetic)                                                                                                        |

### Edit — porter & deploy configs

| File                                 | Change                                                                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `porter.yaml`                        | Change `dockerfile` to `Dockerfile.porter`, change `run` from `./start.sh` to `cd packages/cloud && PORT=80 bun run start`, remove `LIVEKIT_GRPC_SOCKET`, `LIVEKIT_PCM_ENDIAN`, `BETTERSTACK_*` (Go bridge logging) env vars |
| `docker/Dockerfile.porter`           | Already clean (no LiveKit). Add `display-utils` to build chain.                                                                                                                                                              |
| `.github/workflows/porter-dev.yml`   | Change `porter-livekit.yaml` → `porter.yaml`                                                                                                                                                                                 |
| `.github/workflows/porter-debug.yml` | Change `porter-livekit.yaml` → `porter.yaml`                                                                                                                                                                                 |
| `porter/porter-captions copy.yaml`   | Delete file (stale copy referencing Dockerfile.livekit)                                                                                                                                                                      |

### Remove dependencies — `packages/cloud/package.json`

```/dev/null/deps-livekit.txt#L1-4
"@livekit/rtc-node": "^0.13.18",      # dependencies — dead
"livekit-server-sdk": "^2.13.2",       # dependencies — dead
"@grpc/grpc-js": "^1.12.4",           # dependencies — only used by LiveKit gRPC client
"@grpc/proto-loader": "^0.7.15",      # dependencies — only used by LiveKit gRPC client
```

---

## 2. Express mass delete (maintainability §1)

The cloud migrated from Express to Hono. All Express code is kept "as reference" but the Hono routes are the only live code path. `index.ts` (the real entry point) imports only Hono. `index-express.ts` and `legacy-express.ts` are dead files. The entire `src/routes/` directory is the Express version of routes that already exist under `src/api/hono/routes/`.

### Delete entirely

| Path                                   | What                                                                    | Lines |
| -------------------------------------- | ----------------------------------------------------------------------- | ----- |
| `packages/cloud/src/routes/`           | 19 Express route files                                                  | 7,135 |
| `packages/cloud/src/api/index.ts`      | Express API registration (`registerApi()`)                              | 121   |
| `packages/cloud/src/api/client/`       | 10 Express client API files (including livekit — already in §1 above)   | 913   |
| `packages/cloud/src/api/console/`      | 5 Express console API files + 2 MDX docs                                | 866   |
| `packages/cloud/src/api/middleware/`   | 5 Express middleware files (Hono has its own at `api/hono/middleware/`) | ~300  |
| `packages/cloud/src/index-express.ts`  | Dead Express entry point                                                | 406   |
| `packages/cloud/src/legacy-express.ts` | Dead legacy Express compatibility layer                                 | 375   |

**Total: ~32 files, ~10,100 lines**

> **Note:** `packages/cloud/src/api/client/docs/` contains 4 design docs (CalendarManager, DeviceManager, LocationManager, migration plan). These are **not** Express-specific — they're architecture docs that happened to live next to Express code. **Relocate** them to `packages/cloud/docs/` or `issues/` before deleting the `api/client/` directory.

### Edit — `packages/cloud/package.json`

Remove from `scripts`:

```/dev/null/scripts.txt#L1
"dev:express": "bun --watch src/index-express.ts",
```

Remove from `dependencies`:

```/dev/null/deps-express.txt#L1-5
"express": "^4.18.2",
"helmet": "^4.6.0",
"cors": "^2.8.5",
"cookie-parser": "^1.4.7",
"pino-http": "^10.5.0",
```

> `cookie-parser` — only imported in Express entry points (index-express.ts, legacy-express.ts).
> `pino-http` — only imported in Express entry points and Express routes. Hono uses its own request logging middleware.
> `cors` — Hono uses `hono/cors` built-in.
> `helmet` — Hono uses `hono/secure-headers` or custom middleware.

Remove from `devDependencies`:

```/dev/null/devdeps-express.txt#L1-7
"@types/cookie-parser": "^1.4.2",
"@types/cors": "^2.8.12",
"@types/dotenv": "^8.2.0",
"@types/express": "^4.17.21",
"@types/express-serve-static-core": "4.19.6",
"@types/helmet": "^4.0.0",
"@types/multer": "^1.4.7",
```

Remove from `overrides`:

```/dev/null/overrides.txt#L1
"@types/express-serve-static-core": "4.19.6"
```

### Edit — root `cloud/package.json`

Remove from `dependencies`:

```/dev/null/root-deps-express.txt#L1-2
"express": "^5.1.0",
"cookie-parser": "^1.4.7",
```

Remove from `overrides`:

```/dev/null/root-overrides.txt#L1-2
"@types/express": "4.17.21",
"@types/express-serve-static-core": "4.19.6"
```

---

## 3. Azure provider removal (maintainability §2)

Soniox is the only active transcription provider. Azure transcription and translation providers are dead code.

### Delete entirely

| Path                                                                                        | Lines |
| ------------------------------------------------------------------------------------------- | ----- |
| `packages/cloud/src/services/session/transcription/providers/AzureTranscriptionProvider.ts` | 680   |
| `packages/cloud/src/services/session/translation/providers/AzureTranslationProvider.ts`     | 575   |

### Edit — remove Azure references

| File                                                                        | What to remove                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloud/src/services/session/transcription/TranscriptionManager.ts` | `import { AzureTranscriptionProvider }`, Azure initialization branch (~line 994), Azure fallback/failover paths, Azure config type references |
| `packages/cloud/src/services/session/transcription/types.ts`                | Azure-related type definitions or enum values                                                                                                 |
| `packages/cloud/src/services/session/translation/TranslationManager.ts`     | Dynamic `import("./providers/AzureTranslationProvider")` (~line 521-524), Azure provider instantiation                                        |
| `packages/cloud/src/services/session/translation/types.ts`                  | Azure-related type definitions                                                                                                                |
| `packages/cloud/src/services/logging/pino-logger.ts`                        | `AZURE_SPEECH_REGION` fallback for `REGION` env var                                                                                           |
| `packages/cloud/src/services/logging/posthog.service.ts`                    | Any Azure-related references                                                                                                                  |

### Remove dependency — `packages/cloud/package.json`

```/dev/null/deps-azure.txt#L1
"microsoft-cognitiveservices-speech-sdk": "^1.44.1",
```

This is a **heavy** native dependency (~50 MB installed). Removing it visibly shrinks Docker images and install times.

---

## 4. Multi-user app communication removal (maintainability §9)

The feature is deprecated. The Express route file (`src/routes/app-communication.routes.ts`) gets deleted as part of §2 (Express mass delete). The Hono version still exists and returns an empty array with a TODO.

### Delete

| Path                                                             | Lines |
| ---------------------------------------------------------------- | ----- |
| `packages/cloud/src/api/hono/routes/app-communication.routes.ts` | 130   |

### Edit

| File                             | What to remove                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/cloud/src/hono-app.ts` | `import appCommunicationRoutes` (line 77), route mount for `/api/app-communication` |

---

## 5. Root `cloud/package.json` — dependency audit

### Dead or unnecessary dependencies

| Package                      | Status             | Reason                                                                                                                                        |
| ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `express` (^5.1.0)           | **Remove**         | Express is dead (§1). Only the sub-package used it, and root shouldn't hoist it.                                                              |
| `cookie-parser` (^1.4.7)     | **Remove**         | Express middleware. Dead.                                                                                                                     |
| `ts-node` (^10.9.2)          | **Remove**         | Bun runtime doesn't use ts-node. Migration scripts reference it in comments but should use `bun run` instead.                                 |
| `ts-node-dev` (^2.0.0)       | **Remove**         | Same — Bun's `--watch` flag replaces this.                                                                                                    |
| `winston` (^3.17.0)          | **Remove**         | Zero imports found in the entire codebase. Pino is the actual logger.                                                                         |
| `@sentry/tracing` (^7.120.3) | **Remove**         | Deprecated in Sentry v9. Zero imports found. Already using `@sentry/bun` + `@sentry/node` (v9).                                               |
| `@types/react` (18.2.79)     | **Keep (for now)** | Workspace hoisting — websites/console, websites/store, etc. all need it. Could move to individual packages but not worth the churn right now. |
| `@types/react-dom` (18.2.25) | **Keep (for now)** | Same as above.                                                                                                                                |

### Dead or unnecessary devDependencies

| Package                 | Status            | Reason                                                                                                                                                                                                                                          |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm2` (^5.4.3)          | **Remove**        | Zero imports. Bun runtime, not PM2. Likely a leftover from early Node.js days.                                                                                                                                                                  |
| `concurrently` (^9.1.2) | **Remove**        | Zero script references. No `concurrently` commands in any `scripts` block.                                                                                                                                                                      |
| `bun-types` (1.0.17)    | **Pin or update** | See [spike.md §7](./spike.md#7-bun-types-version-hack-runs-on-every-build). Currently pinned to 1.0.17 to work around a build issue. The Dockerfiles hack this by `bun add -d bun-types@1.0.17` on every build. Should use `overrides` instead. |

### Overrides to remove (after Express deletion)

```/dev/null/root-overrides-full.txt#L1-2
"@types/express": "4.17.21",
"@types/express-serve-static-core": "4.19.6"
```

---

## 6. `packages/cloud/package.json` — dependency audit

### Dead dependencies (beyond §1-§4 above)

| Package                 | Status              | Reason                                                                                                                                               |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moment` (^2.29.4)      | **Remove**          | Zero imports found in `packages/cloud/src/`. Deprecated library. If date formatting is needed later, use native `Intl.DateTimeFormat` or `date-fns`. |
| `bun-types` (^1.3.5)    | **Move to devDeps** | Currently in `dependencies` — should be in `devDependencies`. It's a type-only package.                                                              |
| `form-data` (^4.0.1)    | **Keep**            | Used by `services/storage/cloudflare-storage.service.ts` for image uploads to Cloudflare. Not Express-specific.                                      |
| `multer` (^1.4.5-lts.1) | **Remove**          | Express middleware for file uploads. Zero imports in any Hono route — Hono uses `c.req.parseBody()` natively.                                        |

### Dead devDependencies (beyond §1 above)

| Package                                     | Status               | Reason                                                                                                |
| ------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `eslint` (^7.32.0)                          | **Remove**           | Conflicts with root ESLint 9.x. Root ESLint should be the single version. (maintainability §17)       |
| `@typescript-eslint/eslint-plugin` (^5.9.1) | **Remove**           | Same — ancient version, conflicts with root `typescript-eslint@8.24.0`.                               |
| `@typescript-eslint/parser` (^5.9.1)        | **Remove**           | Same.                                                                                                 |
| `eslint-config-prettier` (^8.3.0)           | **Remove**           | Tied to the dead ESLint 7 config.                                                                     |
| `eslint-plugin-import` (^2.24.0)            | **Remove**           | Same. Root already has `eslint-plugin-import@^2.32.0`.                                                |
| `husky` (^7.0.1)                            | **Remove**           | Not configured (no `.husky/` dir, no `prepare` script referencing husky).                             |
| `prettier` (^2.3.2)                         | **Remove**           | Not integrated into any script or CI step.                                                            |
| `pretty-quick` (^3.1.1)                     | **Remove**           | Depends on husky (which is unconfigured). Dead.                                                       |
| `@types/stream-buffers` (^3.0.4)            | **Remove**           | Zero imports of `stream-buffers` found in the codebase. Dead Express-era leftover.                    |
| `@types/node` (^16.6.1)                     | **Update or remove** | Pinned to Node 16 types (!). Bun's own types cover this. If any code needs it, bump to `^20.0.0`.     |
| `chalk` (^5.3.0)                            | **Audit**            | In devDeps here, but `chalk@^5.6.2` is a real dep in `packages/sdk`. Check if cloud uses it directly. |

### Scripts to update

```/dev/null/scripts-cloud.txt#L1-2
"dev:express": "bun --watch src/index-express.ts",   # Remove — Express is dead
"lint": "eslint src --ext .js,.jsx,.ts,.tsx",          # Update — --ext flag is ESLint 8 syntax, broken with flat config
```

---

## 7. Dockerfile audit

All production Dockerfiles share the same issues identified in [spike.md §1](./spike.md#1-docker-layer-caching-is-completely-defeated) (layer caching defeated by `COPY . .` before install) and [spike.md §7](./spike.md#7-bun-types-version-hack-runs-on-every-build) (bun-types hack).

### Dockerfile.livekit — delete

Entire file deleted as part of LiveKit removal (§1 above).

### Dockerfile.porter — update

Currently clean (no LiveKit), but has issues:

- Missing `display-utils` from build chain
- `COPY . .` before `bun install` defeats layer caching
- `bun-types` hack runs on every build
- Build chain: types → sdk → utils → cloud. Missing display-utils. Should be: types → display-utils → sdk → utils → cloud.

### Dockerfile.stress — update

Same issues as Dockerfile.porter:

- Missing `display-utils` from build chain
- `COPY . .` before `bun install`
- `bun-types` hack
- Build order missing display-utils

### Dockerfile.captions — OK (mostly)

Already copies only what it needs (sdk, types, captions app). Good layer caching pattern. No LiveKit dependency.

### Dockerfile.dev — OK

Already uses split COPY for dependency manifests. Good pattern. No issues.

---

## 8. Porter YAML audit

After LiveKit removal, all deployments should use `Dockerfile.porter` (or `Dockerfile.stress` for Doppler-injected environments).

### Current state

| File                               | Dockerfile          | Run command                    | Status                                       |
| ---------------------------------- | ------------------- | ------------------------------ | -------------------------------------------- |
| `porter.yaml`                      | Dockerfile.livekit  | `./start.sh`                   | **Fix** → Dockerfile.porter, `bun run start` |
| `porter-livekit.yaml`              | Dockerfile.livekit  | `./start.sh`                   | **Delete**                                   |
| `porter-2cpu.yaml`                 | Dockerfile.livekit  | `./start.sh`                   | **Delete** (or fix → Dockerfile.porter)      |
| `porter-stress.yaml`               | Dockerfile.stress   | `doppler run -- bun run start` | OK                                           |
| `porter-us-west.yaml`              | Dockerfile.stress   | `doppler run -- bun run start` | OK                                           |
| `porter-us-east.yaml`              | Dockerfile.stress   | `doppler run -- bun run start` | OK                                           |
| `porter/porter-captions.yaml`      | Dockerfile.captions | —                              | OK                                           |
| `porter/porter-captions copy.yaml` | Dockerfile.livekit  | `./start.sh`                   | **Delete** (stale copy)                      |

### Target state (after this PR)

| File                          | Dockerfile          | Run command                                  |
| ----------------------------- | ------------------- | -------------------------------------------- |
| `porter.yaml`                 | Dockerfile.porter   | `cd packages/cloud && PORT=80 bun run start` |
| `porter-stress.yaml`          | Dockerfile.stress   | `doppler run -- bun run start`               |
| `porter-us-west.yaml`         | Dockerfile.stress   | `doppler run -- bun run start`               |
| `porter-us-east.yaml`         | Dockerfile.stress   | `doppler run -- bun run start`               |
| `porter/porter-captions.yaml` | Dockerfile.captions | (unchanged)                                  |

---

## 9. Hono route for app-communication (§9)

The Hono version at `api/hono/routes/app-communication.routes.ts` is 130 lines that returns an empty array with a TODO comment saying the feature is deprecated. It's mounted in `hono-app.ts`.

**Delete the file and remove the route mount.** The SDK is removing all app-to-app APIs (see maintainability §9).

---

## Implementation Order

These deletions have no interdependencies except that Express deletion (§2) subsumes some LiveKit Express files. Recommended order:

### Step 1 — LiveKit removal

Highest CI/build impact. Eliminates the entire Go build stage from Docker, cutting deploy image build time by ~2-3 minutes.

1. Delete `packages/cloud-livekit-bridge/`
2. Delete `packages/cloud/src/services/session/livekit/`
3. Delete LiveKit API files (both Express and Hono)
4. Delete `services/client/livekit.service.ts`
5. Edit UserSession, AudioManager, MicrophoneManager, bun-websocket, websocket-glasses.service, types
6. Edit hono-app.ts, api/hono/index.ts, api/hono/client/index.ts
7. Delete `docker/Dockerfile.livekit`, `start.sh`, `porter-livekit.yaml`, `porter-2cpu.yaml`, `porter/porter-captions copy.yaml`
8. Update `porter.yaml` to use Dockerfile.porter
9. Update deploy workflows (porter-dev.yml, porter-debug.yml)
10. Remove npm deps: `@livekit/rtc-node`, `livekit-server-sdk`, `@grpc/grpc-js`, `@grpc/proto-loader`

### Step 2 — Express mass delete

Largest line-count reduction.

1. Delete `packages/cloud/src/routes/` (entire directory)
2. Delete `packages/cloud/src/api/index.ts`
3. Delete `packages/cloud/src/api/client/` (entire directory, minus docs/ if needed)
4. Delete `packages/cloud/src/api/console/` (entire directory)
5. Delete `packages/cloud/src/api/middleware/` (entire directory)
6. Delete `packages/cloud/src/index-express.ts`
7. Delete `packages/cloud/src/legacy-express.ts`
8. Remove Express deps from `packages/cloud/package.json`
9. Remove Express deps from root `package.json`

### Step 3 — Azure provider removal

1. Delete Azure transcription + translation providers
2. Edit TranscriptionManager and TranslationManager
3. Edit logger/posthog for AZURE_SPEECH_REGION references
4. Remove `microsoft-cognitiveservices-speech-sdk` dep

### Step 4 — App communication removal

1. Delete `api/hono/routes/app-communication.routes.ts`
2. Edit hono-app.ts to remove route mount

### Step 5 — package.json cleanup

1. Remove dead root deps: `ts-node`, `ts-node-dev`, `winston`, `@sentry/tracing`, `cookie-parser`, `express`
2. Remove dead root devDeps: `pm2`, `concurrently`
3. Remove dead cloud deps: `moment`, move `bun-types` to devDeps
4. Remove dead cloud devDeps: old ESLint stack, `husky`, `prettier`, `pretty-quick`
5. Remove Express-related overrides from both package.json files
6. Run `bun install` to regenerate lockfile

### Step 6 — Dockerfile updates

1. Add `display-utils` to build chain in Dockerfile.porter and Dockerfile.stress
2. Fix build order: types → display-utils → sdk → utils → cloud
3. (Deferred to Phase 2) Split `COPY . .` into dependency manifests + source for layer caching

---

## Risk Assessment

| Change            | Risk                                                                                                              | Mitigation                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| LiveKit removal   | **Low** — confirmed dead by `// we no longer use livekit` comment in AudioManager, no client sends `livekit=true` | grep for any mobile client references before merging       |
| Express deletion  | **Low** — `index.ts` (the real entry point) only imports Hono. Express files are orphans.                         | Verify `index.ts` has zero Express imports                 |
| Azure removal     | **Low** — Soniox is the only active provider. Azure env vars are not set in any Doppler config.                   | Confirm Doppler has no `AZURE_SPEECH_*` vars               |
| App communication | **None** — returns empty array, feature deprecated                                                                | —                                                          |
| Dep cleanup       | **Low** — all confirmed zero imports                                                                              | Run `bun install && bun run build` after removal to verify |

---

## Expected Impact

- **Docker image size:** -50+ MB (microsoft-cognitiveservices-speech-sdk alone is ~50 MB, plus Go binary + deps)
- **Docker build time:** -2-3 min (no more Go compilation stage)
- **`bun install` time:** Faster (fewer deps to resolve/download)
- **Codebase size:** ~13,800 fewer lines of dead code
- **Cognitive load:** No more "is this the Express version or the Hono version?" confusion
- **Dep surface area:** ~31 fewer packages to audit for CVEs
