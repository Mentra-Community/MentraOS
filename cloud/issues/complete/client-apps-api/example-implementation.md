# Example Implementation

Complete code examples for the client apps API refactor.

## File Structure

```
cloud/packages/types/              # New shared types package
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                   # Main export (Bun-compatible)
    ├── enums.ts                   # Runtime enums
    ├── hardware.ts                # Hardware types
    └── applet.ts                  # Applet types

cloud/packages/cloud/src/
├── api/
│   └── client/
│       └── client.apps.api.ts     # New endpoint
└── services/
    └── client/
        └── apps.service.ts        # New service
```

## 1. Create @mentra/types Package

### packages/types/package.json

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
    "dev": "bun x tsc --watch",
    "typecheck": "bun x tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "files": ["dist"]
}
```

### packages/types/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### packages/types/src/enums.ts

```typescript
/**
 * Hardware component types
 * These are enums (runtime values)
 */
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

/**
 * Hardware requirement levels
 */
export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED",
  OPTIONAL = "OPTIONAL",
}
```

### packages/types/src/hardware.ts

```typescript
import { HardwareType, HardwareRequirementLevel } from "./enums";

/**
 * Hardware requirement for an app
 */
export interface HardwareRequirement {
  type: HardwareType;
  level: HardwareRequirementLevel;
  description?: string;
}

/**
 * Device hardware capabilities
 * Minimal version for client apps API
 */
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
}
```

### packages/types/src/applet.ts

```typescript
import { HardwareRequirement } from "./hardware";

/**
 * App execution model
 */
export type AppletType = "standard" | "background" | "system_dashboard";

/**
 * Permission types apps can request
 */
export type AppPermissionType =
  | "ALL"
  | "MICROPHONE"
  | "CAMERA"
  | "CALENDAR"
  | "LOCATION"
  | "BACKGROUND_LOCATION"
  | "READ_NOTIFICATIONS"
  | "POST_NOTIFICATIONS";

/**
 * Permission object
 */
export interface AppletPermission {
  type: AppPermissionType;
  description?: string;
  required?: boolean;
}

/**
 * Minimal app interface for client home screen
 * Optimized for fast rendering - only 8 fields
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

### packages/types/src/index.ts

```typescript
/**
 * @mentra/types - Shared types for MentraOS
 *
 * IMPORTANT: Uses explicit exports for Bun compatibility
 * DO NOT use `export *` - Bun runtime can't handle type re-exports
 * See: cloud/issues/todo/sdk-type-exports/README.md
 */

// Enums (runtime values) - use regular export
export { HardwareType, HardwareRequirementLevel } from "./enums";

// Types/Interfaces (no runtime) - use export type
export type { HardwareRequirement, Capabilities } from "./hardware";

export type {
  AppletType,
  AppPermissionType,
  AppletPermission,
  AppletInterface,
} from "./applet";
```

## 2. Build and Link Package

```bash
# Build the types package
cd cloud/packages/types
bun run build

# Verify Bun compatibility
bun run src/index.ts  # Should output nothing (no errors)

# Link in workspace
cd ../..
bun install
```

## 3. Create Client Apps Service

### packages/cloud/src/services/client/apps.service.ts

```typescript
import { AppletInterface } from "@mentra/types";
import { User } from "../../models/user.model";
import App from "../../models/app.model";
import UserSession from "../session/UserSession";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "ClientAppsService" });

