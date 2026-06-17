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
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

// The GCP key now feeds ONLY the Maps JavaScript API (ui/lib/googleMaps.ts),
// which loads Google's script directly in the WebView and therefore can't be
// proxied — it stays in the UI bundle (public by necessity; lock it down
// GCP-side: restrict to Maps JS API + referrer + quota cap). Places (New) no
// longer reads this key at all; the background talks to the secret-proxy
// Worker instead, which holds the key server-side. So this key is injected
// into the UI bundle ONLY, never the background bundle.
const navKey = process.env.PUBLIC_MAP_NAV_VIEWER ?? ""
if (!navKey) console.warn("WARN: PUBLIC_MAP_NAV_VIEWER is not set — maps will fail to load.")

// Base URL of the secret-proxy Worker (sdk/Navigation/worker). The background's
// Places client (background/lib/places.ts) calls this instead of Google.
const proxyBaseUrl = process.env.PROXY_BASE_URL ?? ""
if (!proxyBaseUrl) console.warn("WARN: PROXY_BASE_URL is not set — place search will fail.")

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
// Only announce when we're in production — that's the unusual case
// worth surfacing. Default dev rebuilds run silently so HMR doesn't
// spam the terminal three lines per file change.
if (nodeEnv === "production") console.log("Building with NODE_ENV=production")

// Background: Places via proxy only — the GCP key is deliberately NOT injected
// here, so it can never appear in the shipped background bundle.
const backgroundDefine: Record<string, string> = {
  "process.env.PROXY_BASE_URL": JSON.stringify(proxyBaseUrl),
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
}

// UI: needs the Maps JS key (can't be proxied). PROXY_BASE_URL is harmless here
// and kept for parity in case the UI ever calls the proxy directly.
const uiDefine: Record<string, string> = {
  "process.env.PUBLIC_MAP_NAV_VIEWER": JSON.stringify(navKey),
  "process.env.PROXY_BASE_URL": JSON.stringify(proxyBaseUrl),
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
}

// Background: IIFE, no DOM. The JSContext loads this once.
const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define: backgroundDefine,
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
  define: uiDefine,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

// Silence on success — failures already print via the .success
// branches above. The dev-server's `reload →` line is the
// developer-facing confirmation that a rebuild + broadcast happened.
