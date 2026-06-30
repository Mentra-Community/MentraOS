import {copyFile, mkdir, readFile, rm, writeFile} from "fs/promises"

import miniappManifest from "./miniapp.json"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})
await mkdir(`${distDir}/ui`, {recursive: true})

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
})

if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const uiHtml = await readFile("./src/ui/index.html", "utf8")
await writeFile(`${distDir}/ui/index.html`, uiHtml.replaceAll("__KAWAII_VERSION__", miniappManifest.version))
await copyFile("./miniapp.json", `${distDir}/miniapp.json`)
await copyFile("./icon.png", `${distDir}/icon.png`)

console.log("built kawaii -> dist/background/index.js + dist/ui + dist/icon.png + dist/miniapp.json")
