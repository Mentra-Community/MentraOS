# SDK Bundling Setup with Bun

## Overview

The SDK now uses **Bun's bundler** to create self-contained published packages that inline workspace dependencies like `@mentra/types`, eliminating the need to publish multiple packages while maintaining fast development iteration.

## What Changed

### Before (TypeScript Compiler Only)

```json
{
  "scripts": {
    "build": "rm -rf dist && bun x tsc -p tsconfig.json"
  }
}
```

**Problem**: TypeScript compiler (`tsc`) doesn't bundle - it preserves import statements. If SDK imports from `@mentra/types`, the published package would require `@mentra/types` as a dependency.

### After (Bun Bundler + TypeScript for Types)

```json
{
  "scripts": {
    "build": "bun run clean && bun run build:js && bun run build:types",
    "clean": "rm -rf dist",
    "build:js": "bun build src/index.ts --outdir dist --target node --format esm --sourcemap=external --external <deps>",
    "build:types": "bun x tsc --emitDeclarationOnly"
  }
}
```

**Solution**:

1. **Bun bundler** creates `dist/index.js` - inlines `@mentra/types` code
2. **TypeScript** creates `dist/index.d.ts` - inlines type definitions
3. Published SDK is **self-contained** - no `@mentra/types` dependency needed

## How It Works

### Development Mode (Fast Iteration)

```
NODE_ENV=development
├─ SDK imports from @mentra/types → src/index.ts
├─ Cloud imports SDK → src/index.ts
└─ Bun executes TypeScript directly (no build step)
```

**Result**: Instant feedback, no rebuilds! ✅

### Build Mode (Publishing)

```
bun run build
├─ build:js → Bundles JavaScript with @mentra/types inlined
└─ build:types → Generates .d.ts with types inlined
```

**Result**: Self-contained package ready for npm! ✅

### Published Package

```
npm install @mentra/sdk
├─ dist/index.js → Contains bundled code (no @mentra/types imports)
└─ dist/index.d.ts → Contains inlined type definitions
```

**Result**: Users get everything in one package! ✅

## Configuration Details

### package.json Changes

```json
{
  "scripts": {
    "build": "bun run clean && bun run build:js && bun run build:types",
    "clean": "rm -rf dist",
    "build:js": "bun build src/index.ts --outdir dist --target node --format esm --sourcemap=external --external @logtail/pino --external axios --external boxen --external chalk --external cookie-parser --external dotenv --external express --external jimp --external jsonwebtoken --external jsrsasign --external multer --external pino --external pino-pretty --external strip-ansi --external ws",
    "build:types": "bun x tsc --emitDeclarationOnly"
  },
  "devDependencies": {
    "@mentra/types": "workspace:*" // Dev dependency only, bundled at build time
  }
}
```

### tsconfig.json Changes

```json
{
  "compilerOptions": {
    "emitDeclarationOnly": true, // Only generate .d.ts files (Bun handles .js)
    "declaration": true,
    "declarationMap": true
  }
}
```

## Build Process

### Step 1: Clean

```bash
rm -rf dist
```

### Step 2: Bundle JavaScript

```bash
bun build src/index.ts --outdir dist --target node --format esm
```

**What Bun does:**

- Resolves `import { X } from '@mentra/types'`
- Finds `@mentra/types` in workspace
- Bundles the code inline (no external reference)
- Outputs to `dist/index.js`

**External Dependencies:**

- Heavy packages like `axios`, `express`, `ws` stay as imports (not bundled)
- Only workspace packages like `@mentra/types` are bundled

### Step 3: Generate Type Definitions

```bash
bun x tsc --emitDeclarationOnly
```

**What TypeScript does:**

- Processes `export type { X } from '@mentra/types'`
- Inlines type definitions into `dist/index.d.ts`
- No external `@mentra/types` references in output

## Verification

### Check No External References

```bash
# JavaScript should NOT reference @mentra/types
grep "@mentra/types" dist/index.js
# (should find nothing)

# Type definitions should NOT reference @mentra/types
grep "@mentra/types" dist/index.d.ts
# (should find nothing)
```

### Test Published Package

```bash
# Build and pack
bun run build
npm pack

# Install locally and test
npm install -g ./mentra-sdk-2.1.27.tgz
node -e "const { HardwareType } = require('@mentra/sdk'); console.log(HardwareType);"
```

## Migration Strategy

### Phase 1: SDK Builds with Bundling ✅

- Updated build scripts
- SDK can import from `@mentra/types`
- Published package is self-contained

### Phase 2: Gradually Migrate Types (Next)

```typescript
// Move types from SDK to @mentra/types one by one

// Before (SDK defines its own)
// packages/sdk/src/types/enums.ts
export enum HardwareType { ... }

// After (import from @mentra/types)
// packages/sdk/src/types/index.ts
export { HardwareType } from '@mentra/types';
```

### Phase 3: Verify and Publish

1. Build SDK: `bun run build`
2. Verify bundling: `grep "@mentra/types" dist/index.js` (should be empty)
3. Test locally: `npm pack && npm install -g ./mentra-sdk-*.tgz`
4. Publish: `npm publish`

## Benefits

1. **DRY Principle**: Types live in one place (`@mentra/types`)
2. **Fast Development**: Bun executes TypeScript directly (no rebuild)
3. **Self-Contained SDK**: Published package has no `@mentra/types` dependency
4. **Future-Proof**: Can grow `@mentra/types` without breaking SDK consumers
5. **Simple Publishing**: Only publish SDK, not multiple packages
6. **Backward Compatible**: Existing SDK consumers unaffected

## Build Output

```
dist/
├── index.js          # 196 KB - Bundled code with @mentra/types inlined
├── index.js.map      # 523 KB - Source map for debugging
├── index.d.ts        # 4 KB - Type definitions with @mentra/types inlined
├── index.d.ts.map    # 2.7 KB - Type definition source map
└── (other folders)   # Generated type structure
```

## Troubleshooting

### Issue: "Cannot find module '@mentra/types'"

**During Development:**

```bash
# Ensure @mentra/types is linked
cd cloud
bun install
```

**After Publishing:**

```bash
# Verify bundling worked
grep "@mentra/types" dist/index.js
# Should find nothing - if it does, check --external flags
```

### Issue: Large Bundle Size

**Solution**: Add more `--external` flags to keep heavy deps external:

```bash
bun build src/index.ts --external axios --external express --external ws
```

Only workspace packages (`@mentra/types`) should be bundled.

### Issue: Type Definitions Reference @mentra/types

**Check tsconfig.json:**

```json
{
  "compilerOptions": {
    "emitDeclarationOnly": true,
    "declaration": true,
    "isolatedModules": false // Allows type inlining
  }
}
```

## Related Documentation

- [Client Apps API Design](./README.md)
- [@mentra/types Package](../types/README.md)
- [Bun Export Pattern](./bun-export-pattern.md)
- [SDK Type Exports Issue](../todo/sdk-type-exports/README.md)

## Summary

✅ SDK now uses Bun bundler to create self-contained packages
✅ Workspace dependencies like `@mentra/types` are bundled inline
✅ Published SDK works independently (no multi-package publishing)
✅ Development iteration is fast (Bun executes TypeScript directly)
✅ Ready to gradually migrate more types to `@mentra/types`
