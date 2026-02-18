# Shared Types Package Setup Guide

## Overview

Creating `@mentra/types` package for shared TypeScript types between mobile client and cloud backend. No dependencies, pure types only.

**Critical**: Uses explicit `export type` syntax to avoid Bun runtime issues with type re-exports (see cloud/issues/todo/sdk-type-exports).

## Why Separate Package

**Current problem**: Types duplicated across mobile and cloud with drift.

- Mobile: `AppletInterface` in `mobile/src/types/AppletTypes.ts`
- Cloud SDK: `HardwareRequirement`, `Capabilities` in `@mentra/sdk/types`
- Inconsistencies cause bugs and manual syncing

**Solution**: Single source of truth for client-facing types.

## Package Structure

```
cloud/packages/types/
├── package.json          # Package config
├── tsconfig.json         # TypeScript config
├── src/
│   ├── index.ts         # Main export (uses explicit type exports)
│   ├── applet.ts        # App/Applet types
│   ├── hardware.ts      # Hardware capability types
│   └── enums.ts         # Shared enums
└── dist/                # Built output (gitignored)
```

**Note on exports**: We use explicit `export type` syntax instead of `export *` to ensure Bun can execute TypeScript directly in development without runtime errors.

## Setup Steps

### 1. Create Package Directory

```bash
cd cloud/packages
mkdir -p types/src
cd types
```

### 2. Create package.json

```json
{
  "name": "@mentra/types",
  "version": "1.0.0",
  "description": "Shared TypeScript types for MentraOS client and cloud",
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

### 3. Create tsconfig.json

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
    "resolveJsonModule": true,
    "noEmit": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 4. Create Type Files

**Important**: Use explicit exports (not `export *`) for Bun compatibility.

**src/enums.ts**

```typescript
/**
 * Hardware component types
 * Note: These are enums (runtime values), not types
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

export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED",
  OPTIONAL = "OPTIONAL",
}
```

**src/hardware.ts**

```typescript
import { HardwareType, HardwareRequirementLevel } from "./enums";

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
  // Detailed capabilities from SDK
  camera: any | null;
  display: any | null;
  microphone: any | null;
  speaker: any | null;
  imu: any | null;
  button: any | null;
  light: any | null;
  power: any | null;
}
```

**src/applet.ts**

```typescript
import { HardwareRequirement } from "./hardware";

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
 * Optimized for fast rendering with minimal data
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

**src/index.ts**

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

// Applet types (mixed exports)
export type {
  AppletType,
  AppPermissionType,
  AppletPermission,
  AppletInterface,
} from "./applet";
```

### 5. Build Package

```bash
cd cloud/packages/types
bun run build
```

Verify `dist/` directory created with `.js` and `.d.ts` files.

### 6. Link in Workspace

Root `package.json` already has workspace config:

```json
{
  "workspaces": ["packages/*"]
}
```

Install dependencies:

```bash
cd cloud
bun install
```

## Usage in Cloud

**Import in cloud services:**

```typescript
import {
  AppletInterface,
  HardwareRequirement,
  Capabilities,
} from "@mentra/types";

export class ClientAppsService {
  static async getAppsForHomeScreen(
    userId: string,
  ): Promise<AppletInterface[]> {
    // Implementation
  }
}
```

## Usage in Mobile

**Update mobile package.json:**

```json
{
  "dependencies": {
    "@mentra/types": "workspace:*"
  }
}
```

**Import in mobile code:**

```typescript
import { AppletInterface, AppletPermission } from "@mentra/types";

// Remove old local type definitions
// export interface AppletInterface { ... } // DELETE THIS
```

## Migration Strategy

### Phase 1: Create Package (No Breaking Changes)

1. Create `packages/types/` with all files above
2. Build: `bun run build`
3. Link: `bun install` in root

### Phase 2: Update SDK (Backward Compatible)

```typescript
// packages/sdk/src/types/index.ts
// Re-export from @mentra/types for backward compatibility
// Use explicit exports for Bun compatibility

// Enums (runtime values)
export { HardwareType, HardwareRequirementLevel } from "@mentra/types";

// Types (type-only exports)
export type { HardwareRequirement, Capabilities } from "@mentra/types";

// SDK-specific types stay here (also use explicit exports)
export type { AppI, DeveloperProfile, Permission } from "./models";
export type { WebhookRequest, WebhookResponse, ToolCall } from "./webhooks";
// etc...
```

### Phase 3: Update Cloud

```typescript
// packages/cloud/src/services/client/apps.service.ts
import { AppletInterface } from "@mentra/types";
import App from "../../models/app.model";

export class ClientAppsService {
  static async getAppsForHomeScreen(
    userId: string,
  ): Promise<AppletInterface[]> {
    const apps = await App.find({
      /* ... */
    });

    // Map AppI (internal) to AppletInterface (client-facing)
    return apps.map((app) => ({
      packageName: app.packageName,
      name: app.name,
      webviewUrl: app.webviewURL || "",
      logoUrl: app.logoURL,
      type: app.appType as AppletType,
      permissions: app.permissions || [],
      running: false, // From session
      healthy: true, // From cache
      hardwareRequirements: app.hardwareRequirements || [],
    }));
  }
}
```

### Phase 4: Update Mobile

```typescript
// mobile/src/types/AppletTypes.ts
// Replace local definitions with imports
export { AppletInterface, AppletPermission, AppletType } from "@mentra/types";

