import {copyFile, mkdir, rm} from "fs/promises"

// Resolves @mentra/miniapp from the repository's workspace install; run `bun install` at the root first.
const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})
await mkdir(`${distDir}/ui`, {recursive: true})

const background = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
})

if (!background.success) {
  console.error("Background build failed:")
  for (const log of background.logs) console.error(log)
  process.exit(1)
}

await copyFile("./src/ui/index.html", `${distDir}/ui/index.html`)
await copyFile("./miniapp.json", `${distDir}/miniapp.json`)
await copyFile("./icon.png", `${distDir}/icon.png`)

console.log("built stream-preview-probe -> dist/")
