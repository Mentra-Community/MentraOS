# Tool Spec: bun-type-export-fixer

## Overview

A CLI tool that automatically converts TypeScript `export *` statements into separate `export type` and `export` statements for Bun runtime compatibility.

## Problem Statement

Bun's runtime TypeScript execution fails when re-exporting types:

```typescript
// This fails in Bun
export * from "./module"; // Tries to re-export interfaces (doesn't exist at runtime)

// This works in Bun
export type { MyInterface } from "./module"; // Types only
export { myFunction } from "./module"; // Values only
```

## Tool Requirements

### Input

- Target directory or file path
- Configuration options (optional)

### Output

- Modified TypeScript files with split exports
- Summary report of changes

### Features

- Analyze `export *` statements
- Classify exports as types or values using TypeScript Compiler API
- Replace with explicit `export type` and `export` statements
- Preserve comments and formatting
- Dry-run mode (preview without changes)
- Backup original files

## Technical Design

### Technology Stack

**Primary:** `ts-morph` (TypeScript AST manipulation)

- Built on TypeScript Compiler API
- High-level API for code transformations
- Handles formatting and preservation

**Alternative:** Raw TypeScript Compiler API

- More control, more complex
- Use if ts-morph doesn't meet needs

### Algorithm

```
1. Parse target file(s)
2. Find all export declarations
3. For each "export *" statement:
   a. Get module specifier (e.g., "./messages/app-to-cloud")
   b. Load source file for that module
   c. Get all exported declarations
   d. Classify each export:
      - Interface → type
      - Type alias → type
      - Enum → value (runtime construct)
      - Function → value
      - Class → value
      - Const/let/var → value
   e. Group into types[] and values[]
   f. Replace "export *" with:
      - "export type { ...types } from 'module';"
      - "export { ...values } from 'module';"
4. For each "export { ... }" statement with mixed types/values:
   a. Classify each exported name
   b. Split into separate export statements
5. Save modified file
6. Report changes
```

### Implementation Pseudo-code

```typescript
import { Project, SyntaxKind } from "ts-morph";

interface ExportAnalysis {
  types: string[];
  values: string[];
}

function analyzeExports(targetFile: SourceFile): ExportAnalysis {
  const types: string[] = [];
  const values: string[] = [];

  targetFile.getExportedDeclarations().forEach((decls, name) => {
    decls.forEach((decl) => {
      const kind = decl.getKind();

      if (
        kind === SyntaxKind.InterfaceDeclaration ||
        kind === SyntaxKind.TypeAliasDeclaration ||
        kind === SyntaxKind.TypeParameter
      ) {
        types.push(name);
      } else {
        values.push(name);
      }
    });
  });

  return { types, values };
}

function fixFile(filePath: string, options: Options) {
  const project = new Project({
    tsConfigFilePath: options.tsconfig || "tsconfig.json",
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  const exportDeclarations = sourceFile.getExportDeclarations();

  exportDeclarations.forEach((exp) => {
    // Handle "export *"
    if (exp.isNamespaceExport() || !exp.getNamedExports().length) {
      const moduleSpecifier = exp.getModuleSpecifierValue();
      if (!moduleSpecifier) return;

      const targetFile = exp.getModuleSpecifierSourceFile();
      if (!targetFile) {
        console.warn(`Cannot resolve: ${moduleSpecifier}`);
        return;
      }

      const { types, values } = analyzeExports(targetFile);

      // Replace with explicit exports
      const newExports = [];

      if (types.length > 0) {
        newExports.push(
          `export type { ${types.join(", ")} } from "${moduleSpecifier}";`,
        );
      }

      if (values.length > 0) {
        newExports.push(
          `export { ${values.join(", ")} } from "${moduleSpecifier}";`,
        );
      }

      exp.replaceWithText(newExports.join("\n"));
    }

    // Handle "export { ... }" with mixed types/values
    else {
      const namedExports = exp.getNamedExports();
      const moduleSpecifier = exp.getModuleSpecifierValue();
      if (!moduleSpecifier) return;

      const targetFile = exp.getModuleSpecifierSourceFile();
      if (!targetFile) return;

      const types: string[] = [];
      const values: string[] = [];

      namedExports.forEach((namedExport) => {
        const name = namedExport.getName();
        const decls = targetFile.getExportedDeclarations().get(name);

        if (!decls || decls.length === 0) return;

        const decl = decls[0];
        const kind = decl.getKind();

        if (
          kind === SyntaxKind.InterfaceDeclaration ||
          kind === SyntaxKind.TypeAliasDeclaration
        ) {
          types.push(name);
        } else {
          values.push(name);
        }
      });

      // If mixed, split into two exports
      if (types.length > 0 && values.length > 0) {
        const newExports = [];

        newExports.push(
          `export type { ${types.join(", ")} } from "${moduleSpecifier}";`,
        );
        newExports.push(
          `export { ${values.join(", ")} } from "${moduleSpecifier}";`,
        );

        exp.replaceWithText(newExports.join("\n"));
      }
      // If all types, add "type" keyword
      else if (types.length > 0 && values.length === 0) {
        exp.setIsTypeOnly(true);
      }
    }
  });

  if (!options.dryRun) {
    sourceFile.saveSync();
  }

  return {
    file: filePath,
    modified: sourceFile.wasForgotten() === false,
  };
}
```

## CLI Interface

