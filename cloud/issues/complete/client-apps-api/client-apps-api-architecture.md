# Client Apps API Architecture

## Current System

### Request Flow (apps.routes.ts)

```
Client → /api/apps?userId=X
  ↓
unifiedAuthMiddleware (67-217)
  ↓
getAllApps handler (270-467)
  ↓
appService.getAllApps(userId)
  ↓
batchEnrichAppsWithProfiles (1455-1530)
  ↓
enhanceAppsWithSessionState (1537-1571)
  ↓
HardwareCompatibilityService.checkCompatibility
  ↓
AppUptimeService.getLatestStatusesForPackages
  ↓
Response: 20+ fields per app
```

### Current Database Queries

1. `User.findOne({ email: userId })` - Get user's installed apps
2. `App.find({ packageName: { $in: installedApps } })` - Fetch app details
3. `Organization.find({ _id: { $in: orgIds } })` - Get org profiles (per app)
4. `User.findOne({ email: developerId })` - Get developer profiles (per app)
5. `AppUptime.aggregate([...])` - Get health status (per app)

Total: 2 + (3 × N apps) queries

### Problems with Current Implementation

**File**: `cloud/packages/cloud/src/routes/apps.routes.ts`

```typescript
// Lines 270-467: getAllApps does everything
async function getAllApps(req: Request, res: Response) {
  // 1. Hardware compatibility checks (not needed for list)
  const compatibilityResult = HardwareCompatibilityService.checkCompatibility(
    app,
    caps,
  );

  // 2. Developer profile enrichment (not needed for list)
  finalApps = await batchEnrichAppsWithProfiles(enhancedApps);

  // 3. Uptime status (adds latency)
  const latestStatuses =
    await AppUptimeService.getLatestStatusesForPackages(packageNames);

  // 4. Organization lookups (not needed for list)
  const organizations = await Organization.find({ _id: { $in: orgIds } });

  // Returns: 20+ fields including compatibility, developerProfile, isOnline, etc.
}
```

**Latency breakdown** (measured):

- DB queries: 200-300ms
- Compatibility checks: 50-100ms
- Profile enrichment: 100-150ms
- Uptime checks: 50-100ms
- **Total: 500-650ms**

## Proposed System

### New Request Flow

```
Client → /api/client/apps
  ↓
clientAuthWithEmail middleware
  ↓
getAppsForHomeScreen handler
  ↓
ClientAppsService.getAppsForHomeScreen(userId)
  ↓
Response: 8 fields per app
```

### New Service Layer

**File**: `cloud/packages/cloud/src/services/client/apps.service.ts`

```typescript
import { AppletInterface } from "@mentra/types";
import { User } from "../../models/user.model";
import App from "../../models/app.model";
import UserSession from "../session/UserSession";
import { logger } from "../logging/pino-logger";

export class ClientAppsService {
  /**
   * Get minimal app list for home screen display
   * Fast, focused, no bloat
   */
  static async getAppsForHomeScreen(
    userId: string,
  ): Promise<AppletInterface[]> {
    // 1. Get user's installed apps (single query)
    const user = await User.findOne({ email: userId })
      .select("installedApps")
      .lean();

    if (!user?.installedApps?.length) {
      return [];
    }

    const packageNames = user.installedApps.map((a) => a.packageName);

    // 2. Fetch app details (single query, only needed fields)
    const apps = await App.find({ packageName: { $in: packageNames } })
      .select("packageName name logoURL webviewURL appType permissions")
      .lean();

    // 3. Get session state (in-memory, fast)
    const session = UserSession.getById(userId);
    const runningApps = session?.runningApps || new Set();
    const loadingApps = session?.loadingApps || new Set();

    // 4. Get cached health status (in-memory, no external calls)
    const healthCache = session?.appHealthCache || new Map();

    // 5. Map to minimal interface
    return apps.map((app) => ({
      packageName: app.packageName,
      name: app.name,
      webviewUrl: app.webviewURL || "",
      logoUrl: app.logoURL,
      type: app.appType as "standard" | "background",
      permissions: app.permissions || [],
      running: runningApps.has(app.packageName),
      healthy: healthCache.get(app.packageName) ?? true,
      hardwareRequirements: app.hardwareRequirements || [],
    }));
  }
}
```

