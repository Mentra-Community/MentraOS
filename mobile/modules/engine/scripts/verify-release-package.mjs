#!/usr/bin/env node
import {existsSync, readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {validateReleaseMetadata} from "./write-release-metadata.mjs"

const METADATA_FILES = ["src/generated/releaseMetadata.ts", "build/generated/releaseMetadata.js"]

export function verifyReleasePackage({packageRoot, expected}) {
  const metadata = validateReleaseMetadata(expected)
  const packageManifestPath = path.join(packageRoot, "package.json")
  if (!existsSync(packageManifestPath)) throw new Error(`Missing package manifest: ${packageManifestPath}`)
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"))
  if (packageManifest.name !== "@mentra/engine") {
    throw new Error(`Expected @mentra/engine package, found ${JSON.stringify(packageManifest.name)}`)
  }
  if (packageManifest.version !== metadata.releaseIdentity) {
    throw new Error(`Engine version ${packageManifest.version} does not match ${metadata.releaseIdentity}`)
  }

  for (const relativePath of METADATA_FILES) {
    const file = path.join(packageRoot, relativePath)
    if (!existsSync(file)) throw new Error(`Packed Engine is missing ${relativePath}`)
    const contents = readFileSync(file, "utf8")
    if (contents.includes("process.env") || contents.includes("__MENTRA_")) {
      throw new Error(`${relativePath} contains runtime environment lookup or an unresolved placeholder`)
    }
    for (const [field, value] of Object.entries(metadata)) {
      if (field === "schemaVersion") continue
      if (!contents.includes(JSON.stringify(value))) {
        throw new Error(`${relativePath} does not contain expected ${field}`)
      }
    }
  }

  return metadata
}

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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const packageRoot = path.resolve(process.cwd(), args["package-root"] || "package")
  verifyReleasePackage({
    packageRoot,
    expected: {
      familyBaseVersion: args["family-base-version"],
      releaseIdentity: args["release-identity"],
      releaseSetId: args["release-set-id"],
      sourceCommit: args["source-commit"],
      otaManifestUrl: args["ota-manifest-url"],
      otaManifestSha256: args["ota-manifest-sha256"],
    },
  })
  console.log(`Verified packed Engine release metadata in ${packageRoot}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
