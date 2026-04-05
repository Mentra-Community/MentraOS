# Monorepo Setup Audit

## The Problem

**Current pain point**: When you edit SDK source files, cloud doesn't see the changes until you run `bun run build` in the SDK package. This breaks the dev loop and causes frequent errors.

**Symptom**: "I forgot to rebuild the SDK again" syndrome.

## Root Cause Analysis

### What's Happening Now

1. **SDK package.json exports**:

```json
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
}
```

2. **Cloud tsconfig.json paths**:

```json
"paths": {
  "@mentra/sdk": ["../sdk/dist"],  // ← Points to dist, not src!
  "bun-types": ["./node_modules/bun-types"]
}
```

3. **Workspace reference**:

```json
"dependencies": {
  "@mentra/sdk": "workspace:*"  // ← Correct workspace reference
}
```

### The Disconnect

- SDK has `"development"` export pointing to `./src/index.ts` ✅
- BUT cloud's TypeScript config explicitly overrides to `../sdk/dist` ❌
- Result: TypeScript always looks at compiled output, never source

### Why You Probably Did This Originally

Possible reasons (common in early monorepo setups):

1. **Publishing concern**: Wanted to ensure the built package structure worked correctly for npm publish
2. **Type safety**: Compiled .d.ts files are more reliable than raw .ts for type checking
3. **IDE performance**: Some IDEs struggle with cross-package TypeScript resolution
4. **It just worked**: Early on, this solved some issue and you kept it

## The Solution: Two Options

### Option 1: Point TypeScript Directly to Source (Recommended)

**Change TypeScript path to point to SDK source instead of dist.**

#### Cloud tsconfig.json

```json
"paths": {
  // Change from dist to src:
  "@mentra/sdk": ["../sdk/src"],
  "bun-types": ["./node_modules/bun-types"]
}
```

#### Why This Works

- TypeScript resolves `@mentra/sdk` to source files directly
- Works regardless of NODE_ENV value (`isaiah`, `staging`, `east-asia-prod`, etc.)
- Bun runs TypeScript natively, so no compilation needed
- Changes to SDK are visible immediately

#### Important Note About "development" Export

The SDK's `"development"` export condition in package.json doesn't help us because:

