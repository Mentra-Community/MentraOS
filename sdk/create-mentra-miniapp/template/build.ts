/**
 * Production build script.
 *
 * `bun build` from the CLI doesn't apply plugins from bunfig.toml — that
 * support only kicks in for Bun.serve (the dev server). For builds we
 * register plugins programmatically here.
 *
 * Add bundler plugins (Tailwind, Vue, etc.) by pushing them into the
 * `plugins` array below. For example, with Tailwind v4:
 *
 *     const tailwind = (await import("bun-plugin-tailwind")).default
 *     plugins: [tailwind],
 *
 * Output goes to ./dist with the shape `mentra-miniapp release` expects.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

// Wipe dist/ so old chunks don't accumulate across builds.
await rm(distDir, {recursive: true, force: true})

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: distDir,
  target: "browser",
  plugins: [],
  minify: true,
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Built ${result.outputs.length} file(s) into ${distDir}/`)
