#!/usr/bin/env bun
import {execFileSync} from "node:child_process"
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {generateChangelogCatalog} from "../.github/scripts/generate-changelog-catalog.mjs"
import {loadReleaseFamily} from "../.github/scripts/release-family.mjs"

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
const LOCKFILES = ["bun.lock", "mobile/bun.lock", "cloud-v2/bun.lock", "sdk/bun.lock"]
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function fail(message) {
  throw new Error(`Could not prepare the next release family: ${message}`)
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"))
}

function versionTuple(version) {
  if (!STABLE_VERSION.test(version || "")) fail(`${JSON.stringify(version)} is not a plain X.Y.Z version`)
  return version.split(".").map(Number)
}

function compareVersions(left, right) {
  const leftParts = versionTuple(left)
  const rightParts = versionTuple(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function trackedPackageManifests() {
  return execFileSync("git", ["ls-files", "*package.json"], {cwd: rootDir, encoding: "utf8"})
    .trim()
    .split("\n")
    .filter(Boolean)
}

function nextRange(range, currentVersion, nextVersion) {
  for (const prefix of ["", "^", "~"]) {
    if (range === `${prefix}${currentVersion}`) return `${prefix}${nextVersion}`
  }
  return range
}

function replaceJsonStringProperties(input, replacements, relativePath) {
  let output = input
  for (const {property, currentValue, nextValue, expectedCount} of replacements.values()) {
    const propertyPattern = JSON.stringify(property).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const valuePattern = JSON.stringify(currentValue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`(${propertyPattern}\\s*:\\s*)${valuePattern}`, "g")
    let actualCount = 0
    output = output.replace(pattern, (_match, prefix) => {
      actualCount += 1
      return `${prefix}${JSON.stringify(nextValue)}`
    })
    if (actualCount !== expectedCount) {
      fail(
        `${relativePath} contains ${actualCount} ${property}=${JSON.stringify(currentValue)} properties, expected ${expectedCount}`,
      )
    }
  }
  return output
}

function findObjectEnd(input, openingBrace, relativePath) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = openingBrace; index < input.length; index += 1) {
    const character = input[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) return index + 1
  }
  fail(`${relativePath} contains an unterminated object`)
}

