# @mentra/types

Shared TypeScript types for MentraOS client and cloud.

## Purpose

Single source of truth for client-facing types used by both mobile app and cloud backend. Eliminates type drift and duplication.

## What's Included

- `AppletInterface` - Minimal app interface for home screen (8 fields)
- `HardwareRequirement` - Hardware requirements for apps
- `Capabilities` - Device hardware capabilities
- `AppletPermission` - App permission types
- Enums: `HardwareType`, `HardwareRequirementLevel`

## Installation

Already linked via Bun workspace. Just import:

```typescript
import { AppletInterface, HardwareType, Capabilities } from "@mentra/types";
```

## Development

```bash
# Build (compile TypeScript)
bun run build

# Watch mode
bun run dev

# Type check only
bun run typecheck

# Test Bun compatibility
bun run src/index.ts  # Should output nothing (no errors)
```

## Bun Compatibility

This package uses **explicit exports** to work with Bun's runtime TypeScript execution:

```typescript
// ✅ Types/Interfaces - export type
export type { AppletInterface, Capabilities } from "./applet";

// ✅ Enums (runtime) - export
export { HardwareType } from "./enums";

// ❌ Never use this (breaks Bun)
export * from "./applet";
```

See `cloud/issues/todo/sdk-type-exports/README.md` for details.

## Usage Examples

### In Cloud Services

```typescript
import { AppletInterface } from "@mentra/types";

export class ClientAppsService {
  static async getAppsForHomeScreen(
    userId: string,
  ): Promise<AppletInterface[]> {
    // Return minimal interface for client
  }
}
```

### In Mobile Client

```typescript
import { AppletInterface, HardwareType } from "@mentra/types";

function renderAppList(apps: AppletInterface[]) {
  // Render home screen
}
```

## What NOT to Include

- ❌ Internal database models (`AppI`, `UserI`)
- ❌ Service logic or business rules
- ❌ Validation schemas
- ❌ Complex SDK types (webhooks, tool schemas)
- ❌ Runtime dependencies

## What to Include

- ✅ Client-facing app types
- ✅ Hardware capability types
- ✅ Permission types
- ✅ Shared enums
- ✅ Minimal DTOs

## Adding New Types

1. Add type definition in appropriate file (`applet.ts`, `hardware.ts`, etc.)
2. Add explicit export in `src/index.ts`:

   ```typescript
   // For types/interfaces
   export type { MyNewType } from "./file";

   // For enums/values
   export { MyNewEnum } from "./file";
   ```

3. Test Bun compatibility: `bun run src/index.ts`
4. Build: `bun run build`
5. Bump version in `package.json` (semver)

## Versioning

- **Major**: Breaking changes to existing types
- **Minor**: New optional fields or new types
- **Patch**: Documentation, internal changes

## Files

- `src/enums.ts` - Runtime enums (HardwareType, etc.)
- `src/hardware.ts` - Hardware capability types
- `src/applet.ts` - App/applet types for clients
- `src/index.ts` - Main export (Bun-compatible)

## Links

- [Design Docs](../../issues/client-apps-api/)
- [Bun Export Pattern](../../issues/client-apps-api/bun-export-pattern.md)
- [SDK Type Export Issue](../../issues/todo/sdk-type-exports/)
