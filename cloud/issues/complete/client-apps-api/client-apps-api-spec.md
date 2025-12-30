# Client Apps API Spec

## Overview

New `/api/client/apps` endpoint that returns minimal app data optimized for mobile client home screen display. Removes bloat from current `/api/apps` route which fetches unnecessary data (developer profiles, organization info, compatibility checks, uptime history).

## Problem

Current `/api/apps` endpoint is slow and bloated:

1. **Too many database queries**: Fetches user, apps, organizations, developer profiles, uptime records (5+ queries per request)
2. **Unnecessary data enrichment**: Compatibility checks, last active timestamps, organization details not needed for home screen
3. **External API calls**: Health checks and uptime status lookups add latency
4. **Response size**: 20+ fields per app when client needs 8
5. **Inconsistent types**: Mobile uses `AppletInterface`, cloud uses `AppI`, no shared type definitions

Evidence from `apps.routes.ts`:

- Lines 270-467: `getAllApps` does compatibility checks, developer profile enrichment, uptime status, session state enhancement
- Lines 1455-1530: `batchEnrichAppsWithProfiles` makes additional DB queries for organizations
- Response time: 500ms+ for 10 apps

### Constraints

- Must maintain backward compatibility with existing `/api/apps` endpoints (store, console still use them)
- Mobile client expects specific field names (`logoURL`, `webviewURL`, `is_running`, `loading`)
- Health status check must be fast (<50ms) or skipped
- Cannot break existing app lifecycle (install/uninstall/start/stop)

## Goals

### Primary

1. Return apps list in <100ms (5x faster than current)
2. Minimal response: 8 fields per app (packageName, name, webviewUrl, logoUrl, type, permissions, running, healthy)
3. Single focused service method without bloat
4. Shared type package for mobile/cloud consistency

### Secondary

1. Remove hardware compatibility checks from list endpoint (move to detail view)
2. Remove developer profile enrichment from list endpoint
3. Cache health status per session (avoid repeated checks)

### Success Metrics

| Metric         | Current | Target | Measure           |
| -------------- | ------- | ------ | ----------------- |
| Response time  | 500ms   | <100ms | Server logs       |
| Response size  | ~10KB   | ~2KB   | Network inspector |
| DB queries     | 5+      | 2      | Query count logs  |
| Fields per app | 20+     | 8      | Response schema   |

## Non-Goals

- Not replacing other `/api/apps/*` endpoints (only list endpoint)
- Not changing app lifecycle operations (start/stop/install/uninstall)
- Not refactoring entire app.service.ts now (only what's needed)
- Not implementing real-time health monitoring (use cached status)

## API Contract

### Request

```
GET /api/client/apps
Headers:
  Authorization: Bearer <JWT>
```

### Response

```json
{
  "success": true,
  "data": [
    {
      "packageName": "com.example.app",
      "name": "Example App",
      "webviewUrl": "https://app.example.com",
      "logoUrl": "https://cdn.example.com/logo.png",
      "type": "standard",
      "permissions": [
        { "type": "MICROPHONE", "description": "For voice commands" }
      ],
      "running": true,
      "healthy": true
    }
  ],
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Field Definitions

- `packageName`: Unique app identifier (string)
- `name`: Display name (string)
- `webviewUrl`: Mobile webview URL (string, optional for offline apps)
- `logoUrl`: App icon URL (string)
- `type`: "standard" | "background" | "system_dashboard"
- `permissions`: Array of permission objects
- `running`: Currently active in session (boolean)
- `healthy`: Last health check passed (boolean)

## Implementation Requirements

1. **New shared types package**: `packages/types/` → `@mentra/types`
   - Export `AppletInterface`, `AppletType`, `AppletPermission`, `HardwareRequirement`, `HardwareType`, `Capabilities`
   - Used by both mobile and cloud
   - Bun workspace package

2. **New service**: `packages/cloud/src/services/client/apps.service.ts`
   - `getAppsForHomeScreen(userId: string): Promise<AppletInterface[]>`
   - Fetch installed apps from user document
   - Fetch app details from App collection
   - Enrich with session state (running/loading)
   - Add cached health status (no external calls)
   - Return minimal interface

3. **New API route**: `packages/cloud/src/api/client/client.apps.api.ts`
   - Single GET handler
   - Use `clientAuthWithEmail` middleware
   - Delegate to service
   - Return consistent response envelope

4. **Type migration**:
   - Move from `@mentra/sdk/types` to `@mentra/types`:
     - `Capabilities`, `HardwareRequirement`, `HardwareType`, `HardwareRequirementLevel`
   - Mobile already has `AppletInterface` - move to shared package
   - Cloud `AppI` stays in model (internal only)
   - New service returns `AppletInterface` (client-facing)

## Open Questions

1. **Health check strategy**:
   - Option A: Return last known status from AppUptimeService (fast, may be stale)
   - Option B: Skip health status entirely in list view (fetch on demand)
   - **Decision**: Use cached status from session if available, otherwise null

2. **Offline apps**:
   - Should they appear in this endpoint or separate?
   - **Decision**: Include them, mark with `isOffline: true`, `webviewUrl` optional

3. **Background apps**:
   - Filter out or include in home screen list?
   - **Decision**: Include all installed apps, client filters by type

4. **Shared types package structure**:
   - Separate repo or monorepo package?
   - **Decision**: Monorepo package under `packages/types/`, Bun workspace

## Migration Strategy

1. Create `@mentra/types` package (no dependencies on SDK)
2. Move types from SDK → types package
3. Update SDK to re-export from types (backward compat)
4. Create new service + API route
5. Test with mobile client (parallel to old endpoint)
6. Switch mobile to use new endpoint
7. Monitor performance for 1 week
8. Deprecate old endpoint usage in mobile
9. Keep old endpoint for store/console (separate migration)

## Validation

Before marking complete:

- [ ] Response time <100ms (95th percentile)
- [ ] Response size ~2KB for 10 apps
- [ ] Mobile home screen renders with new endpoint
- [ ] No regressions in app start/stop/install/uninstall
- [ ] Types shared between mobile and cloud
- [ ] Old endpoint still works for store/console
