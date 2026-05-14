/**
 * Production build script — two-output bundle.
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — the JSContext entry (no DOM, externalises
 *                                @mentra/miniapp/background because the
 *                                host's polyfill bundle provides the
 *                                runtime shape).
 *   dist/ui/index.html + ...  — the WebView entry (full DOM, Tailwind v4
 *                                compiled via bun-plugin-tailwind).
 *
 * Env vars whose name starts with `MENTRA_PUBLIC_` are inlined into both
 * bundles via `define`. Anything inlined into the UI bundle is visible
 * in WebView network requests + source maps; secrets MUST live behind
 * the developer's own backend, not in MENTRA_PUBLIC_*.
 */

import {rm} from "fs/promises"

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
  target: "bun",
  format: "esm",
  // Host polyfill bundle provides @mentra/miniapp/background's runtime
  // shape (the typed wrappers around __dispatch). Don't bundle it.
  external: ["@mentra/miniapp/background"],
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

console.log(
  `Built background (${backgroundResult.outputs.length}) + UI (${uiResult.outputs.length}) files into ${distDir}/`,
)
