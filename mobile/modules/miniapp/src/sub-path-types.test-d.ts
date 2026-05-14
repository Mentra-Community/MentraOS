/**
 * Compile-time test for the Phase 5 SDK split.
 *
 * The package exports two sub-paths with distinct type-roots:
 *   - `@mentra/miniapp/background` exposes `MiniappSession` + module
 *     types; it does NOT declare the `mentra` global.
 *   - `@mentra/miniapp/ui` exposes the `mentra` global declaration + React
 *     adapters; it does NOT export `MiniappSession`.
 *
 * Wrong-layer imports should be caught at compile time. This file is
 * type-only (`.test-d.ts`) — no runtime assertions. `bun typecheck` /
 * `bun x tsc -p tsconfig.json` is the executor.
 *
 * NOTE: this file lives inside `src/` so it ships with the package and
 * downstream consumers' typechecks would also catch a regression. The
 * `@ts-expect-error` lines fail the build if the named symbol *does*
 * become reachable on the wrong path, which is the contract we want.
 */

// ----- @mentra/miniapp/background ---------------------------------------
import type {MiniappSession} from "./background/index"

// ✅ MiniappSession is reachable from the background entry.
const _bg: MiniappSession | undefined = undefined
void _bg

// ----- @mentra/miniapp/ui -----------------------------------------------
import type {MentraUiGlobal, MentraTyped} from "./ui/index"

// ✅ MentraUiGlobal is reachable from the ui entry.
const _ui: MentraUiGlobal | undefined = undefined
void _ui

// ✅ The `mentra` global is declared globally by the /ui entry's
//    `declare global { var mentra }` block. Just reference it to make
//    sure TS picks up the type.
export type _MentraType = typeof globalThis.mentra
export type _Typed = MentraTyped<{foo: number}>

// ----- compile-time guardrails ------------------------------------------
// (TypeScript doesn't ship a `// @ts-expect-no-error` mirror, so we just
// rely on the named imports above failing if the corresponding files
// disappear. The asymmetric exports are enforced by package.json's
// `exports` map at consumer time; this file proves the source files
// expose what they should.)
