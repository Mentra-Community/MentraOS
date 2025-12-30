# Bun Export Pattern Quick Reference

## Problem

Bun's runtime TypeScript execution fails with `export *` statements that include types/interfaces:

```typescript
// ❌ This breaks Bun runtime
export * from "./messages/app-to-cloud";
```

**Error:**

```
SyntaxError: export 'RgbLedControlRequest' not found in './messages/app-to-cloud'
```

**Why:** TypeScript interfaces/types don't exist at runtime. Bun tries to re-export them and fails.

**Issue:** https://github.com/oven-sh/bun/issues/7384

## Solution: Explicit Type Exports

Split type and value exports explicitly:

```typescript
// ✅ This works with Bun
export type {
  RgbLedControlRequest, // interface
  PhotoRequest, // interface
  MessageType, // type alias
} from "./messages/app-to-cloud";

export {
  isPhotoRequest, // function
  MessageStatus, // enum
} from "./messages/app-to-cloud";
```

## Pattern for @mentra/types

### src/enums.ts

```typescript
// Enums are runtime values, not types
export enum HardwareType {
  CAMERA = "CAMERA",
  DISPLAY = "DISPLAY",
}

export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED",
  OPTIONAL = "OPTIONAL",
}
```

### src/hardware.ts

```typescript
import { HardwareType, HardwareRequirementLevel } from "./enums";

// These are pure types (no runtime)
export interface HardwareRequirement {
  type: HardwareType;
  level: HardwareRequirementLevel;
  description?: string;
}

export interface Capabilities {
  modelName: string;
  hasCamera: boolean;
  // ...
}
```

### src/applet.ts

```typescript
import { HardwareRequirement } from "./hardware";

// Type alias (no runtime)
export type AppletType = "standard" | "background" | "system_dashboard";

// Union type (no runtime)
export type AppPermissionType = "MICROPHONE" | "CAMERA" | "LOCATION";

// Interface (no runtime)
export interface AppletPermission {
  type: AppPermissionType;
  description?: string;
}

// Interface (no runtime)
export interface AppletInterface {
  packageName: string;
  name: string;
  type: AppletType;
  permissions: AppletPermission[];
  // ...
}
```

### src/index.ts (Main Export)

```typescript
/**
 * @mentra/types - Shared types for MentraOS
 *
 * Uses explicit exports for Bun compatibility
 * DO NOT use `export *` - causes runtime errors
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

## Rules

### 1. Types/Interfaces → `export type`

```typescript
// Interfaces
export type { MyInterface } from "./file";

// Type aliases
export type { MyType } from "./file";

// Union types
export type { Status } from "./file";
```

### 2. Enums → `export`

```typescript
// Enums are runtime values
export { MyEnum } from "./file";
```

### 3. Functions → `export`

```typescript
// Functions are runtime values
export { myFunction } from "./file";
```

### 4. Classes → `export`

```typescript
// Classes are runtime values
export { MyClass } from "./file";
```

### 5. Constants → `export`

```typescript
// Constants are runtime values
export { MY_CONSTANT } from "./file";
```

## Quick Decision Tree

```
Is it only available at compile time?
├─ Yes → Use `export type`
│  ├─ interface
│  ├─ type alias
│  └─ union/intersection types
│
└─ No → Use `export`
   ├─ enum
   ├─ function
   ├─ class
   ├─ const
   └─ let/var
```

## Testing Bun Compatibility

```bash
# Test that Bun can execute the TypeScript source
cd packages/types
bun run src/index.ts

# Should output nothing (no errors)
# If you see "SyntaxError: export 'X' not found", you have an export type issue
```

## Common Mistakes

### ❌ Mistake 1: Using `export *`

```typescript
// Don't do this
export * from "./types";
```

### ✅ Fix: Explicit exports

```typescript
export type { MyType, MyInterface } from "./types";
export { MyEnum, myFunction } from "./types";
```

### ❌ Mistake 2: Wrong export for enums

```typescript
// Don't do this (enums are runtime values)
export type { HardwareType } from "./enums";
```

### ✅ Fix: Regular export for enums

```typescript
export { HardwareType } from "./enums";
```

### ❌ Mistake 3: Wrong export for interfaces

```typescript
// Don't do this (interfaces are types)
export { AppletInterface } from "./applet";
```

### ✅ Fix: Type export for interfaces

```typescript
export type { AppletInterface } from "./applet";
```

## Benefits

1. **Instant feedback**: Use `src/` directly in development, no rebuilds
2. **Catch errors early**: TypeScript errors fail immediately
3. **Fast iteration**: 1-2 second restarts vs 15-20 seconds
4. **No stale builds**: Impossible to push code that "works after rebuild"
5. **Future-proof**: When Bun fixes the issue, code still works

## Related Issues

- `cloud/issues/todo/sdk-type-exports/` - Why we avoid `export *`
- https://github.com/oven-sh/bun/issues/7384 - Upstream Bun issue

## Checklist for New Packages

- [ ] No `export *` statements anywhere
- [ ] All interfaces/types use `export type { ... }`
- [ ] All enums/functions/classes use `export { ... }`
- [ ] Test: `bun run src/index.ts` (should not error)
- [ ] Test: `bun run build` (should compile)
- [ ] Document why we use explicit exports (link to this file)
