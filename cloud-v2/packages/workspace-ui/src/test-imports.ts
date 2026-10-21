/**
 * What a module pulls in at run time, for the tests that keep a module's imports small (a screen that doesn't
 * use billing must not carry the contract's schemas, and zod with them). Not exported from the package: tests only.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Every module `entry` (a path under `src/`) reaches through runtime imports (type-only imports are gone), as
 * written in the source: the files of this package it visits and every specifier it names.
 */
export function runtimeImports(entry: string): { files: string[]; specifiers: string[] } {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    for (const { path } of new Bun.Transpiler({ loader }).scanImports(readFileSync(file, "utf8"))) {
      specifiers.add(path);
      if (!path.startsWith(".")) continue;
      const base = join(dirname(file), path);
      const next = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((candidate) => existsSync(candidate));
      if (next) visit(next);
    }
  };
  visit(join(import.meta.dir, entry));
  return { files: [...files], specifiers: [...specifiers] };
}

/**
 * The specifiers that bring in the contract's billing schemas or zod. `portal-billing-icons` is the contract's
 * icon rule on its own, with no zod, so it is not one of them.
 */
export const SCHEMA_SPECIFIER = /portal-billing(?!-icons)|^zod/;
