# Store Device Compatibility Implementation Plan

## Overview

Add device compatibility filtering to the MentraOS Store so users see which miniapps are compatible with their currently connected glasses. Incompatible apps are displayed in a separate section with a header indicating the device name.

## Current State

- **Backend**: `HardwareCompatibilityService` exists with full compatibility checking logic
- **Backend**: `UserSession` tracks connected device capabilities via `DeviceManager`
- **Backend**: Apps have `hardwareRequirements[]` with type and level (REQUIRED/OPTIONAL)
- **Frontend**: Store has no awareness of connected device or compatibility
- **Current UX**: Users see all apps; compatibility errors only appear at install time

## Target State

- Store API returns apps enriched with compatibility info
- Store API returns device info (modelName, connected status)
- Frontend displays compatible apps in main section
- Frontend displays incompatible apps in separate section: "Incompatible with [Device Name]"
- Individual app pages show compatibility warning banner when applicable

---

## Implementation Steps

### Phase 0: Backend - Fix Unknown Hardware Type Handling

**File**: `cloud/packages/cloud/src/services/session/HardwareCompatibilityService.ts`

Current behavior returns `false` for unknown hardware types (line 110-111). Change to return `true` with logging:

```typescript
private static checkHardwareAvailable(
  hardwareType: HardwareType,
  capabilities: Capabilities,
): boolean {
  switch (hardwareType) {
    // ... existing cases ...

    default:
      // Unknown hardware type - assume available (permissive), log for investigation
      console.warn(`[HardwareCompatibilityService] Unknown hardware type: ${hardwareType}, treating as available`);
      return true;
  }
}
```

---

### Phase 1: Backend - Add Compatibility to Store API

#### 1.1 Update `store.apps.api.ts` - Published Apps Endpoint

**File**: `cloud/packages/cloud/src/api/hono/store/store.apps.api.ts`

Modify `getPublishedAppsForUser()` handler:

```typescript
import { HardwareCompatibilityService } from "../../../services/session/HardwareCompatibilityService";

async function getPublishedAppsForUser(c: AppContext) {
  const email = c.get("email");
  const user = c.get("user");

  // ... existing validation ...

  const appsWithStatus = await storeService.getPublishedAppsForUser(user);
  const enrichedApps = await batchEnrichAppsWithProfiles(appsWithStatus);

  // NEW: Get device capabilities from user session
  const userSession = UserSession.getById(email);
  const capabilities = userSession?.getCapabilities() ?? null;
  const deviceName = userSession?.deviceManager.getModel() ?? null;
  const isConnected = userSession?.deviceManager.isGlassesConnected ?? false;

  // NEW: Add compatibility info to each app
  const appsWithCompatibility = enrichedApps.map(app => {
    const compatibility = HardwareCompatibilityService.checkCompatibility(app, capabilities);
    return { ...app, compatibility };
  });

  return c.json({
    success: true,
    data: appsWithCompatibility,
    deviceInfo: {
      connected: isConnected,
      modelName: deviceName
    }
  });
}
```

#### 1.2 Update `store.apps.api.ts` - App Details Endpoint

Modify `getAppDetails()` to optionally include compatibility (when user is authenticated):

```typescript
async function getAppDetails(c: AppContext) {
  const packageName = c.req.param("packageName");

  // ... existing app fetch logic ...

  const enrichedApps = await batchEnrichAppsWithProfiles([app]);
  const enrichedApp = enrichedApps[0] || app;

  // NEW: Try to get auth context for compatibility check
  // This endpoint is public, but if auth header present, we can enrich
  let compatibility = null;
  let deviceInfo = null;

  try {
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      // Attempt to get user session (don't fail if not available)
      const email = c.get("email"); // May be undefined for public access
      if (email) {
        const userSession = UserSession.getById(email);
        if (userSession) {
          const capabilities = userSession.getCapabilities();
          compatibility = HardwareCompatibilityService.checkCompatibility(enrichedApp, capabilities);
          deviceInfo = {
            connected: userSession.deviceManager.isGlassesConnected,
            modelName: userSession.deviceManager.getModel()
          };
        }
      }
    }
  } catch (e) {
    // Silently continue without compatibility info
  }

  return c.json({
    success: true,
    data: {
      ...enrichedApp,
      compatibility
    },
    deviceInfo
  });
}
```

