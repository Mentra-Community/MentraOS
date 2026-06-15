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
 * bundles via `define`. For Mentra AI those carry the LLM / search keys
 * (Gemini, Jina) the background bundle calls directly. NOTE: anything
 * inlined is extractable from the shipped bundle — fine for local/dev use.
 * Before prod, route AI calls through a backend proxy (see lib/ai-config.ts)
 * instead of inlining real keys.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

// Inline MENTRA_PUBLIC_* env into both bundles. We map them to two namespaces
// so source can read either `process.env.MENTRA_PUBLIC_X` (canonical) or the
// shorter `process.env.X` the ported cloud code expects.
const define: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
    // Also expose without the MENTRA_PUBLIC_ prefix (e.g. GOOGLE_..._KEY)
    define[`process.env.${k.slice("MENTRA_PUBLIC_".length)}`] = JSON.stringify(v)
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