// Keep mobile-specific utilities
export const isOfflineApp = (app: AppletInterface): boolean => {
  return app.isOffline === true;
};
```

## Type Versioning

**Semver for types:**

- Major: Breaking changes to existing types
- Minor: New optional fields
- Patch: Documentation, internal changes

**Example:**

```typescript
// v1.0.0 → v1.1.0 (non-breaking)
export interface AppletInterface {
  // ... existing fields
  installedDate?: Date; // New optional field - MINOR bump
}

// v1.1.0 → v2.0.0 (breaking)
export interface AppletInterface {
  // ... existing fields
  webviewUrl: string | null; // Changed from string - MAJOR bump
}
```

## Testing

**Verify imports work:**

```bash
# In cloud
cd cloud/packages/cloud
bun x tsc --noEmit

# In mobile (if using TypeScript)
cd mobile
npm run typecheck
```

**Verify builds:**

```bash
cd cloud/packages/types
bun run build
ls -la dist/  # Should see index.js, index.d.ts, etc.
```

## Troubleshooting

**Issue**: Import not found

```
Cannot find module '@mentra/types'
```

**Fix**: Run `bun install` in cloud root to link workspace packages.

**Issue**: Type mismatch

```
Type 'AppI' is not assignable to type 'AppletInterface'
```

**Fix**: These are different types. AppI is internal, AppletInterface is client-facing. Map between them.

**Issue**: Build fails

```
error TS2304: Cannot find name 'HardwareType'
```

**Fix**: Ensure all imports in `src/index.ts` are correct and files exist.

## Best Practices

1. **No dependencies**: Keep this package dependency-free (pure types only)
2. **No logic**: Only interfaces, types, enums (no runtime code)
3. **Client-focused**: Only types mobile client needs (not internal models)
4. **Minimal fields**: Don't add fields "just in case" - keep lean
5. **Version carefully**: Breaking changes = major version bump
6. **Explicit exports**: Always use `export type` for types/interfaces, never `export *`
7. **Bun-compatible**: Test with `bun run src/index.ts` to verify runtime execution works

## What NOT to Include

❌ Database models (`AppI`, `UserI` - internal only)
❌ Service logic (keep in services)
❌ Validation schemas (keep in validators)
❌ Complex SDK types (webhook payloads, tool schemas - SDK-specific)
❌ Runtime dependencies (axios, express, etc.)

## What to Include

✅ Client-facing app types (`AppletInterface`)
✅ Hardware capability types (needed by mobile for UI)
✅ Permission types (needed by mobile for permission requests)
✅ Enums shared between client and cloud
✅ Minimal data transfer objects (DTOs)

## Next Steps

1. Create package structure
2. Copy types from SDK and mobile
3. **Use explicit exports** (not `export *`) in `src/index.ts`
4. Build and verify: `bun run build`
5. **Test Bun runtime**: `bun run src/index.ts` (should not error)
6. Update SDK to re-export (backward compat, also explicit)
7. Update cloud service to use types
8. Update mobile to import from package
9. Test end-to-end
10. Ship it 🚀

## Bun Compatibility Checklist

- [ ] No `export *` statements in any file
- [ ] All type exports use `export type { ... }`
- [ ] All value exports (enums, functions) use `export { ... }`
- [ ] Test passes: `cd packages/types && bun run src/index.ts`
- [ ] TypeScript compilation works: `bun run build`
- [ ] Cloud imports work: `import { AppletInterface } from '@mentra/types'`
- [ ] Mobile imports work: `import { AppletInterface } from '@mentra/types'`
