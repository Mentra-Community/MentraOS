/**
 * Production build script — two-output bundle (mirrors the captions miniapp).
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — the JSContext entry. JSC + Zipline/QuickJS
 *                                evaluate this as a classic script, so ESM
 *                                `export` keywords are syntax errors there;
 *                                we emit an IIFE and bundle
 *                                `@mentra/miniapp/background` in (the
 *                                JSContext has no module resolver).
 *   dist/ui/index.html + ...  — the WebView entry (full DOM, Tailwind v4
 *                                compiled via bun-plugin-tailwind).
 *
 * Env vars whose name starts with `MENTRA_PUBLIC_` are inlined into both
 * bundles via `define`.
 */

import {rm} from "fs/promises"
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const define: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
  }
}

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define,
})
if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const tailwind = (await import("bun-plugin-tailwind")).default

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [tailwind, reactSingletonPlugin(import.meta.url)],
  minify: true,
  define,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

console.log("built recorder -> dist/background/index.js + dist/ui")
