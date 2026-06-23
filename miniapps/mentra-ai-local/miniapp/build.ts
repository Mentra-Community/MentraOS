/**
 * Production build script — two-output bundle.
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — the JSContext entry (no DOM). The Mentra AI
 *                                pipeline (transcription → agent → speak/
 *                                display) runs entirely here.
 *   dist/ui/index.html + ...  — the WebView entry (full DOM, Tailwind v4
 *                                compiled via bun-plugin-tailwind). The chat
 *                                interface lives here.
 *
 * Env vars whose name starts with `MENTRA_PUBLIC_` are inlined into BOTH
 * bundles via `define`. For Mentra AI that is ONLY the backend URL
 * (MENTRA_PUBLIC_MENTRA_AI_BACKEND_URL). No AI keys are inlined — the agent
 * tool-loop, visual classifier, and web search all run on the backend, which
 * holds the Gemini + Jina secrets server-side (see lib/ai-config.ts +
 * ../backend). Anything inlined here is extractable from the shipped bundle,
 * so the backend URL is the only thing that ships.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

// The phone JSContext has NO `process` global. Every `process.env.X` the client
// source reads MUST be replaced by `define` at build time, or the bare reference
// throws "process is not defined" on load and the host fails to spawn the app.
//
// So we (1) EXPLICITLY define each public var the client reads, with a `?? ""`
// fallback so it resolves even when the var is absent from the build env, and
// (2) keep a generic pass for any other MENTRA_PUBLIC_* vars that are present.
const PUBLIC_VARS = [
  "MENTRA_PUBLIC_MENTRA_AI_BACKEND_URL",
  "MENTRA_PUBLIC_GOOGLE_MAPS_API_KEY",
  "MENTRA_PUBLIC_GOOGLE_WEATHER_API_KEY",
] as const

const define: Record<string, string> = {}
for (const k of PUBLIC_VARS) {
  define[`process.env.${k}`] = JSON.stringify(process.env[k] ?? "")
}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
  }
}

// JSC + Zipline/QuickJS evaluate the background bundle as a classic script.
// ESM `export` is a syntax error there, so we emit an IIFE.
// `@mentra/miniapp/background` MUST be bundled in (not external) — the
// JSContext has no module resolver.
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
  plugins: [tailwind],
  minify: true,
  define,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}
