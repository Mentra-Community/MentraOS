# Monorepo Setup Audit

## Problem

You have to run `bun run build` in the SDK every time you change SDK code before cloud sees it. This sucks.

## Documents

- **[analysis.md](analysis.md)** - Root cause, solutions, action plan

## Quick Answer

**Root cause**: Cloud's `tsconfig.json` has this:

```json
"paths": {
  "@mentra/sdk": ["../sdk/dist"]  // ← Forces use of compiled output
}
```

**SDK's "development" export doesn't help**:

```json
"exports": {
  "development": { "import": "./src/index.ts" },  // ← Only if NODE_ENV=development
  "default": { "import": "./dist/index.js" }      // ← Your custom ENVs use this
}
```

Since you use `NODE_ENV=isaiah`, `NODE_ENV=staging`, etc., the "development" condition never triggers.

**The fix**: Change tsconfig path to point to source instead of dist.

## Quick Test (5 minutes)

```bash
# 1. Edit cloud/packages/cloud/tsconfig.json
# Change from: "@mentra/sdk": ["../sdk/dist"]
# To:         "@mentra/sdk": ["../sdk/src"]

# 2. Restart your editor's TypeScript server

# 3. Test it
cd cloud
bun run dev

# In another terminal, edit packages/sdk/src/types/capabilities.ts
# Change should be visible immediately without rebuild
```

## Why This Happened

Early monorepo mistake - pointed tsconfig to `dist/` instead of `src/`.

The SDK's "development" export condition doesn't help because you use custom NODE_ENV values (`isaiah`, `staging`, `east-asia-prod`) instead of `NODE_ENV=development`.

Bun can run TypeScript directly. We don't need the build step in development.

## Status

- [x] Problem identified
- [x] Root cause found
- [x] Solution documented
- [ ] Fix tested
- [ ] Fix committed

## Next Steps

1. Try the quick test above
2. If it works: commit it
3. If it breaks: read analysis.md for debugging steps
4. Apply same fix to @mentra/types when we create it

---

**Time to fix**: 2 minutes (change one line in tsconfig)  
**Risk**: Very low (easy to revert)  
**Upside**: Never rebuild SDK in dev again  
**Works with**: Any NODE_ENV value (isaiah, staging, prod, etc.)
