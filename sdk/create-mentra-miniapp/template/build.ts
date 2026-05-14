/**
 * Production build script — two-output bundle.
 *
 * Two-layer miniapps ship TWO bundles in one zip:
 *   - dist/background/index.js     — JSContext entry, no DOM
 *   - dist/ui/index.html + assets  — WebView entry, full DOM
 *
 * Bun.build() handles both. The background bundle uses target: "bun"
 * with `external: ["@mentra/miniapp/background"]` so the SDK isn't
 * re-bundled into every miniapp's background image. (The runtime
 * polyfill shipped inside the host binary owns the actual `__dispatch`
 * call; the SDK module is type-only on the wire.) The UI bundle uses
 * target: "browser" with no externals.
 *
 * Build-time env vars: any `MENTRA_PUBLIC_*` key in your shell or
 * miniapp-local `.env` gets inlined into both bundles via define.
 * Anything inlined into the UI bundle is visible in WebView network
 * requests and source maps — secrets MUST live behind your own backend
 * rather than in MENTRA_PUBLIC_*.
 *
 * Add bundler plugins (Tailwind, Vue, etc.) by pushing them into the
 * matching `plugins` array. For example, with Tailwind v4 (UI side only):
 *
 *     const tailwind = (await import("bun-plugin-tailwind")).default
 *     uiBuild.plugins.push(tailwind)
 *
 * Output goes to ./dist with the shape `mentra-miniapp release` expects.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

// Wipe dist/ so old chunks don't accumulate across builds.
await rm(distDir, {recursive: true, force: true})

// Pick up MENTRA_PUBLIC_* env vars from the shell / .env. Bun loads .env
// from cwd automatically; we just need to forward the keys to define.
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
  minify: false,
  // The host's polyfill bundle provides @mentra/miniapp/background's
  // runtime shape; bundle the import so the JSContext doesn't try to
  // re-execute the SDK at runtime. Treat the import as external — the
  // runtime resolves the symbols against globals injected by the polyfill.
  external: ["@mentra/miniapp/background"],
  define,
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
  plugins: [],
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
