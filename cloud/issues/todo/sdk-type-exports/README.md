# SDK Type Exports Issue

## Problem

**Current situation:** We use `dist/` (compiled output) for SDK in development, requiring manual rebuilds.

**What we want:** Use `src/` (TypeScript source) directly for instant feedback on SDK changes.

**What's blocking us:** Bun's runtime TypeScript execution can't handle how we export types.

## The Bun Limitation

When Bun runs TypeScript directly (not compiled), it has issues with type re-exports:

```typescript
// src/types/index.ts
export * from "./messages/app-to-cloud"; // ← This includes interfaces
```

**Error:**

```
SyntaxError: export 'RgbLedControlRequest' not found in './messages/app-to-cloud'
```

**Why:** TypeScript interfaces/types don't exist at runtime. Bun tries to re-export them and fails.

**GitHub Issue:** https://github.com/oven-sh/bun/issues/7384

Bun maintainers are working on a fix (as of Dec 2024), but it's not ready yet.

## Impact on Development

### Current Workflow (using dist/)

1. Change SDK source code
2. Remember to rebuild: `cd packages/sdk && bun run build`
3. Restart Docker to see changes
4. **Problem:** Easy to forget step 2, push broken code

### Issues This Causes

- ❌ Devs forget to rebuild SDK before testing
- ❌ Broken code pushed to git (works locally after manual build, breaks CI)
- ❌ Time wasted debugging "why doesn't my change work?"
- ❌ Docker restarts take 15-20 seconds (rebuild + restart)
- ❌ Slow iteration when actively developing SDK

### What We Want (using src/)

1. Change SDK source code
2. See changes immediately (no rebuild)
3. ✅ Impossible to push broken SDK code
4. ✅ Fast iteration (1-2 second restart)

## The Solution: Export Type Separation

To use `src/` directly with Bun, we need to split type and value exports:

**Current (doesn't work):**

```typescript
// Exports both types and values together
export * from "./messages/app-to-cloud";

export {
  RgbLedControlRequest, // ← interface (type)
  PhotoRequest, // ← interface (type)
  isPhotoRequest, // ← function (value)
} from "./messages/app-to-cloud";
```

**Fixed (works with Bun):**

```typescript
// Split into separate exports
export type {
  RgbLedControlRequest, // ← types only
  PhotoRequest,
} from "./messages/app-to-cloud";

export {
  isPhotoRequest, // ← values only
} from "./messages/app-to-cloud";
```

## The Challenge

**Manual approach:** 4-6 hours of tedious work

- ~50 export blocks across the SDK
- ~500 individual exports to classify (type vs value)
- Easy to miss one and break things
- Hard to maintain (every new export needs manual classification)

**ESLint auto-fix:** Doesn't handle `export *` statements

- `@typescript-eslint/consistent-type-exports` helps with explicit exports
- But can't automatically convert `export *` to explicit lists
- Still need manual work for the bulk of the changes

## Proposed Tool: `bun-type-export-fixer`

**What it does:**

1. Scan TypeScript files for `export *` statements
2. Use TypeScript Compiler API to analyze target modules
3. Classify each export as type or value
4. Replace with explicit `export type` and `export` statements

**Technology:** `ts-morph` (TypeScript AST manipulation library)

**Time to build:** 2-3 hours

**Time to run:** 5 minutes

**Reusable:** Could help other projects, publish as npm package

**See:** [tool-spec.md](./tool-spec.md) for detailed design

## Current Workaround

**Using dist/ with optimization:**

✅ Removed duplicate SDK build in Docker (saves 5-10 seconds per restart)
✅ Reliable - works everywhere, no edge cases
✅ Same as production (testing compiled output)
⚠️ Still need to manually rebuild when SDK changes

**Command:**

```bash
# When SDK changes
cd packages/sdk && bun run build

# Or rebuild Docker (includes SDK build)
cd ../.. && bun run dev:rebuild
```

## Status

- [x] Problem identified
- [x] Root cause understood (Bun limitation)
- [x] GitHub issue found (oven-sh/bun#7384)
- [x] Workaround implemented (use dist/, optimize Docker)
- [ ] Tool design spec written
- [ ] Tool implemented
- [ ] SDK exports converted
- [ ] Using src/ in development

## Next Steps

**Option A:** Build the tool now (2-3 hours investment)

- Pro: Instant SDK feedback in development
- Pro: Reusable for future projects
- Con: Time investment upfront

**Option B:** Wait for Bun to fix it (estimated 2-6 months)

- Pro: Zero work, automatic fix
- Con: Months of manual rebuilds
- Con: Risk of broken code being pushed

**Option C:** Keep current setup (using dist/)

- Pro: Zero additional work
- Pro: Already optimized Docker build
- Con: Manual rebuild required
- Con: Easy to forget and push broken code

## Metrics

**Current cost:**

- SDK rebuild: ~2-5 seconds (bun is fast)
- Docker restart: ~15 seconds total
- Frequency: ~10-20 times per day when actively developing SDK
- **Daily cost: 2.5-5 minutes**

**If we fix it:**

- No rebuild needed
- Docker restart: ~10 seconds (just cloud, not SDK)
- **Daily savings: 2.5-5 minutes**
- **Weekly savings: 15-35 minutes**

**Breakeven:** Tool pays for itself in ~2-4 weeks of active SDK development.

## Related Issues

- [monorepo-audit](../monorepo-audit/) - How we discovered this issue
- [GitHub: bun#7384](https://github.com/oven-sh/bun/issues/7384) - Upstream bug report