### Command

```bash
bun-type-export-fixer [options] <path>
```

### Options

```
-d, --dry-run          Preview changes without modifying files
-b, --backup           Create .backup files before modifying
-c, --config <path>    Path to tsconfig.json (default: ./tsconfig.json)
-i, --ignore <pattern> Glob pattern to ignore (can be repeated)
-v, --verbose          Show detailed output
-h, --help             Show help
```

### Examples

```bash
# Preview changes
bun-type-export-fixer --dry-run src/types/index.ts

# Fix a single file
bun-type-export-fixer src/types/index.ts

# Fix entire directory
bun-type-export-fixer src/types/

# Fix with backup
bun-type-export-fixer --backup src/types/

# Fix SDK package
bun-type-export-fixer packages/sdk/src/
```

## Output Format

### Success

```
🔍 Analyzing exports...

📁 src/types/index.ts
  ✓ export * from "./messages/app-to-cloud"
    → Split into 23 types, 14 values
  ✓ export { RgbLedControlRequest, isRgbLedControlRequest } from "..."
    → Split into 1 type, 1 value

✅ Modified 1 file
   - Types converted: 24
   - Values preserved: 15
   - Total exports: 39
```

### Dry Run

```
🔍 Analyzing exports... (DRY RUN)

📁 src/types/index.ts
  [WOULD CHANGE] export * from "./messages/app-to-cloud"
    → export type { RgbLedControlRequest, PhotoRequest, ... } from "..."
    → export { isRgbLedControlRequest, isPhotoRequest, ... } from "..."

ℹ️  No files modified (dry run mode)
   Run without --dry-run to apply changes
```

### Errors

```
❌ Error processing src/types/index.ts
   Cannot resolve module: "./missing-module"

⚠️  Skipped 1 file due to errors
```

## Edge Cases

### Enums (Special Case)

TypeScript enums are **values** (they exist at runtime):

```typescript
export enum MyEnum {
  A,
  B,
  C,
} // ← Runtime value, not just type
```

Tool must classify enums as **values**, not types.

### Type-only re-exports

Some modules only export types:

```typescript
// types-only-module.ts
export interface A {}
export type B = string;
```

Tool should detect this and only generate `export type`:

```typescript
export type { A, B } from "./types-only-module";
```

### Aliased exports

```typescript
export { Something as SomethingElse } from "./module";
```

Tool should preserve aliases:

```typescript
export type { Something as SomethingElse } from "./module";
```

### Namespace exports

```typescript
export * as namespace from "./module";
```

This is complex - tool should either:

- Skip with warning (recommend manual fix)
- Or split the namespace (advanced)

### Comments and formatting

Preserve comments:

```typescript
// Important note about this export
export * from "./module";
```

Should become:

```typescript
// Important note about this export
export type { ... } from "./module";
export { ... } from "./module";
```

## Testing Strategy

### Unit Tests

- Test export classification (type vs value)
- Test AST manipulation
- Test edge cases (enums, aliases, namespaces)

### Integration Tests

Real SDK files:

- `src/types/index.ts` (complex re-exports)
- `src/app/session/index.ts` (mixed exports)
- `src/types/messages/app-to-cloud.ts` (source module)

### Validation

After running tool:

1. `bun run build` (should compile without errors)
2. `bun --watch src/index.ts` (should run without "export not found" errors)
3. Git diff review (ensure changes make sense)

## Package Structure

```
bun-type-export-fixer/
├── src/
│   ├── cli.ts           # CLI entry point
│   ├── analyzer.ts      # Export analysis logic
│   ├── transformer.ts   # AST transformation
│   └── reporter.ts      # Output formatting
├── tests/
│   ├── fixtures/        # Test TypeScript files
│   └── analyzer.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Dependencies

```json
{
  "dependencies": {
    "ts-morph": "^21.0.0",
    "commander": "^11.0.0",
    "chalk": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "bun-types": "^1.0.0"
  }
}
```

## Installation

```bash
# Install globally
bun install -g bun-type-export-fixer

# Or run directly with bunx
bunx bun-type-export-fixer src/types/
```

## Future Enhancements

- **Config file:** `.type-export-fixer.json` for project-specific settings
- **Watch mode:** Automatically fix exports on file changes
- **VSCode extension:** Fix exports on save
- **CI integration:** Fail builds if unfixed exports detected
- **Auto-detect bun projects:** Only run in projects using Bun
- **Incremental mode:** Only process changed files

## Success Criteria

✅ Tool runs on SDK without errors
✅ Modified SDK compiles with `tsc`
✅ Modified SDK runs with `bun src/index.ts`
✅ No "export not found" errors
✅ All tests pass
✅ Code review shows sensible changes
✅ Formatting and comments preserved

## Timeline Estimate

- **Setup project:** 30 minutes
- **Core analyzer:** 1 hour
- **Transformer logic:** 1 hour
- **CLI interface:** 30 minutes
- **Testing:** 1 hour
- **Documentation:** 30 minutes
- **Total:** ~4.5 hours (padded for debugging)

## Alternative: Quick Script

If full tool is overkill, a simpler 100-line script could handle just our SDK:

```typescript
// quick-fix.ts
// Hard-coded for our specific SDK structure
// Just fixes src/types/index.ts and src/app/session/index.ts
// No CLI, no fancy features, just gets it done
```

Time: ~1 hour