export class ClientAppsService {
  /**
   * Get minimal app list for home screen display
   * Fast, focused, no bloat
   *
   * Performance targets:
   * - Response time: <100ms
   * - DB queries: 2 (user + apps)
   * - Fields: 8 per app
   */
  static async getAppsForHomeScreen(
    userId: string,
  ): Promise<AppletInterface[]> {
    try {
      // 1. Get user's installed apps (single query, minimal fields)
      const user = await User.findOne({ email: userId })
        .select("installedApps")
        .lean();

      if (!user?.installedApps?.length) {
        logger.debug({ userId }, "No installed apps found");
        return [];
      }

      const packageNames = user.installedApps.map((a) => a.packageName);

      // 2. Fetch app details (single query, only needed fields)
      const apps = await App.find({ packageName: { $in: packageNames } })
        .select(
          "packageName name logoURL webviewURL appType permissions hardwareRequirements",
        )
        .lean();

      if (!apps.length) {
        logger.warn({ userId, packageNames }, "No apps found in database");
        return [];
      }

      // 3. Get session state (in-memory, fast)
      const session = UserSession.getById(userId);
      const runningApps = session?.runningApps || new Set<string>();
      const loadingApps = session?.loadingApps || new Set<string>();

      // 4. Get cached health status (in-memory, no external calls)
      const healthCache = session?.appHealthCache || new Map<string, boolean>();

      // 5. Map to minimal interface
      const result: AppletInterface[] = apps.map((app) => ({
        packageName: app.packageName,
        name: app.name,
        webviewUrl: app.webviewURL || "",
        logoUrl: app.logoURL,
        type: app.appType as AppletInterface["type"],
        permissions: app.permissions || [],
        running: runningApps.has(app.packageName),
        healthy: healthCache.get(app.packageName) ?? true,
        hardwareRequirements: app.hardwareRequirements || [],
      }));

      logger.debug(
        { userId, count: result.length },
        "Fetched apps for home screen",
      );

      return result;
    } catch (error) {
      logger.error({ error, userId }, "Failed to fetch apps for home screen");
      throw error;
    }
  }
}
```

## 4. Create Client Apps API Route

### packages/cloud/src/api/client/client.apps.api.ts

```typescript
// /api/client/apps
// Minimal app list endpoint for mobile home screen
// Fast, focused, no bloat - <100ms response time

import { Router, Request, Response } from "express";
import { ClientAppsService } from "../../services/client/apps.service";
import {
  clientAuthWithEmail,
  RequestWithEmail,
} from "../middleware/client.middleware";
import { logger } from "../../services/logging/pino-logger";

const router = Router();

// GET /api/client/apps
// Returns minimal app list optimized for home screen display
router.get("/", clientAuthWithEmail, getApps);

/**
 * Get apps for home screen
 * Returns only essential fields: packageName, name, webviewUrl, logoUrl,
 * type, permissions, running, healthy, hardwareRequirements
 *
 * Performance: <100ms response time, ~2KB for 10 apps
 */
