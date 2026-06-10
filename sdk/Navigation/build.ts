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

// Single GCP key feeds every Google API the miniapp talks to:
// Maps JavaScript API (ui/lib/googleMaps.ts) and Places API (New)
// (background/lib/places.ts). Lacks the `EXPO_PUBLIC_` prefix on
// purpose — this miniapp manages its own env contract; the mobile-side
// host has its own separate key (`EXPO_PUBLIC_GOOGLE_NAV_API_KEY` in
// mobile/.env) that we deliberately don't share with.
const navKey = process.env.GOOGLE_NAV_API_KEY ?? ""
if (!navKey) console.warn("WARN: GOOGLE_NAV_API_KEY is not set — maps and search will fail.")

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
// Only announce when we're in production — that's the unusual case
// worth surfacing. Default dev rebuilds run silently so HMR doesn't
// spam the terminal three lines per file change.
if (nodeEnv === "production") console.log("Building with NODE_ENV=production")

const sharedDefine: Record<string, string> = {
  "process.env.GOOGLE_NAV_API_KEY": JSON.stringify(navKey),
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

// Silence on success — failures already print via the .success
// branches above. The dev-server's `reload →` line is the
// developer-facing confirmation that a rebuild + broadcast happened.
