import {rm} from "fs/promises"
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

const distDir = "./dist"
await rm(distDir, {recursive: true, force: true})

const define: Record<string, string> = {
  "process.env.MENTRA_PUBLIC_CORE_URL": JSON.stringify(
    process.env.MENTRA_PUBLIC_CORE_URL ?? "https://core.mentraglass.com",
  ),
}

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: true,
  define,
})
if (!backgroundResult.success) {
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [reactSingletonPlugin(import.meta.url)],
  minify: true,
})
if (!uiResult.success) {
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}
