# SDK Hono Merge Spec

## Overview

Merge all `dev` bug fixes (Jan 1–Jan 29) into the `cloud/sdk-hono` branch so the Hono-based SDK has feature parity with the Express-based SDK before replacing it.

## Problem

The Express→Hono SDK refactor (`cloud/sdk-hono`) diverged from `dev` on Jan 1 at commit `8dc12aaec` (the LC3 merge). Since then, `dev` accumulated 14 commits touching `cloud/packages/sdk/` — critical bug fixes for photo capture, session lifecycle, and reconnection resilience. These fixes landed on the Express version of the same files the Hono branch rewrote.

Specific issues on `dev` not on Hono:

1. **Photo requests stored per-session died on reconnect** — moved to AppServer level for O(1 lookup + reconnection survival (issue 019)
2. **Zombie sessions from clean WebSocket closures** — codes 1000/1001 weren't treated as permanent, leaving dead sessions in `activeSessions` forever
3. **Disposed AppSession resurrection crash** — `Cannot track resources on a disposed ResourceTracker` when cloud tried to reuse a disposed session (issue 023)
4. **Multi-cloud session corruption** — old session cleanup handler deleting newer session's map entries (issue 018)
5. **cleanup() sending OWNERSHIP_RELEASE on restart** — prevented cloud from resurrecting apps after SDK restart/redeploy
6. **Missing types** — silent photo mode, UDP audio encryption, timezone/userTimezone, PreviewImage, PhotoOrientation

### Constraints

- The Hono branch already had partial ports: photo reconnection (`c97fe69c6`) and some type fixes (`0892d3362`), creating duplicate code paths
- `server/index.ts` is the most-changed file on both sides: 876 lines (Hono) vs 1022 lines (dev), with completely different import/middleware/routing patterns
- `git merge` produced 30+ conflicts in `server/index.ts` alone — no auto-resolution possible
- The SDK is published to npm as `@mentra/sdk` — broken types or missing exports break downstream apps

## Goals

1. **Merge `dev` into `cloud/sdk-hono`** with all conflicts resolved correctly
2. **Keep Hono architecture**: `extends Hono`, `c.json()`, `c.req.json()`, `c.req.parseBody()`, `serveStatic` from `hono/bun`, no Express/multer/cookie-parser
3. **Port all dev bug fix logic**: OWNERSHIP_RELEASE flow, wasClean check, identity-safe cleanup, photo management APIs with logging, disposed session detection
4. **Port all dev type additions**: silent photo, UDP encryption, timezone, PreviewImage, PhotoOrientation, CUSTOM_MESSAGE deprecation
5. **Deduplicate photo management APIs** — Hono branch had two `PendingPhotoRequest` interfaces and two sets of methods; consolidate to one
6. **SDK builds and types compile** — `bun run build` and `tsc --noEmit` pass
7. **Bump version to `3.0.0-hono.3`**

## Non-Goals

- Rewriting session/index.ts or events.ts for Hono patterns (they're framework-agnostic, auto-merged cleanly)
- Changing the cloud server to use the Hono SDK (that's a separate deployment step)
- Writing new tests (existing test coverage carries over)
- Migrating any Express-using apps to the Hono API (backward compat via deprecated `getExpressApp()`)

## Commits Ported (dev → Hono)

| Commit | Date | Description | Files |
|--------|------|-------------|-------|
| `8f034b4` | Jan 2 | App disconnect resurrection + multi-cloud | `server/index.ts` |
| `491caec` | Jan 3 | Photo requests to AppServer level | `server/index.ts`, `camera.ts` |
| `5e0c33c` | Jan 3 | Clean WebSocket closures as permanent | `server/index.ts` |
| `fc4f602` | Jan 3 | Disposed AppSession resurrection fix | `server/index.ts` |
| `3db4d53` | Jan 5 | Reconnection spiral debug logs | `server/index.ts` |
| `cc30136` | Jan 6 | Silent photo mode type | `types/messages/cloud-to-glasses.ts` |
| `344f6fa` | Jan 7 | Image preview upload for webview | webview files |
| `b9a0a4a` | Jan 7 | Image upload setup for preview | webview files |
| `c6adcb9` | Jan 19 | DisplayProcessor + @mentra/display-utils | `package.json`, `display-utils.ts`, `tsconfig.json` |
| `6bab5b9` | Jan 27 | UDP audio encryption types | `types/messages/` |
| `825e127` | Jan 27 | Simplify UDP encryption to symmetric key | `types/messages/` |
| `eac608f` | Jan 29 | Timezone handling + deprecate CUSTOM_MESSAGE | `session/events.ts`, `types/` |

## Open Questions

1. **When to publish 3.0.0-hono.3?**
   - After build verification and manual testing of photo + reconnection flows
   - Publish as pre-release tag first (`npm publish --tag hono`)

2. **When to make Hono the default SDK?**
   - After at least one app (LiveCaptionsOnSmartGlasses or MentraAI) runs on it in production for a week
   - Then merge `cloud/sdk-hono` → `dev` and publish as `3.0.0`
