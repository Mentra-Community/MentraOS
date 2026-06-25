/**
 * Minimal two-layer miniapp build.
 *
 * Emits:
 *   dist/background/index.js  - JSContext bundle, evaluated as a classic script
 *   dist/ui/index.html        - tiny WebView companion UI
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
})

if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  minify: true,
})

if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

console.log("built selectable-list-demo -> dist/background/index.js + dist/ui")