#### 1.3 Update `store.apps.api.ts` - Search Endpoint

Modify `searchApps()` to include compatibility info when authenticated:

```typescript
async function searchApps(c: AppContext) {
  const query = c.req.query("q");

  // ... existing validation ...

  const filteredApps = await storeService.searchApps(query);
  const enrichedApps = await batchEnrichAppsWithProfiles(filteredApps);

  // NEW: Try to get auth context for compatibility check
  let appsWithCompatibility = enrichedApps;
  let deviceInfo = null;

  try {
    const email = c.get("email"); // May be undefined for public access
    if (email) {
      const userSession = UserSession.getById(email);
      if (userSession) {
        const capabilities = userSession.getCapabilities();
        const deviceName = userSession.deviceManager.getModel();
        const isConnected = userSession.deviceManager.isGlassesConnected;

        appsWithCompatibility = enrichedApps.map(app => {
          const compatibility = HardwareCompatibilityService.checkCompatibility(app, capabilities);
          return { ...app, compatibility };
        });

        deviceInfo = { connected: isConnected, modelName: deviceName };
      }
    }
  } catch (e) {
    // Silently continue without compatibility info
  }

  return c.json({
    success: true,
    data: appsWithCompatibility,
    deviceInfo
  });
}
```

Note: Search endpoint needs optional auth middleware to populate `email` when token is present.

---

#### 1.4 Add Optional Auth Middleware

**File**: `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts`

Create `optionalClientAuth` middleware that populates `email` if valid token present, but doesn't reject if missing:

```typescript
/**
 * Optional JWT auth middleware - populates email if valid token present, continues without if not.
 * Does NOT reject requests without auth - just continues without setting email.
 * Use this for public endpoints that can optionally enrich response for authenticated users.
 */
export const optionalClientAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("authorization");

  // No auth header - continue without setting email
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    await next();
    return;
  }

  const token = authHeader.substring(7);

  // Invalid token value - continue without setting email
  if (!token || token === "null" || token === "undefined") {
    await next();
    return;
  }

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (decoded && decoded.email) {
      const email = decoded.email.toLowerCase();
      c.set("email", email);
      c.set("logger", logger.child({ userId: email, reqId: c.get("reqId") }));
    }
  } catch (error) {
    // Token invalid/expired - continue without setting email (don't fail)
    logger.debug("optionalClientAuth: Token verification failed, continuing without auth");
  }

  await next();
};
```

Then update routes in `store.apps.api.ts`:

```typescript
// Public endpoints with optional auth for compatibility info
app.get("/search", optionalClientAuth, searchApps);
app.get("/:packageName", optionalClientAuth, getAppDetails);
```

---

### Phase 2: Frontend - Type Updates

#### 2.1 Update App Types

**File**: `cloud/websites/store/src/types/index.tsx`

Note: `HardwareRequirement` already exists (imported from `@mentra/sdk`). Only add new types:

```typescript
// Add new types (HardwareRequirement already exists from @mentra/sdk)
export interface CompatibilityResult {
  isCompatible: boolean;
  missingRequired: HardwareRequirement[];
  missingOptional: HardwareRequirement[];
  warnings: string[];
}

export interface DeviceInfo {
  connected: boolean;
  modelName: string | null;
}

// Update AppI interface - add compatibility field
export interface AppI {
  // ... existing fields ...
  compatibility?: CompatibilityResult;
}

// Add API response type
export interface AppsResponse {
  success: boolean;
  data: AppI[];
  deviceInfo?: DeviceInfo;
}
```

#### 2.2 Update API Service

**File**: `cloud/websites/store/src/api/index.ts`

```typescript
// Update return types to include deviceInfo
getAvailableApps: async (options?: AppFilterOptions): Promise<{ apps: AppI[], deviceInfo?: DeviceInfo }> => {
  const response = await axios.get<AppsResponse>(url);
  return {
    apps: response.data.data,
    deviceInfo: response.data.deviceInfo
  };
},
```

---

### Phase 3: Frontend - Store Pages

