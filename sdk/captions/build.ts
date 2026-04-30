/**
 * Production build script.
 *
 * Bun's CLI `bun build` doesn't apply plugins from bunfig.toml — that
 * support only kicks in for `Bun.serve` (the dev server). For builds we
 * have to register plugins programmatically so Tailwind v4's
 * `@import "tailwindcss"` gets compiled into real CSS.
 */

import {rm} from "fs/promises"

await rm("./dist", {recursive: true, force: true})

const tailwind = (await import("bun-plugin-tailwind")).default

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  target: "browser",
  plugins: [tailwind],
  minify: true,
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`Built ${result.outputs.length} files to ./dist`)