### New API Route

**File**: `cloud/packages/cloud/src/api/client/client.apps.api.ts`

```typescript
// /api/client/apps
// Returns minimal app list for mobile home screen

import { Router, Request, Response } from "express";
import { ClientAppsService } from "../../services/client/apps.service";
import {
  clientAuthWithEmail,
  RequestWithEmail,
} from "../middleware/client.middleware";
import { logger } from "../../services/logging/pino-logger";

const router = Router();

// GET /api/client/apps
router.get("/", clientAuthWithEmail, getApps);

async function getApps(req: Request, res: Response) {
  const { email } = req as RequestWithEmail;

  try {
    const apps = await ClientAppsService.getAppsForHomeScreen(email);

    res.json({
      success: true,
      data: apps,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error({ error, email }, "Failed to fetch apps for home screen");

    res.status(500).json({
      success: false,
      message: "Failed to fetch apps",
      timestamp: new Date(),
    });
  }
}

export default router;
```

## Shared Types Package

### Directory Structure

```
cloud/packages/types/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # Main export (explicit type exports for Bun)
│   ├── applet.ts          # AppletInterface, AppletType, AppletPermission
│   ├── hardware.ts        # HardwareRequirement, HardwareType, Capabilities
│   └── enums.ts           # Shared enums
└── README.md
```

**Note**: All exports in `index.ts` use explicit `export type` syntax (not `export *`) to ensure Bun can execute TypeScript directly in development without runtime errors. See `cloud/issues/todo/sdk-type-exports/README.md` for details.

### Package Configuration

**File**: `cloud/packages/types/package.json`

```json
{
  "name": "@mentra/types",
  "version": "1.0.0",
  "description": "Shared TypeScript types for MentraOS",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    "development": {
      "import": "./src/index.ts",
      "require": "./src/index.ts",
      "types": "./src/index.ts"
    },
    "default": {
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "rm -rf dist && bun x tsc -p tsconfig.json",
    "dev": "bun x tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### Type Definitions

**File**: `cloud/packages/types/src/applet.ts`

```typescript
export type AppletType = "standard" | "background" | "system_dashboard";

export type AppPermissionType =
  | "ALL"
  | "MICROPHONE"
  | "CAMERA"
  | "CALENDAR"
  | "LOCATION"
  | "BACKGROUND_LOCATION"
  | "READ_NOTIFICATIONS"
  | "POST_NOTIFICATIONS";

export interface AppletPermission {
  type: AppPermissionType;
  description?: string;
  required?: boolean;
}

/**
 * Minimal app interface for client home screen
 * Optimized for fast rendering
 */
export interface AppletInterface {
  packageName: string;
  name: string;
  webviewUrl: string;
  logoUrl: string;
  type: AppletType;
  permissions: AppletPermission[];
  running: boolean;
  healthy: boolean;
  hardwareRequirements: HardwareRequirement[];
}
```

**File**: `cloud/packages/types/src/hardware.ts`

```typescript
export enum HardwareType {
  CAMERA = "CAMERA",
  DISPLAY = "DISPLAY",
  MICROPHONE = "MICROPHONE",
  SPEAKER = "SPEAKER",
  IMU = "IMU",
  BUTTON = "BUTTON",
  LIGHT = "LIGHT",
  WIFI = "WIFI",
}

export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED",
  OPTIONAL = "OPTIONAL",
}

export interface HardwareRequirement {
  type: HardwareType;
  level: HardwareRequirementLevel;
  description?: string;
}

