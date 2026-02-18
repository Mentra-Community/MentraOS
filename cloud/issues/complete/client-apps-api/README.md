# Client Apps API Refactor

Fast, focused endpoint for mobile client to fetch apps for home screen display.

## Documents

- **client-apps-api-spec.md** - Problem, goals, constraints
- **client-apps-api-architecture.md** - Technical design and implementation
- **types-package-guide.md** - Step-by-step setup for `@mentra/types`
- **bun-export-pattern.md** - Bun-compatible export patterns (quick reference)
- **example-implementation.md** - Complete code examples (copy-paste ready)
- **SDK-BUNDLING-SETUP.md** - How SDK bundles workspace dependencies with Bun

## Quick Context

**Current**: `/api/apps` route has massive bloat - fetching developer profiles, compatibility checks, session state, uptime status, organization data. Response takes 500ms+ with 20+ fields client doesn't need for home screen.

**Proposed**: New `/api/client/apps` endpoint returns minimal interface (8 fields) optimized for home screen display. Fast, focused, no slop.

## Key Context

Mobile client needs simple list of apps with running state, health status, and basic metadata. Current endpoint does database joins, external API calls, and complex compatibility checks that aren't needed for initial home screen render.

New endpoint fetches only what's needed: packageName, name, webviewUrl, logoUrl, type, permissions, running state, and health status. Everything else is bloat.

## Status

- [x] Create shared types package `@mentra/types` (with Bun-compatible exports)
- [x] Verify Bun runtime: `bun run packages/types/src/index.ts` (no errors)
- [x] Create `packages/cloud/src/api/client/client.apps.api.ts`
- [x] Create `packages/cloud/src/services/client/apps.service.ts`
- [x] Wire up new endpoint in `packages/cloud/src/api/index.ts`
- [x] Add `appHealthCache` to UserSession
- [x] Test import: `import { AppletInterface } from '@mentra/types'` works
- [x] Configure SDK to use Bun bundler (inlines `@mentra/types`)
- [x] Verify SDK bundling: No `@mentra/types` references in `dist/` ✅
- [ ] Test endpoint with real data (start cloud server)
- [ ] Update mobile client to use new endpoint
- [ ] Compare old vs new endpoint responses
- [ ] Migrate types from SDK to `@mentra/types` gradually
- [ ] Deprecate old endpoint usage in mobile

## Key Metrics

| Metric          | Current | Target |
| --------------- | ------- | ------ |
| Response time   | 500ms+  | <100ms |
| Fields returned | 20+     | 8      |
| DB queries      | 5+      | 2      |
| Response size   | ~10KB   | ~2KB   |

## Key Technical Decisions

1. **Bun-compatible exports**: Uses explicit `export type` syntax (not `export *`) to avoid runtime issues with type re-exports. See `bun-export-pattern.md` and `cloud/issues/todo/sdk-type-exports/` for details.

2. **Minimal interface**: Only 9 fields returned (packageName, name, webviewUrl, logoUrl, type, permissions, running, healthy, hardwareRequirements).

3. **Session-level caching**: Health status cached in-memory to avoid external API calls on every request.

4. **SDK bundling**: SDK uses Bun bundler to inline `@mentra/types` at build time, creating self-contained published packages. See `SDK-BUNDLING-SETUP.md` for details.
