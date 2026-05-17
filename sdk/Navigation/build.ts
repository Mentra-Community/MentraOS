/**
 * Production build script — two-output bundle.
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — JSContext entry (no DOM, IIFE).
 *   dist/ui/index.html + ...  — WebView entry (full DOM, Tailwind v4).
 *
 * Env vars whose name starts with `EXPO_PUBLIC_` are inlined into both
 * bundles via `define`. Anything inlined into the UI bundle is visible
 * in WebView source maps; secrets MUST live behind the developer's own
 * backend, not in EXPO_PUBLIC_*.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const navKey = process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY ?? ""
const placesKey = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ?? ""
if (!navKey) console.warn("WARN: EXPO_PUBLIC_GOOGLE_NAV_API_KEY is not set — maps will fail to load.")
if (!placesKey) console.warn("WARN: EXPO_PUBLIC_GOOGLE_PLACES_API_KEY is not set — search will fail.")

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
console.log(`Building with NODE_ENV=${nodeEnv}`)

const sharedDefine: Record<string, string> = {
  "process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY": JSON.stringify(navKey),
  "process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY": JSON.stringify(placesKey),
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
}

// Background: IIFE, no DOM. The JSContext loads this once.
const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define: sharedDefine,
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
  plugins: [tailwind],
  minify: true,
  define: sharedDefine,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

console.log(`Built background (${backgroundResult.outputs.length}) + UI (${uiResult.outputs.length}) files into ${distDir}/`)