export interface Capabilities {
  modelName: string;
  hasCamera: boolean;
  hasDisplay: boolean;
  hasMicrophone: boolean;
  hasSpeaker: boolean;
  hasIMU: boolean;
  hasButton: boolean;
  hasLight: boolean;
  hasWifi: boolean;
  // Detailed capabilities omitted for brevity
}
```

**File**: `cloud/packages/types/src/index.ts`

```typescript
/**
 * @mentra/types - Shared types for MentraOS
 *
 * IMPORTANT: Uses explicit exports for Bun compatibility
 * DO NOT use `export *` - Bun runtime can't handle type re-exports
 * See: cloud/issues/todo/sdk-type-exports/README.md
 */

// Enums (runtime values)
export { HardwareType, HardwareRequirementLevel } from "./enums";

// Hardware types (type-only exports)
export type { HardwareRequirement, Capabilities } from "./hardware";

// Applet types (type-only exports)
export type {
  AppletType,
  AppPermissionType,
  AppletPermission,
  AppletInterface,
} from "./applet";
```

### Workspace Integration

**File**: `cloud/package.json` (root)

```json
{
  "workspaces": ["packages/*"],
  "dependencies": {
    "@mentra/sdk": "workspace:*",
    "@mentra/types": "workspace:*"
  }
}
```

## Migration Plan

### Phase 1: Create Shared Types Package

1. Create `packages/types/` directory structure
2. Add `package.json` and `tsconfig.json`
3. Copy types from SDK: `HardwareType`, `HardwareRequirement`, `Capabilities`
4. Copy types from mobile: `AppletInterface`, `AppletPermission`
5. Build package: `cd packages/types && bun run build`
6. Verify workspace link: `bun install`

### Phase 2: Update SDK and Mobile

1. SDK: Import from `@mentra/types` and re-export (backward compat, explicit exports)

   ```typescript
   // packages/sdk/src/types/index.ts
   // Use explicit exports for Bun compatibility

   // Enums (runtime values)
   export { HardwareType, HardwareRequirementLevel } from "@mentra/types";

   // Types (type-only exports)
   export type { HardwareRequirement, Capabilities } from "@mentra/types";

   // SDK-specific types (also explicit)
   export type { AppI, DeveloperProfile, Permission } from "./models";
   export type { WebhookRequest, WebhookResponse } from "./webhooks";
   ```

2. Mobile: Import from `@mentra/types`
   ```typescript
   // mobile/src/types/AppletTypes.ts
   export { AppletInterface, AppletPermission } from "@mentra/types";
   ```

### Phase 3: Create New Service and API

1. Create `services/client/apps.service.ts`
2. Implement `getAppsForHomeScreen()`
3. Create `api/client/client.apps.api.ts`
4. Mount in `api/index.ts`:
   ```typescript
   app.use("/api/client/apps", clientAppsApi);
   ```

### Phase 4: Test and Validate

1. Verify Bun compatibility:

   ```bash
   cd packages/types
   bun run src/index.ts  # Should not error
   bun run build         # Should compile
   ```

2. Test endpoint with curl:

   ```bash
   curl -H "Authorization: Bearer $JWT" \
     http://localhost:8002/api/client/apps
   ```

3. Measure response time (target: <100ms)
4. Verify response size (target: ~2KB for 10 apps)
5. Test mobile client integration

### Phase 5: Deploy and Monitor

1. Deploy to staging
2. Switch mobile to new endpoint (feature flag)
3. Monitor metrics for 1 week
4. Gradual rollout to production
5. Deprecate old endpoint usage in mobile

## Performance Comparison

### Before (Current /api/apps)

- **DB Queries**: 5+ queries per request
- **Response Time**: 500-650ms
- **Response Size**: ~10KB (10 apps)
- **Fields**: 20+ per app

### After (New /api/client/apps)

- **DB Queries**: 2 queries total
- **Response Time**: 50-100ms (5-10x faster)
- **Response Size**: ~2KB (10 apps) (5x smaller)
- **Fields**: 8 per app

### Latency Breakdown (New)

- DB query 1 (user): 20ms
- DB query 2 (apps): 30ms
- Session state: 1ms (in-memory)
- Health cache: 1ms (in-memory)
- Mapping: 5ms
- **Total: ~60ms**

## Backward Compatibility

### Existing Endpoints (Unchanged)

- `/api/apps` - Keep for store/console
- `/api/apps/public` - Store catalog
- `/api/apps/installed` - Legacy mobile endpoint
- `/api/apps/:pkg/start` - App lifecycle
- `/api/apps/:pkg/stop` - App lifecycle
- `/api/apps/install/:pkg` - Install flow
- `/api/apps/uninstall/:pkg` - Uninstall flow

### Migration Strategy

1. New endpoint runs in parallel
2. Mobile switches gradually (feature flag)
3. Old endpoint stays for store/console
4. No breaking changes to existing flows

## Health Status Caching

### Session-Level Cache

```typescript
// In UserSession class
class UserSession {
  private appHealthCache = new Map<string, boolean>();
  private lastHealthCheck = new Map<string, number>();
  private readonly HEALTH_CACHE_TTL = 60_000; // 1 minute