function replaceJsonStringProperty(input, property, nextValue, expectedCount, relativePath) {
  const propertyPattern = JSON.stringify(property).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(${propertyPattern}\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")`, "g")
  let actualCount = 0
  const output = input.replace(pattern, (_match, prefix) => {
    actualCount += 1
    return `${prefix}${JSON.stringify(nextValue)}`
  })
  if (actualCount !== expectedCount) {
    fail(`${relativePath} contains ${actualCount} ${property} properties, expected ${expectedCount}`)
  }
  return output
}

function syncLockfileWorkspaceMetadata(family) {
  if (!globalThis.Bun?.JSONC) fail("this command must run with Bun so text lockfiles can be validated")
  const familyNames = new Set(family.members.map((member) => member.name))

  for (const relativePath of LOCKFILES) {
    const lockPath = path.join(rootDir, relativePath)
    const lockDirectory = path.dirname(lockPath)
    let input = readFileSync(lockPath, "utf8")
    const lock = Bun.JSONC.parse(input)
    const packagesStart = input.indexOf('\n  "packages":')
    if (packagesStart < 0) fail(`${relativePath} does not contain a packages section`)

    const edits = []
    for (const [workspacePath, workspace] of Object.entries(lock.workspaces || {})) {
      const manifestPath = path.resolve(lockDirectory, workspacePath, "package.json")
      if (!existsSync(manifestPath)) fail(`${relativePath} workspace ${workspacePath} has no package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      const key = `${JSON.stringify(workspacePath)}: {`
      const keyStart = input.lastIndexOf(key, packagesStart)
      if (keyStart < 0) fail(`${relativePath} does not contain workspace ${workspacePath}`)
      const openingBrace = input.indexOf("{", keyStart + key.length - 1)
      const end = findObjectEnd(input, openingBrace, relativePath)
      let block = input.slice(openingBrace, end)

      if (familyNames.has(manifest.name) && workspace.version !== undefined) {
        block = replaceJsonStringProperty(block, "version", manifest.version, 1, `${relativePath}:${workspacePath}`)
      }

      const familyRanges = new Map()
      for (const section of DEPENDENCY_SECTIONS) {
        for (const [name, range] of Object.entries(manifest[section] || {})) {
          if (!familyNames.has(name)) continue
          const ranges = familyRanges.get(name) || []
          ranges.push(range)
          familyRanges.set(name, ranges)
        }
      }
      for (const [name, ranges] of familyRanges) {
        if (new Set(ranges).size !== 1) {
          fail(`${path.relative(rootDir, manifestPath)} uses multiple ranges for ${name}`)
        }
        block = replaceJsonStringProperty(block, name, ranges[0], ranges.length, `${relativePath}:${workspacePath}`)
      }
      edits.push({start: openingBrace, end, block})
    }

    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      input = `${input.slice(0, edit.start)}${edit.block}${input.slice(edit.end)}`
    }
    Bun.JSONC.parse(input)
    writeFileSync(lockPath, input)
  }
}

function updateManifests({currentVersion, nextVersion, family}) {
  const familyManifests = new Set([family.versionSource, ...family.members.map((member) => member.manifest)])
  const familyNames = new Set(family.members.map((member) => member.name))

  const changedManifests = []
  for (const relativePath of trackedPackageManifests()) {
    const input = readFileSync(path.join(rootDir, relativePath), "utf8")
    const manifest = JSON.parse(input)
    const replacements = new Map()
    let changed = false

    const addReplacement = (property, currentValue, nextValue) => {
      const key = JSON.stringify([property, currentValue, nextValue])
      const existing = replacements.get(key)
      replacements.set(key, {
        property,
        currentValue,
        nextValue,
        expectedCount: (existing?.expectedCount || 0) + 1,
      })
    }

    if (familyManifests.has(relativePath)) {
      if (manifest.version !== currentVersion) {
        fail(`${relativePath} has version ${JSON.stringify(manifest.version)}, expected ${currentVersion}`)
      }
      addReplacement("version", currentVersion, nextVersion)
      manifest.version = nextVersion
      changed = true
    }

    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, range] of Object.entries(manifest[section] || {})) {
        if (!familyNames.has(name) || typeof range !== "string") continue
        const updated = nextRange(range, currentVersion, nextVersion)
        if (updated !== range) {
          addReplacement(name, range, updated)
          manifest[section][name] = updated
          changed = true
        }
      }
    }

    if (changed) {
      const output = replaceJsonStringProperties(input, replacements, relativePath)
      if (JSON.stringify(JSON.parse(output)) !== JSON.stringify(manifest)) {
        fail(`${relativePath} property edits did not produce the expected manifest`)
      }
      writeFileSync(path.join(rootDir, relativePath), output)
      changedManifests.push(relativePath)
    }
  }
  return changedManifests
}

function createChangelog(nextVersion) {
  const relativePath = `changelogs/${nextVersion}.md`
  const output = path.join(rootDir, relativePath)
  if (existsSync(output)) return
  writeFileSync(
    output,
    "This release is under active development. User-facing changes will be documented as they land.\n",
  )
}

function updateStableDocs(currentVersion, nextVersion) {
  const relativePath = "mintlify-docs/docs.json"
  const input = readFileSync(path.join(rootDir, relativePath), "utf8")
  const docs = JSON.parse(input)
  if (docs.variables?.["release-version"] !== currentVersion) {
    fail(`${relativePath} release-version does not match ${currentVersion}`)
  }
  const currentUrl = `https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v${currentVersion}`
  if (docs.variables?.["release-artifacts-url"] !== currentUrl) {
    fail(`${relativePath} release-artifacts-url does not match ${currentUrl}`)
  }
  let output = replaceJsonStringProperty(input, "release-version", nextVersion, 1, relativePath)
  output = replaceJsonStringProperty(
    output,
    "release-artifacts-url",
    `https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v${nextVersion}`,
    1,
    relativePath,
  )
  writeFileSync(path.join(rootDir, relativePath), output)
}

function updateLicenseInventory(currentVersion, nextVersion, family) {
  const relativePath = "mintlify-docs/third-party-licenses.json"
  const input = readFileSync(path.join(rootDir, relativePath), "utf8")
  const inventory = JSON.parse(input)
  const familyNames = new Set(family.members.map((member) => member.name))
  let output = input

  for (const entry of inventory.packages.filter(({name}) => familyNames.has(name))) {
    const resumesLowerInventoryEntry = currentVersion === nextVersion && compareVersions(entry.version, nextVersion) < 0
    if (entry.version !== currentVersion && !resumesLowerInventoryEntry) {
      fail(`${relativePath} lists ${entry.name} at ${entry.version}, expected ${currentVersion}`)
    }
    const namePattern = JSON.stringify(entry.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const versionPattern = JSON.stringify(entry.version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`("name"\\s*:\\s*${namePattern}\\s*,\\s*"version"\\s*:\\s*)${versionPattern}`)
    if (!pattern.test(output)) fail(`${relativePath} does not contain the expected ${entry.name} entry`)
    output = output.replace(pattern, `$1${JSON.stringify(nextVersion)}`)
  }

  JSON.parse(output)
  writeFileSync(path.join(rootDir, relativePath), output)
}

function installWorkspaces(arguments_) {
  for (const relativeDirectory of [".", "mobile", "cloud-v2", "sdk"]) {
    execFileSync("bun", ["install", ...arguments_, "--ignore-scripts"], {
      cwd: path.join(rootDir, relativeDirectory),
      env: {...process.env, HUSKY: "0"},
      stdio: "inherit",
    })
  }
}

function main() {
  const [nextVersion, ...extra] = process.argv.slice(2)
  if (!nextVersion || extra.length > 0) {
    fail("usage: bun run release:prepare-next-family -- X.Y.Z")
  }
  versionTuple(nextVersion)

  const family = readJson(".github/release-family.json")
  const versionSource = readJson(family.versionSource)
  const currentVersion = versionSource.version
  versionTuple(currentVersion)
  if (compareVersions(nextVersion, currentVersion) < 0) {
    fail(`${nextVersion} must not be lower than the current family base ${currentVersion}`)
  }

  updateManifests({currentVersion, nextVersion, family})
  createChangelog(nextVersion)
  updateStableDocs(currentVersion, nextVersion)
  updateLicenseInventory(currentVersion, nextVersion, family)
  generateChangelogCatalog(rootDir)
  loadReleaseFamily({rootDir, requireVersionMirrors: true})
  installWorkspaces([])
  syncLockfileWorkspaceMetadata(family)
  installWorkspaces(["--frozen-lockfile"])

  console.log(
    currentVersion === nextVersion
      ? `Resumed release family preparation for ${nextVersion}`
      : `Prepared release family ${nextVersion} from ${currentVersion}`,
  )
}

main()