#### 3.1 Update AppStoreMobile.tsx

**File**: `cloud/websites/store/src/pages/AppStoreMobile.tsx`

```typescript
// Add state for device info
const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

// Update fetchApps to capture deviceInfo
const fetchApps = async () => {
  // ... existing logic ...

  if (isAuthenticated) {
    const result = await api.app.getAvailableApps(filterOptions);
    appList = result.apps;
    setDeviceInfo(result.deviceInfo || null);
  }

  // ... rest of function ...
};

// Split apps by compatibility
const { compatibleApps, incompatibleApps } = useMemo(() => {
  const compatible: AppI[] = [];
  const incompatible: AppI[] = [];

  filteredApps.forEach(app => {
    if (app.compatibility?.isCompatible === false) {
      incompatible.push(app);
    } else {
      compatible.push(app);
    }
  });

  return { compatibleApps: compatible, incompatibleApps: incompatible };
}, [filteredApps]);

// In render - update app grid section
<>
  {/* Compatible Apps */}
  <div className="mt-2 mb-2 grid grid-cols-1 gap-y-[24px]">
    {compatibleApps.map((app) => (
      <AppCard key={app.packageName} app={app} /* ... */ />
    ))}
  </div>

  {/* Incompatible Apps Section */}
  {incompatibleApps.length > 0 && deviceInfo?.modelName && (
    <>
      <div
        className="mt-8 mb-4 text-[16px] font-medium"
        style={{ color: "var(--text-secondary)" }}
      >
        Incompatible with {deviceInfo.modelName}
      </div>
      <div className="grid grid-cols-1 gap-y-[24px] opacity-60">
        {incompatibleApps.map((app) => (
          <AppCard key={app.packageName} app={app} /* ... */ />
        ))}
      </div>
    </>
  )}
</>
```

#### 3.2 Update AppStoreDesktop.tsx

Same pattern as mobile - split apps and render two sections.

---

### Phase 4: Frontend - App Details Pages

#### 4.1 Update AppDetailsV2.tsx (Parent Component)

**File**: `cloud/websites/store/src/pages/AppDetailsV2.tsx`

This is the parent component that fetches app data. Update it to:
1. Capture `deviceInfo` from API response
2. Pass `deviceInfo` to child components

```typescript
// Add state for device info
const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

// Update fetchAppDetails to capture deviceInfo from API response
const fetchAppDetails = async (pkgName: string) => {
  // ... existing logic ...
  const response = await api.app.getAppByPackageName(pkgName);
  // API now returns { data: app, deviceInfo }
  setApp(response.app);
  setDeviceInfo(response.deviceInfo || null);
  // ... rest of function ...
};

// Pass deviceInfo to child components
<AppDetailsMobile
  app={app}
  deviceInfo={deviceInfo}  // NEW
  // ... other props ...
/>
```

#### 4.2 Update AppDetailsShared.tsx (Props Interface)

**File**: `cloud/websites/store/src/pages/AppDetailsShared.tsx`

Update the shared props interface:

```typescript
export interface AppDetailsMobileProps {
  app: AppI;
  deviceInfo?: DeviceInfo | null;  // NEW
  // ... existing props ...
}
```

#### 4.3 Update AppDetailsMobile.tsx

**File**: `cloud/websites/store/src/pages/AppDetailsMobile.tsx`

Add compatibility warning banner (deviceInfo now comes from props):

```typescript
const AppDetailsMobile: React.FC<AppDetailsMobileProps> = ({
  app,
  deviceInfo,  // NEW - from props
  // ... other props ...
}) => {
  // In render, after header/before description
  {app.compatibility?.isCompatible === false && deviceInfo?.modelName && (
    <div
      className="mx-4 mt-4 p-3 rounded-lg flex items-start gap-3"
      style={{
        backgroundColor: "var(--warning-bg, #fef3c7)",
        border: "1px solid var(--warning-border, #f59e0b)"
      }}
    >
      <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-medium text-amber-800">
          Not compatible with {deviceInfo.modelName}
        </p>
        <p className="text-sm text-amber-700 mt-1">
          This app requires {app.compatibility.missingRequired.map(r => r.type.toLowerCase()).join(", ")}
          which {app.compatibility.missingRequired.length === 1 ? "is" : "are"} not available on your glasses.
        </p>
      </div>
    </div>
  )}
```

