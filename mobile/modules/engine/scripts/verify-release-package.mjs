#!/usr/bin/env node
import {existsSync, readFileSync, statSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {validateReleaseMetadata} from "./write-release-metadata.mjs"

const METADATA_FILES = ["src/generated/releaseMetadata.ts", "build/generated/releaseMetadata.js"]
const EXACT_FAMILY_DEPENDENCIES = [
  "@mentra/bluetooth-sdk",
  "@mentra/cloud-client",
  "@mentra/cloud-protocol",
  "@mentra/crust",
  "@mentra/miniapp",
]
const PRIVATE_ENGINE_EXPORTS = ["./internal", "./devtools"]
const FORBIDDEN_PUBLIC_DECLARATION_IMPORTS = ["@mentra/bluetooth-sdk/internal", "@mentra/engine/internal"]
const PRIVATE_PACKED_FILES = ["src/internal.ts", "src/devtools.ts", "build/internal.d.ts", "build/devtools.d.ts"]

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function resolveDeclarationImport(packageRoot, fromFile, specifier) {
  const unresolved = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [unresolved, `${unresolved}.d.ts`, path.join(unresolved, "index.d.ts")]
  const resolved = candidates.find(isFile)
  if (!resolved) {
    throw new Error(`${path.relative(packageRoot, fromFile)} has unresolved declaration import ${specifier}`)
  }
  const relative = path.relative(packageRoot, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${path.relative(packageRoot, fromFile)} imports declaration outside the package: ${specifier}`)
  }
  return resolved
}

function verifyPublicDeclarations(packageRoot, packageManifest) {
  for (const exportName of PRIVATE_ENGINE_EXPORTS) {
    if (Object.prototype.hasOwnProperty.call(packageManifest.exports ?? {}, exportName)) {
      throw new Error(`Packed Engine must not publish ${exportName}`)
    }
  }
  for (const relativePath of PRIVATE_PACKED_FILES) {
    if (existsSync(path.join(packageRoot, relativePath))) {
      throw new Error(`Packed Engine contains private host surface ${relativePath}`)
    }
  }

  const entrypoints = Object.entries(packageManifest.exports ?? {})
    .map(([exportName, target]) => ({exportName, types: target && typeof target === "object" ? target.types : null}))
    .filter(({types}) => typeof types === "string")
  if (entrypoints.length === 0) throw new Error("Packed Engine has no public declaration entrypoints")

  const queue = entrypoints.map(({exportName, types}) => {
    const file = path.resolve(packageRoot, types)
    if (!isFile(file)) throw new Error(`Packed Engine export ${exportName} is missing declarations at ${types}`)
    return file
  })
  const visited = new Set()
  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    const relativePath = path.relative(packageRoot, file)
    const contents = readFileSync(file, "utf8")
    for (const specifier of FORBIDDEN_PUBLIC_DECLARATION_IMPORTS) {
      if (contents.includes(specifier)) {
        throw new Error(`${relativePath} leaks forbidden public declaration import ${specifier}`)
      }
    }

    const importPattern = /(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g
    for (const match of contents.matchAll(importPattern)) {
      queue.push(resolveDeclarationImport(packageRoot, file, match[2]))
    }
  }
}

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
  for (const dependency of EXACT_FAMILY_DEPENDENCIES) {
    if (packageManifest.dependencies?.[dependency] !== metadata.releaseIdentity) {
      throw new Error(`Engine dependency ${dependency} must be exactly ${metadata.releaseIdentity}`)
    }
    if (packageManifest.peerDependencies?.[dependency] !== undefined) {
      throw new Error(`Engine dependency ${dependency} must not be published as a peer`)
    }
  }
  verifyPublicDeclarations(packageRoot, packageManifest)

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
