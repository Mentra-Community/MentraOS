import {copyFile, rm} from "fs/promises"
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const define: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("MENTRA_PUBLIC_") && typeof value === "string") {
    define[`process.env.${key}`] = JSON.stringify(value)
  }
}

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
  plugins: [tailwind, reactSingletonPlugin(import.meta.url)],
  minify: true,
  define,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

await copyFile("./miniapp.json", `${distDir}/miniapp.json`)
await copyFile("./icon.png", `${distDir}/icon.png`)

console.log("built dev-hud -> dist/background/index.js + dist/ui + dist/icon.png + dist/miniapp.json")
