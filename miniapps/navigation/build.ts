/**
 * Production build script — two-output bundle.
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — JSContext entry (no DOM, IIFE).
 *   dist/ui/index.html + ...  — WebView entry (full DOM, Tailwind v4).
 *
 * PUBLIC_MAPBOX_TOKEN (see .env.example) is inlined into the UI bundle via
 * `define`. Anything inlined into the UI bundle is visible in WebView source
 * maps; secrets MUST live behind the developer's own backend.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

// App version, read from miniapp.json so there's a single source of truth.
// Inlined into the UI bundle (and harmless in the background bundle) so the
// dev panel can show which build is running.
const miniapp = (await import("./miniapp.json")) as {version?: string}
const appVersion = miniapp.version ?? "0.0.0"

// Mapbox GL JS needs a public tiles token in the UI bundle.
const mapboxToken = process.env.PUBLIC_MAPBOX_TOKEN
if (!mapboxToken) {
  console.error("Missing PUBLIC_MAPBOX_TOKEN. Run `cp .env.example .env` or set it in the environment.")
  process.exit(1)
}

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