#### 4.4 Update AppDetailsDesktop.tsx

Same pattern - receive `deviceInfo` from props, add warning banner component.

---

### Phase 5: Disable Install for Incompatible Apps

**File**: `cloud/websites/store/src/components/AppCard.tsx`

If `app.compatibility?.isCompatible === false`:
- Disable the install button (keep it visible but non-interactive)
- The warning banner already explains why, so no need for extra tooltip

```typescript
// In AppCard install button
<button
  disabled={app.compatibility?.isCompatible === false || installingApp === app.packageName}
  onClick={() => onInstall(app.packageName)}
  className={`... ${app.compatibility?.isCompatible === false ? 'opacity-50 cursor-not-allowed' : ''}`}
>
  {installingApp === app.packageName ? 'Installing...' : 'Get'}
</button>
```

Also update app details pages (`AppDetailsMobile.tsx`, `AppDetailsDesktop.tsx`) to disable install button when incompatible.

---

### Phase 6: Optional Enhancements

#### 6.1 Add Compatibility Badge to AppCard

Show small badge/icon on incompatible app cards indicating they won't work with current device.

#### 6.2 Public Apps Endpoint

Consider whether `getPublicApps()` should also support optional auth for compatibility info, or keep it simple (no compatibility for unauthenticated users).

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| User not authenticated | No compatibility info, show all apps normally |
| User authenticated but no glasses connected | `capabilities = null`, all apps show as compatible, no warning displayed (console.log in frontend only) |
| App has no hardware requirements | Always compatible |
| Device model unknown | Show all as compatible |
| Unknown hardware type in app requirements | Return `true` for that capability (permissive default), log server-side for investigation |

---

## Testing Checklist

- [ ] Authenticated user with glasses connected sees apps split by compatibility
- [ ] Incompatible section shows correct device name
- [ ] App details page shows warning banner for incompatible apps
- [ ] Unauthenticated users see all apps without compatibility filtering
- [ ] Users with no glasses connected see all apps (no incompatible section)
- [ ] Install button is disabled for incompatible apps
- [ ] Search results respect compatibility grouping
- [ ] Organization filter works with compatibility grouping

---

## Files Modified

| File | Type | Description |
|------|------|-------------|
| `cloud/packages/cloud/src/services/session/HardwareCompatibilityService.ts` | Backend | Fix unknown hardware type to return true |
| `cloud/packages/cloud/src/api/hono/store/store.apps.api.ts` | Backend | Add compatibility enrichment to endpoints |
| `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts` | Backend | Add `optionalClientAuth` middleware |
| `cloud/websites/store/src/types/index.tsx` | Frontend | Add `CompatibilityResult`, `DeviceInfo` types |
| `cloud/websites/store/src/api/index.ts` | Frontend | Update API response handling for deviceInfo |
| `cloud/websites/store/src/pages/AppStoreMobile.tsx` | Frontend | Split apps, add incompatible section |
| `cloud/websites/store/src/pages/AppStoreDesktop.tsx` | Frontend | Split apps, add incompatible section |
| `cloud/websites/store/src/pages/AppDetailsV2.tsx` | Frontend | Capture deviceInfo, pass to children |
| `cloud/websites/store/src/pages/AppDetailsShared.tsx` | Frontend | Add deviceInfo to props interface |
| `cloud/websites/store/src/pages/AppDetailsMobile.tsx` | Frontend | Add compatibility warning banner |
| `cloud/websites/store/src/pages/AppDetailsDesktop.tsx` | Frontend | Add compatibility warning banner |
| `cloud/websites/store/src/components/AppCard.tsx` | Frontend | Disable install button for incompatible apps |

---

## Estimated Effort

- **Phase 1 (Backend)**: 30-45 min
- **Phase 2 (Types)**: 15 min
- **Phase 3 (Store pages)**: 45 min
- **Phase 4 (Details pages)**: 30 min
- **Phase 5 (Enhancements)**: Optional, 30 min each

**Total**: ~2-3 hours for core implementation