  async updateHealthStatus(packageName: string): Promise<void> {
    const now = Date.now();
    const lastCheck = this.lastHealthCheck.get(packageName) || 0;

    // Skip if checked recently
    if (now - lastCheck < this.HEALTH_CACHE_TTL) {
      return;
    }

    try {
      const healthy = await checkAppHealth(packageName);
      this.appHealthCache.set(packageName, healthy);
      this.lastHealthCheck.set(packageName, now);
    } catch (error) {
      // On error, assume unhealthy
      this.appHealthCache.set(packageName, false);
    }
  }
}
```

## Testing Plan

### Unit Tests

1. `ClientAppsService.getAppsForHomeScreen()`
   - With installed apps → returns apps
   - With no apps → returns empty array
   - With invalid userId → returns empty array

2. Type exports from `@mentra/types`
   - Import in mobile works
   - Import in cloud works
   - TypeScript compilation succeeds

### Integration Tests

1. Endpoint response format
2. Auth middleware protection
3. Response time <100ms
4. Error handling

### Load Tests

1. 100 concurrent requests → <100ms p95
2. 1000 requests/sec → <150ms p95
3. Memory usage stable

## Rollback Plan

If issues arise:

1. Feature flag off in mobile → revert to old endpoint
2. No database migrations needed
3. New endpoint can be disabled without impact
4. Shared types package backward compatible (SDK re-exports)

## Open Questions

1. **Cache invalidation**: When to clear health cache?
   - On app stop/crash
   - After 1 minute TTL
   - On explicit health check failure

2. **Offline apps**: Include in list or separate endpoint?
   - **Decision**: Include, mark with `isOffline: true`

3. **Background apps**: Show on home screen?
   - **Decision**: Include all, client filters by type

4. **Hardware requirements**: Include in minimal interface?
   - **Decision**: Yes, needed for compatibility icon badge

## Summary

New `/api/client/apps` endpoint provides:

- **Fast**: <100ms response (5-10x faster)
- **Focused**: 8 fields per app (not 20+)
- **Clean**: Shared types between mobile/cloud
- **Safe**: Parallel deployment, no breaking changes
- **Scalable**: In-memory caching, minimal DB queries
- **Bun-compatible**: Explicit type exports, no runtime issues

Achieves goal: focused, faster, less slop endpoint for home screen display.

## Bun Compatibility Notes

The `@mentra/types` package uses explicit `export type` syntax instead of `export *` to avoid Bun runtime issues with type re-exports. This allows us to:

- Use TypeScript source directly in development (`src/`)
- Skip rebuild steps during development
- Avoid the issues documented in `cloud/issues/todo/sdk-type-exports/`

**Pattern:**

```typescript
// ❌ Don't do this (Bun runtime errors)
export * from "./types";

// ✅ Do this (Bun-compatible)
export type { MyType, MyInterface } from "./types";
export { MyEnum, myFunction } from "./types";
```
