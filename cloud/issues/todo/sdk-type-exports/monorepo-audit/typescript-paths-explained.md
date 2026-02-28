# TypeScript "paths" Explained

## The Confusion

When you write this in your code:

```typescript
import { Capabilities } from "@mentra/sdk";
```

**Three different systems** need to understand what `@mentra/sdk` means:

1. **TypeScript** (type checking, IDE autocomplete)
2. **Package Manager** (bun/npm - installing dependencies)
3. **Runtime** (bun/node - actually loading the code)

The `"paths"` config is **only for #1 (TypeScript)**.

---

## What Each System Does

### 1. TypeScript (tsconfig.json "paths")

```json
"paths": {
  "@mentra/sdk": ["../sdk/src"]
}
```

**Purpose**: Tell TypeScript's compiler where to find type definitions for autocomplete and error checking.

**Used by**:

- Your editor's IntelliSense/autocomplete
- `tsc` when type-checking
- TypeScript language server

**NOT used by**:

- Bun when running your code
- Node when running your code
- Your build output

**Development only?** Yes, mostly. It helps your IDE and `tsc` understand your code.

---

### 2. Package Manager (package.json dependencies)

```json
"dependencies": {
  "@mentra/sdk": "workspace:*"
}
```

**Purpose**: Tell bun/npm to link the workspace package.

**Used by**:

- `bun install` to create symlinks in node_modules
- Creates: `node_modules/@mentra/sdk` → `../../packages/sdk`

**What happens**:

```bash
$ bun install
# Creates: cloud/packages/cloud/node_modules/@mentra/sdk
#          ↓ (symlink)
#          cloud/packages/sdk
```

---

### 3. Runtime (bun/node module resolution)

**Purpose**: Actually load the code when your app runs.

**How it works**:

1. See `import { X } from "@mentra/sdk"`
2. Look in `node_modules/@mentra/sdk/` (finds symlink)
3. Follow symlink to `../../packages/sdk`
4. Read `package.json` → check `"main"` or `"exports"`
5. Load that file

**In your case**:

```json
// packages/sdk/package.json
{
  "main": "dist/index.js",
  "exports": {
    "development": { "import": "./src/index.ts" },
    "default": { "import": "./dist/index.js" }
  }
}
```

Bun will:

- Follow symlink to `packages/sdk/`
- See `"main": "dist/index.js"` (or check exports)
- Load that file

**But**: The "development" export only works if `NODE_ENV=development`, which you don't use.

---

## Your Specific Case

### Before (the problem)

```json
// tsconfig.json
"paths": {
  "@mentra/sdk": ["../sdk/dist"]
}
```

```json
// package.json
"dependencies": {
  "@mentra/sdk": "workspace:*"
}
```

**What happened**:

1. **TypeScript**: Looks at `../sdk/dist/index.d.ts` for types
2. **Bun install**: Creates symlink `node_modules/@mentra/sdk` → `../sdk`
3. **Bun runtime**: Follows symlink, reads `package.json`, loads `dist/index.js`

**Result**: Everyone uses `dist/`. You must rebuild SDK for TypeScript to see changes.

---

### After (the fix)

```json
// tsconfig.json
"paths": {
  "@mentra/sdk": ["../sdk/src"]  // ← Changed
}
```

```json
// package.json (unchanged)
"dependencies": {
  "@mentra/sdk": "workspace:*"
}
```

**What happens**:

1. **TypeScript**: Looks at `../sdk/src/index.ts` for types ✅
2. **Bun install**: Still creates symlink (unchanged)
3. **Bun runtime**: Still loads from... wait, what does it load?

---

## The Key Question: What Does Bun Actually Load?

This is where it gets interesting.

**Bun can run TypeScript directly**. So when bun follows the symlink and reads `package.json`, it sees:

```json
"main": "dist/index.js"
```

**Two possibilities**:

### Possibility 1: Bun uses "main" → loads dist/index.js

- You'd still need to rebuild for runtime changes
- But TypeScript would see changes immediately (for IDE/type-checking)
- Still an improvement!

### Possibility 2: Bun is smart and uses src in dev mode

- Some tools (like Vite) detect monorepos and use source files
- Bun might do this too (needs testing)
- If so, both TypeScript AND runtime see changes immediately

**Which one happens?** We need to test to find out!

---

## Testing What Bun Actually Loads

```bash
# 1. Start cloud dev server
cd cloud
bun run dev

# 2. Add a console.log to SDK source
echo "console.log('🔍 LOADED FROM SOURCE');" >> packages/sdk/src/index.ts

# 3. Restart cloud server
# Look for the log message

# If you see it: Bun is loading from source! ✅
# If you don't: Bun is loading from dist (but TypeScript still improved)
```

---

## Why "paths" Exists

**TypeScript's Problem**: It doesn't know about symlinks or workspace protocols.

When TypeScript sees:

```typescript
import { X } from "@mentra/sdk";
```

It needs to resolve this to a **physical file path** to read the types.

Without `"paths"`, TypeScript would:

1. Look in `node_modules/@mentra/sdk`
2. Find a symlink (but TypeScript doesn't follow symlinks well)
3. Get confused or fail

With `"paths"`, you tell TypeScript explicitly:

> "When you see `@mentra/sdk`, look in `../sdk/src` instead"

---

## Is "paths" Only for Development?

**Mostly yes, with caveats**:

### Development (main use)

- Your IDE uses it for autocomplete
- `tsc --noEmit` uses it for type checking
- Helps you catch errors before running code

### Production Build

- If you run `tsc` to compile TypeScript → JavaScript, it uses "paths" during compilation
- BUT: The output JavaScript doesn't have paths (they're resolved to relative paths)
- So the built code doesn't need it

### Production Runtime

- Bun/Node never look at tsconfig.json
- They only care about package.json and node_modules
- "paths" is irrelevant at runtime

---

## Common Misconception

**WRONG**: "Changing paths will change what code runs"

**CORRECT**: "Changing paths will change what TypeScript/IDE sees. Runtime might be different."

---

## Summary

| System              | Config                          | What It Does                    |
| ------------------- | ------------------------------- | ------------------------------- |
| **TypeScript**      | `tsconfig.json` "paths"         | Find types for IDE/checking     |
| **Package Manager** | `package.json` "dependencies"   | Create symlinks in node_modules |
| **Runtime**         | `package.json` "main"/"exports" | Load actual code                |

In a monorepo:

- Package manager creates symlinks (workspace:\*)
- TypeScript uses "paths" to find types
- Runtime follows symlinks and uses package.json

**Our fix**: Changed TypeScript's "paths" to point to `src` instead of `dist`.

**Result**: TypeScript/IDE sees source immediately. Runtime behavior TBD (test it!).

---

## Quick Reference

**Before**:

```json
"paths": { "@mentra/sdk": ["../sdk/dist"] }
```

→ TypeScript looks at compiled output  
→ Must rebuild for IDE to see changes

**After**:

```json
"paths": { "@mentra/sdk": ["../sdk/src"] }
```

→ TypeScript looks at source files  
→ IDE sees changes immediately  
→ Runtime behavior: test to confirm

---

**TL;DR**: "paths" is TypeScript's way of finding files. It's mainly for your IDE and type checking, not for what code actually runs. But in a bun monorepo with native TypeScript support, fixing the paths _might_ fix both IDE and runtime (needs testing).
