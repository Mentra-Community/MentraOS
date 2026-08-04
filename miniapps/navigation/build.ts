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

import {resolveMapboxBuildToken} from "./buildConfig"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

// App version, read from miniapp.json so there's a single source of truth.
// Inlined into the UI bundle (and harmless in the background bundle) so the
// dev panel can show which build is running.
const miniapp = (await import("./miniapp.json")) as {version?: string}
const appVersion = miniapp.version ?? "0.0.0"

// The GCP key now feeds ONLY the Maps JavaScript API (ui/lib/googleMaps.ts),
// which loads Google's script directly in the WebView and therefore can't be
// proxied — it stays in the UI bundle (public by necessity; lock it down
// GCP-side: restrict to Maps JS API + referrer + quota cap). Places (New) no
// longer reads this key at all; the background talks to the secret-proxy
// Worker instead, which holds the key server-side. So this key is injected
// into the UI bundle ONLY, never the background bundle.
const navKey = process.env.PUBLIC_MAP_NAV_VIEWER ?? ""
if (!navKey) console.warn("WARN: PUBLIC_MAP_NAV_VIEWER is not set — maps will fail to load.")

// Mapbox GL JS token (pk.…) for the front-end map (Mapbox migration). Same
// public token as mobile's EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN. Injected into the
// UI bundle only (the background bundle never renders a map). Replaces
// PUBLIC_MAP_NAV_VIEWER once NavMap.tsx is ported to Mapbox GL JS; kept
// alongside it during the transition so both map paths can build.
const mapboxToken = resolveMapboxBuildToken(process.env)
if (!mapboxToken) console.warn("WARN: No public Mapbox token is set — Mapbox GL JS map will fail to load.")

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
// Only announce when we're in production — that's the unusual case
// worth surfacing. Default dev rebuilds run silently so HMR doesn't
// spam the terminal three lines per file change.
if (nodeEnv === "production") console.log("Building with NODE_ENV=production")

// Background: no maps/provider keys are injected — place search and geocoding
// go through the SDK → host → v2 cloud maps service, which holds the token.
const backgroundDefine: Record<string, string> = {
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  "process.env.APP_VERSION": JSON.stringify(appVersion),
}

// UI: needs the public map-render tokens client-side (GL JS can't proxy tile
// fetches). These are public, render-only tokens — not provider secrets.
const uiDefine: Record<string, string> = {
  "process.env.PUBLIC_MAP_NAV_VIEWER": JSON.stringify(navKey),
  "process.env.PUBLIC_MAPBOX_TOKEN": JSON.stringify(mapboxToken),
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  "process.env.APP_VERSION": JSON.stringify(appVersion),
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

// Force a SINGLE React copy in the UI bundle. The @mentra/miniapp SDK is
// symlinked and can resolve its own (different-version) React from a separate
// node_modules, which produces two React instances → "Invalid hook call /
// more than one copy of React". This plugin rewrites every react / react-dom
// (and their sub-paths) import to THIS app's copy, so app components and SDK
// hooks share one React.
const reactDedupePlugin: import("bun").BunPlugin = {
  name: "react-dedupe",
  setup(build) {
    const appDir = import.meta.dir
    const pin = (spec: string) => Bun.resolveSync(spec, appDir)
    // Match `react`, `react-dom`, and their sub-paths (e.g. react/jsx-runtime).
    build.onResolve({filter: /^react(-dom)?(\/.*)?$/}, (args) => {
      try {
        return {path: pin(args.path)}
      } catch {
        return undefined // fall back to default resolution
      }
    })
  },
}

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [reactDedupePlugin, tailwind],
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
