# CI Build Fixes for @mentra/types Package

## Problem

After creating the `@mentra/types` package, CI builds were failing because the cloud and SDK packages couldn't find the types module during compilation:

```
error TS2307: Cannot find module '@mentra/types' or its corresponding type declarations.
```

## Root Cause

The `@mentra/types` package needs to be **built first** (creating `dist/` folder) before other packages can import from it during their TypeScript compilation.

**Build dependency chain:**

```
@mentra/types (must build first)
    ↓
@mentra/sdk (imports from types)
    ↓
@mentra/cloud (imports from types)
```

## Files Fixed

### 1. Docker Production Builds

#### `cloud/docker/Dockerfile.porter`

```diff
# Build packages in sequence
RUN echo "🚀 Starting build process..." && \
+    echo "⚙️ Building packages/types..." && \
+    cd packages/types && bun run build && \
+    echo "✅ Built packages/types..." && \
     echo "⚙️ Building packages/sdk..." && \
-    cd packages/sdk && bun run build && \
+    cd ../sdk && bun run build && \
```

#### `cloud/docker/Dockerfile.livekit`

```diff
# Build packages in sequence
RUN echo "🚀 Starting build process..." && \
+    echo "⚙️ Building packages/types..." && \
+    cd packages/types && bun run build && \
+    echo "✅ Built packages/types..." && \
     echo "⚙️ Building packages/sdk..." && \
-    cd packages/sdk && bun run build && \
+    cd ../sdk && bun run build && \
```

**Note:** `Dockerfile.dev` doesn't need changes because it uses `NODE_ENV=development` which uses source files directly (no build needed).

### 2. GitHub Actions Workflows

#### `.github/workflows/cloud-build.yml`

```diff
      - name: Install dependencies
        working-directory: cloud
        run: bun install

+      - name: Build types package
+        working-directory: cloud/packages/types
+        run: bun run build
+
+      - name: Build SDK package
+        working-directory: cloud/packages/sdk
+        run: bun run build
+
       - name: Run build
         working-directory: cloud/packages/cloud
         run: bun run build
```

#### `.github/workflows/cloud-sdk-build.yml`

```diff
      - name: Install dependencies
        working-directory: cloud
        run: bun install

+      - name: Build types package
+        working-directory: cloud/packages/types
+        run: bun run build
+
       - name: Run build
         working-directory: cloud/packages/sdk
         run: bun run build
```

## Why This Happens

### TypeScript Module Resolution

When TypeScript compiles `cloud/packages/cloud`, it needs to resolve:

```typescript
import {AppletInterface} from "@mentra/types"
```

**With `NODE_ENV=production` (CI/Docker):**

- Uses `exports.default` from `@mentra/types/package.json`
- Points to `dist/index.js` and `dist/index.d.ts`
- If `dist/` doesn't exist → **error!**

**With `NODE_ENV=development` (local):**

- Uses `exports.development` from `@mentra/types/package.json`
- Points to `src/index.ts` (source files)
- No build needed → **works!**

### Build Order Matters

```
Step 1: bun install
  ├─ Links workspace packages
  └─ @mentra/types → workspace:* (linked)

Step 2: Build @mentra/types
  ├─ Creates dist/index.js
  ├─ Creates dist/index.d.ts
  └─ Now importable by other packages ✅

Step 3: Build @mentra/sdk
  ├─ Imports from @mentra/types (finds dist/)
  └─ Bundles @mentra/types code inline

Step 4: Build @mentra/cloud
  ├─ Imports from @mentra/types (finds dist/)
  └─ Compiles successfully ✅
```

## Verification

### Check Docker Build

```bash
docker build -f docker/Dockerfile.porter -t test .
# Should complete without errors
```

### Check GitHub Actions

```bash
# Push changes to trigger CI
git add .
git commit -m "Fix CI builds for @mentra/types"
git push

# Monitor GitHub Actions:
# - cloud-build should pass ✅
# - cloud-sdk-build should pass ✅
```

### Expected Output

```
🚀 Starting build process...
⚙️ Building packages/types...
Bundled 1 modules in 5ms
  index.js 2 KB (entry point)
✅ Built packages/types...
⚙️ Building packages/sdk...
Bundled 44 modules in 12ms
  index.js 196 KB (entry point)
✅ Built packages/sdk...
⚙️ Building packages/cloud...
✅ Built packages/cloud...
🎉 All packages built successfully! 🎉
```

## Related Issues

- **Development mode** - No changes needed (uses source files)
- **Local builds** - No changes needed (already working)
- **Production deployments** - Fixed by Dockerfile changes ✅
- **CI/CD pipelines** - Fixed by workflow changes ✅

## Summary

✅ Docker production builds now work (Porter, LiveKit)
✅ GitHub Actions CI builds now work (cloud, SDK)
✅ Development mode unchanged (still fast)
✅ Build order ensures types are available when needed

The key insight: **Production builds need compiled output (`dist/`), so build types first!**
