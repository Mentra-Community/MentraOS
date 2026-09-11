#!/usr/bin/env node
// MentraJS polyfill bundle builder.
//
// Reads src/startup.ts and emits a single IIFE at assets/startup.js.
// That assets/ file is the *single committed source of truth* for the
// polyfill. Native modules pick it up via:
//   - Android: crust's build.gradle adds `../../jspolyfill/assets`
//              to `sourceSets.main.assets.srcDirs`. Gradle accepts cross-
//              module sourceSet paths, so the file ships from the canonical
//              location.
//   - iOS: CocoaPods *silently* drops `..` paths from `resource_bundles`,
//              so the asset bundle would otherwise ship empty. We mirror
//              startup.js into `../crust/ios/Resources/` (gitignored) and
//              point the podspec at that local path. The mirror is
//              regenerated on every build, so it can't drift from assets/.
// A copy is also written to dist/ so tests + tooling can resolve it via
// the package's standard exports path.
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
    js: "// @generated MentraJS polyfill bundle — see mobile/modules/jspolyfill",
  },
})

// Mirror to assets/ — the committed source of truth that Android picks
// up via `sourceSets.main.assets.srcDirs += '../../jspolyfill/assets'`.
const assetsFile = resolve(assetsDir, "startup.js")
copyFileSync(outFile, assetsFile)

// iOS pod resource: CocoaPods silently drops `..` paths from
// `resource_bundles`, so pointing the podspec at the assets/ directory
// across the module boundary produces an empty MentraJSRuntime.bundle
// (verified — only Info.plist ends up inside). Mirror startup.js into a
// LOCAL path the podspec can glob without crossing pod roots. This file
// is gitignored — every build regenerates it, so it can't drift.
const iosResourceDir = resolve(root, "..", "crust", "ios", "Resources")
mkdirSync(iosResourceDir, {recursive: true})
const iosResourceFile = resolve(iosResourceDir, "startup.js")
copyFileSync(outFile, iosResourceFile)

console.log(`✅ MentraJS startup bundle built → ${assetsFile}`)
console.log(`✅ iOS pod resource mirror      → ${iosResourceFile}`)
