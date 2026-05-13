/**
 * Production build script.
 *
 * Bun's CLI `bun build` doesn't apply plugins from bunfig.toml — that
 * support only kicks in for `Bun.serve` (the dev server). For builds we
 * have to register plugins programmatically. Right now we need
 * `bun-plugin-tailwind` so Tailwind v4's `@import "tailwindcss"` actually
 * gets compiled into real CSS instead of shipping the source directives
 * to the WebView.
 *
 * Output goes to ./dist with the same shape as `bun build ./index.html
 * --outdir=./dist --target=browser --format=iife` would produce.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

// Wipe dist/ so old chunks don't accumulate.
await rm(distDir, {recursive: true, force: true})

const tailwind = (await import("bun-plugin-tailwind")).default

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: distDir,
  target: "browser",
  plugins: [tailwind],
  minify: true,
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Built ${result.outputs.length} file(s) into ${distDir}/`)