async function getApps(req: Request, res: Response) {
  const { email } = req as RequestWithEmail;
  const startTime = Date.now();

  try {
    const apps = await ClientAppsService.getAppsForHomeScreen(email);

    const duration = Date.now() - startTime;

    logger.debug(
      { email, count: apps.length, duration },
      "Apps fetched for home screen",
    );

    res.json({
      success: true,
      data: apps,
      timestamp: new Date(),
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      { error, email, duration },
      "Failed to fetch apps for home screen",
    );

    res.status(500).json({
      success: false,
      message: "Failed to fetch apps",
      timestamp: new Date(),
    });
  }
}

export default router;
```

## 5. Wire Up New Endpoint

### packages/cloud/src/api/index.ts

```typescript
import clientAppsApi from "./client/client.apps.api";

export function registerApi(app: Application) {
  // ... existing routes

  // New client apps endpoint
  app.use("/api/client/apps", clientAppsApi);

  // ... rest of routes
}
```

## 6. Update UserSession for Health Cache

### packages/cloud/src/services/session/UserSession.ts

```typescript
export default class UserSession {
  // ... existing properties

  // Health status cache (in-memory, per session)
  public appHealthCache = new Map<string, boolean>();
  private lastHealthCheck = new Map<string, number>();
  private readonly HEALTH_CACHE_TTL = 60_000; // 1 minute

  /**
   * Update health status for an app (with caching)
   */
  async updateHealthStatus(packageName: string): Promise<void> {
    const now = Date.now();
    const lastCheck = this.lastHealthCheck.get(packageName) || 0;

    // Skip if checked recently
    if (now - lastCheck < this.HEALTH_CACHE_TTL) {
      return;
    }

    try {
      // Your health check logic here
      const healthy = await this.checkAppHealth(packageName);
      this.appHealthCache.set(packageName, healthy);
      this.lastHealthCheck.set(packageName, now);
    } catch (error) {
      // On error, assume unhealthy
      this.appHealthCache.set(packageName, false);
    }
  }

  /**
   * Clear health cache for an app (e.g., on stop/crash)
   */
  clearHealthCache(packageName: string): void {
    this.appHealthCache.delete(packageName);
    this.lastHealthCheck.delete(packageName);
  }
}
```

## 7. Test the Endpoint

### Test with curl

```bash
# Get JWT token first
JWT="your-jwt-token"

# Test endpoint
curl -H "Authorization: Bearer $JWT" \
     http://localhost:8002/api/client/apps

# Expected response:
# {
#   "success": true,
#   "data": [
#     {
#       "packageName": "com.example.app",
#       "name": "Example App",
#       "webviewUrl": "https://app.example.com",
#       "logoUrl": "https://cdn.example.com/logo.png",
#       "type": "standard",
#       "permissions": [
#         { "type": "MICROPHONE", "description": "For voice commands" }
#       ],
#       "running": false,
#       "healthy": true,
#       "hardwareRequirements": [
#         { "type": "MICROPHONE", "level": "REQUIRED" }
#       ]
#     }
#   ],
#   "timestamp": "2024-01-15T10:30:00Z"
# }
```

### Test Bun compatibility

```bash
# Verify types package works with Bun runtime
cd packages/types
bun run src/index.ts  # Should output nothing (no errors)

# Verify TypeScript compilation
bun run build        # Should compile successfully
```

## 8. Update Mobile Client

### mobile/src/managers/RestComms.ts

```typescript
import { AppletInterface } from "@mentra/types";

class RestComms {
  /**
   * Fetch apps for home screen (new endpoint)
   */
  async getAppsForHomeScreen(): Promise<AppletInterface[]> {
    try {
      const response = await this.get<{ data: AppletInterface[] }>(
        "/api/client/apps",
      );
      return response.data;
    } catch (error) {
      console.error("Failed to fetch apps:", error);
      throw error;
    }
  }

  // Keep old method for backward compatibility during migration
  async getApps(): Promise<any[]> {
    const response = await this.get<{ data: any[] }>("/api/apps");
    return response.data;
  }
}
```

### mobile/src/types/AppletTypes.ts

```typescript
// Remove local definitions, import from shared package
export type {
  AppletInterface,
  AppletPermission,
  AppletType,
  AppPermissionType,
} from "@mentra/types";

// Keep mobile-specific utilities
export const isOfflineApp = (app: AppletInterface): boolean => {
  return app.isOffline === true;
};

export const getOfflineAppRoute = (app: AppletInterface): string | null => {
  if (!isOfflineApp(app)) return null;
  return app.offlineRoute || null;
};
```

## Performance Testing

### Load test script

```bash
#!/bin/bash
# test-apps-endpoint.sh

JWT="your-jwt-token"
ENDPOINT="http://localhost:8002/api/client/apps"

echo "Testing /api/client/apps performance..."

# Warm up
curl -s -H "Authorization: Bearer $JWT" $ENDPOINT > /dev/null

# Run 10 requests and measure time
TOTAL=0
COUNT=10

for i in $(seq 1 $COUNT); do
  START=$(date +%s%3N)
  curl -s -H "Authorization: Bearer $JWT" $ENDPOINT > /dev/null
  END=$(date +%s%3N)
  DURATION=$((END - START))
  TOTAL=$((TOTAL + DURATION))
  echo "Request $i: ${DURATION}ms"
done

AVG=$((TOTAL / COUNT))
echo "Average: ${AVG}ms (target: <100ms)"

if [ $AVG -lt 100 ]; then
  echo "✅ PASS: Performance target met"
  exit 0
else
  echo "❌ FAIL: Performance target not met"
  exit 1
fi
```

## Verification Checklist

- [ ] `@mentra/types` package created
- [ ] Bun test passes: `bun run packages/types/src/index.ts`
- [ ] Build passes: `cd packages/types && bun run build`
- [ ] ClientAppsService created in `services/client/apps.service.ts`
- [ ] Client apps API created in `api/client/client.apps.api.ts`
- [ ] Endpoint mounted in `api/index.ts`
- [ ] Health cache added to UserSession
- [ ] Mobile imports from `@mentra/types`
- [ ] Endpoint returns 8 fields per app
- [ ] Response time <100ms (95th percentile)
- [ ] Response size ~2KB for 10 apps
- [ ] No `export *` statements in types package
- [ ] All type exports use `export type { ... }`
- [ ] All value exports (enums) use `export { ... }`
