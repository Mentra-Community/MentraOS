/**
 * Production build script.
 *
 * Substitutes `process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY` into the bundle
 * at build time so the WebView (which has no `process`) can read it. The
 * key is read from the shell env (Bun auto-loads .env in the cwd).
 *
 * Tailwind v4 is registered programmatically via `bun-plugin-tailwind` —
 * `bun build` ignores bunfig.toml plugins, so production builds need the
 * explicit registration (dev server picks up bunfig.toml on its own).
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const apiKey = process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY ?? ""
if (!apiKey) {
  console.warn("WARN: EXPO_PUBLIC_GOOGLE_NAV_API_KEY is not set — maps will fail to load.")
}
const placesKey = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ?? ""
if (!placesKey) {
  console.warn("WARN: EXPO_PUBLIC_GOOGLE_PLACES_API_KEY is not set — search will fail.")
}

const tailwind = (await import("bun-plugin-tailwind")).default

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: distDir,
  target: "browser",
  minify: true,
  plugins: [tailwind],
  define: {
    "process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY": JSON.stringify(apiKey),
    "process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY": JSON.stringify(placesKey),
  },
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Built ${result.outputs.length} file(s) into ${distDir}/`)
