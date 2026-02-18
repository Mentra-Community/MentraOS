# Quick Fix: Stop Rebuilding SDK

## The One-Line Fix

**File**: `cloud/packages/cloud/tsconfig.json`

**Change this**:

```json
"paths": {
  "@mentra/sdk": ["../sdk/dist"],
  "bun-types": ["./node_modules/bun-types"]
}
```

**To this**:

```json
"paths": {
  "@mentra/sdk": ["../sdk/src"],
  "bun-types": ["./node_modules/bun-types"]
}
```

## Test It (30 seconds)

```bash
# 1. Restart TypeScript server in your editor
# VSCode/Cursor: Cmd+Shift+P → "TypeScript: Restart TS Server"

# 2. Start dev server
cd cloud
bun run dev

# 3. Edit any SDK file (in another terminal)
# Example: packages/sdk/src/types/capabilities.ts
# Add a comment, change a type, whatever

# 4. Check that cloud sees the change immediately (no rebuild!)
```

## Why This Works

- Bun runs TypeScript directly (no compilation needed)
- TypeScript now resolves `@mentra/sdk` to source files
- Works with any NODE_ENV value (`isaiah`, `staging`, `prod`, etc.)
- Changes are instant

## Production Still Works

Your production build scripts already compile SDK to `dist/`:

- `bun run build` in SDK package
- Docker builds compile everything
- Published package uses `dist/`

This only affects local development.

## If It Breaks

**Symptom**: "Cannot find module '@mentra/sdk'"

**Fix**:

```bash
cd cloud
rm -rf node_modules
bun install
# Restart your editor
```

**Still broken?** Read `analysis.md` for debugging steps.

## Revert If Needed

Just change it back to `../sdk/dist`. Takes 5 seconds.

---

**That's it. One line. Two minutes. Never rebuild SDK again.**
