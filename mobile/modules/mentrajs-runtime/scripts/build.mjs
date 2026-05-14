#!/usr/bin/env node
// MentraJS polyfill bundle builder.
//
// Reads src/startup.ts and emits a single IIFE at dist/startup.js plus a
// copy under assets/startup.js so the iOS Expo module + Android crust
// AssetManager can both `Bundle.module.url(...)` / `assets.open("startup.js")`
// without having to reach into node_modules.
//
// Pure esbuild — no plugins. The polyfill must not depend on Node-only
// modules at runtime; this is just a one-file transform-and-inline.

import {build} from "esbuild"
import {mkdirSync, copyFileSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const distDir = resolve(root, "dist")
const assetsDir = resolve(root, "assets")
mkdirSync(distDir, {recursive: true})
mkdirSync(assetsDir, {recursive: true})

const outFile = resolve(distDir, "startup.js")

await build({
  entryPoints: [resolve(root, "src/startup.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  // Both engines (iOS-JSC 18+ and QuickJS-NG via Zipline) support ES2020.
  // No minify in dev so stack traces stay readable; the host can re-bundle
  // for prod if/when binary size becomes a thing.
  minify: false,
  legalComments: "none",
  // Treat everything as a global — no module wrapping. The IIFE inside
  // startup.ts already isolates locals from the host scope.
  globalName: undefined,
  platform: "neutral",
  // Tree-shake unused imports. types.ts is type-only and gets stripped.
  treeShaking: true,
  // Crash early on any unexpected dependency. The polyfill should be 100%
  // self-contained.
  external: [],
  outfile: outFile,
  banner: {
    js: "// @generated MentraJS polyfill bundle — see mobile/modules/mentrajs-runtime",
  },
})

// Mirror to assets/ so consumers can ship it with the host binary without
// reaching into dist (which is gitignored in CI environments that wipe build
// artifacts before the prebuild step).
copyFileSync(outFile, resolve(assetsDir, "startup.js"))

console.log(`✅ MentraJS startup bundle built → ${outFile}`)