- You use custom NODE_ENV values: `isaiah`, `staging`, `east-asia-prod`
- The "development" condition only triggers if NODE_ENV=development (which you don't use)
- So it always falls back to "default" → dist/

**Solution**: Bypass exports entirely, point TypeScript directly to src/

#### Trade-offs

- ✅ Instant feedback on SDK changes
- ✅ No rebuild step needed
- ✅ Works with any NODE_ENV value
- ✅ Simple and explicit
- ⚠️ TypeScript IDE might struggle initially (restart TS server fixes it)
- ⚠️ Must ensure SDK source files are valid TypeScript (no build-time transforms)

### Option 2: Hybrid Mode with Watcher (If Option 1 Breaks)

**Keep dist reference but auto-rebuild SDK on changes.**

#### Add to root package.json

```json
"scripts": {
  "dev:sdk-watch": "cd packages/sdk && bun --watch run build",
  "dev:all": "concurrently \"npm run dev:sdk-watch\" \"npm run dev\""
}
```

#### Trade-offs

- ✅ Maintains IDE stability
- ✅ Auto-rebuilds on save
- ❌ Slight delay (rebuild time)
- ❌ More complex dev script
- ❌ Extra process running

## Recommended Action Plan

### Phase 1: Try Pure Development Mode (10 minutes)

1. **Edit cloud/packages/cloud/tsconfig.json**:

```json
"paths": {
  "bun-types": ["./node_modules/bun-types"]
  // Removed @mentra/sdk line
}
```

2. **Restart TypeScript server** in your editor:
   - VSCode: `Cmd+Shift+P` → "TypeScript: Restart TS Server"
   - Cursor/Zed: Similar command

3. **Test it**:

```bash
# Terminal 1: Start cloud dev server
cd cloud
bun run dev

# Terminal 2: Edit SDK file
# Edit cloud/packages/sdk/src/types/capabilities.ts
# Add a comment or change a type

# Terminal 3: Check if cloud sees it
# Import should resolve immediately, no rebuild
```

4. **If it works**: Done! Commit it.

5. **If it breaks**: Move to Phase 2.

### Phase 2: Debug What Broke (20 minutes)

**Common issues and fixes**:

1. **"Cannot find module '@mentra/sdk'"**
   - Check: Is SDK listed in cloud's package.json?
   - Fix: `cd cloud && bun install` (reinstall workspace links)

2. **"Type errors from SDK"**
   - Check: Is SDK source TypeScript valid?
   - Fix: Ensure SDK compiles standalone: `cd packages/sdk && bun x tsc --noEmit`

3. **"IDE shows errors but bun runs fine"**
   - Not a real problem, just restart TS server
   - Or add back path alias but point to src: `"@mentra/sdk": ["../sdk/src"]`

### Phase 3: Fallback to Hybrid Mode (30 minutes)

If pure mode truly doesn't work:

1. **Keep current tsconfig paths**

2. **Add SDK watcher**:

```json
// root package.json
"scripts": {
  "dev:sdk": "cd packages/sdk && bun --watch run build",
  "dev:cloud": "bun run dev",
  "dev:all": "concurrently --kill-others \"npm run dev:sdk\" \"npm run dev:cloud\""
}
```

3. **Use `npm run dev:all`** for development

4. **Install concurrently**:

```bash
bun add -D concurrently
```

## Why Bun Makes This Easier

Bun's workspace resolution is better than npm/yarn:

1. **Native TypeScript**: Bun runs .ts directly, no build needed
2. **Workspace linking**: `workspace:*` resolves correctly
3. **Fast**: Even if rebuilding, bun is ~10x faster than tsc

The SDK has a "development" export, but it's not useful because:

```json
"exports": {
  "development": { "import": "./src/index.ts" },  // ← Only if NODE_ENV=development
  "default": { "import": "./dist/index.js" }      // ← Your custom ENVs use this
}
```

Since you use `NODE_ENV=isaiah`, `NODE_ENV=staging`, etc., the "development" condition never triggers.

**Solution**: Use TypeScript's path mapping to point directly to source, bypassing exports entirely.

## Testing Checklist

After changing tsconfig to point to `../sdk/src`:

- [ ] Restart TypeScript server in your editor
- [ ] `cd cloud && bun run dev` starts without errors
- [ ] Edit SDK file (`packages/sdk/src/types/capabilities.ts`)
- [ ] Change immediately visible in cloud (no rebuild needed!)
- [ ] TypeScript errors show correctly in IDE
- [ ] Works with `NODE_ENV=isaiah` or any custom value
- [ ] Production build still works: `cd packages/sdk && bun run build`
- [ ] Production deployment uses dist/ (not src/)

## Related Issues to Consider

While we're here, you might want to audit:

1. **@mentra/utils package** (if it exists): Same pattern?
2. **@mentra/agents package**: Check its tsconfig paths
3. **Websites (console/store)**: Do they import SDK? Same issue?
4. **Mobile app**: Does it have similar problems with any shared packages?

## Future: The @mentra/types Package

When you create `@mentra/types`:

**Do it right from the start:**

```json
// packages/types/package.json
{
  "name": "@mentra/types",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "source": "src/index.ts"
}
```

**In consuming packages**, use path mapping for development:

```json
// cloud/packages/cloud/tsconfig.json
"paths": {
  "@mentra/types": ["../types/src"]  // Point to source in dev
}
```

Since you use custom NODE_ENV values, export conditions won't help. TypeScript path mapping is simpler and more explicit.

## Summary

**The problem**: TypeScript path points to `../sdk/dist`, forcing use of compiled output.

**The fix**: Change path to `../sdk/src`, point directly to source files.

**Why export conditions don't help**: You use `NODE_ENV=isaiah`, `staging`, etc., so the "development" condition never triggers.

**Time to fix**: 2 minutes to change tsconfig, restart TS server.

**Risk**: Very low. Easy to revert if it breaks.

**Upside**: Instant SDK changes, better dev experience, works with any NODE_ENV.

---

**Recommendation**: Change tsconfig path from `../sdk/dist` to `../sdk/src`. This is explicit, simple, and works regardless of NODE_ENV value. Bun runs TypeScript natively, so no build step needed in development.
