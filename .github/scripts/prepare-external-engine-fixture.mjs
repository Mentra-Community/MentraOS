#!/usr/bin/env node
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function prepareExternalEngineFixture({sourceDir, outputDir, releaseIdentity}) {
  if (!/^\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?$/.test(releaseIdentity)) {
    throw new Error(`Invalid coordinated release identity ${JSON.stringify(releaseIdentity)}`)
  }

  rmSync(outputDir, {recursive: true, force: true})
  mkdirSync(path.dirname(outputDir), {recursive: true})
  cpSync(sourceDir, outputDir, {
    recursive: true,
    // Installs anywhere, and the host's own generated native projects and bundles. A local module's native
    // sources (modules/<name>/android, /ios) are its code and stay.
    filter: (entry) => {
      const relative = path.relative(sourceDir, entry)
      return !relative.split(path.sep).includes("node_modules") && !["android", "ios", "dist"].includes(relative)
    },
  })

  const packageFile = path.join(outputDir, "package.json")
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8"))
  // The host's own local modules (file:) stay; the published Engine brings the rest.
  for (const [name, spec] of Object.entries(packageJson.dependencies ?? {})) {
    if (name.startsWith("@mentra/") && !spec.startsWith("file:")) delete packageJson.dependencies[name]
  }
  packageJson.dependencies["@mentra/engine"] = releaseIdentity
  if (packageJson.expo) delete packageJson.expo.autolinking
  writeJson(packageFile, packageJson)

  const tsconfigFile = path.join(outputDir, "tsconfig.json")
  const tsconfig = JSON.parse(readFileSync(tsconfigFile, "utf8"))
  delete tsconfig.compilerOptions?.paths
  writeJson(tsconfigFile, tsconfig)

  writeFileSync(
    path.join(outputDir, "metro.config.js"),
    'const {getDefaultConfig} = require("expo/metro-config")\n\nmodule.exports = getDefaultConfig(__dirname)\n',
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ["source", "output", "release-identity"]) {
    if (!args[required]) throw new Error(`Missing --${required}`)
  }
  prepareExternalEngineFixture({
    sourceDir: path.resolve(args.source),
    outputDir: path.resolve(args.output),
    releaseIdentity: args["release-identity"],
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
