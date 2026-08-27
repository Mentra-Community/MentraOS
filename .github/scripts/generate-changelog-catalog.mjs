#!/usr/bin/env node
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const VERSION_FILE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.md$/

function compareVersions(left, right) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function readChangelogCatalog(rootDir) {
  const directory = path.join(rootDir, "changelogs")
  const files = readdirSync(directory, {withFileTypes: true})
  const entries = []
  for (const file of files) {
    if (!file.isFile() || !VERSION_FILE_PATTERN.test(file.name)) {
      throw new Error(`changelogs/ may contain only X.Y.Z.md files; found ${file.name}`)
    }
    const version = file.name.slice(0, -3)
    const markdown = readFileSync(path.join(directory, file.name), "utf8").trim()
    if (!markdown) throw new Error(`${file.name} must not be empty`)
    entries.push({version, markdown})
  }
  if (entries.length === 0) throw new Error("changelogs/ must contain at least one X.Y.Z.md file")
  return entries.sort((left, right) => compareVersions(right.version, left.version))
}

function kotlinString(value) {
  return JSON.stringify(value).replaceAll("$", "\\$")
}

export function renderChangelogCatalog(entries) {
  const typescript = [
    "/** Generated from /changelogs. Do not edit directly. */",
    "export const GENERATED_RELEASE_CHANGELOGS = Object.freeze(",
    `${JSON.stringify(entries, null, 2)} as const,`,
    ")",
    "",
  ].join("\n")
  const kotlin = [
    "package com.mentra.bluetoothsdk",
    "",
    "/** Generated from /changelogs. Do not edit directly. */",
    "internal val GENERATED_RELEASE_CHANGELOGS: List<ReleaseChangelog> =",
    "    listOf(",
    ...entries.map(
      ({version, markdown}) =>
        `        ReleaseChangelog(version = ${kotlinString(version)}, markdown = ${kotlinString(markdown)}),`,
    ),
    "    )",
    "",
  ].join("\n")
  const swift = [
    "import Foundation",
    "",
    "/// Generated from /changelogs. Do not edit directly.",
    "let generatedReleaseChangelogs: [ReleaseChangelog] = [",
    ...entries.map(
      ({version, markdown}) =>
        `    ReleaseChangelog(version: ${JSON.stringify(version)}, markdown: ${JSON.stringify(markdown)}),`,
    ),
    "]",
    "",
  ].join("\n")
  return {typescript, kotlin, swift}
}

export function catalogOutputs(rootDir) {
  return {
    typescript: path.join(rootDir, "mobile/modules/bluetooth-sdk/src/generated/changelogCatalog.ts"),
    kotlin: path.join(
      rootDir,
      "mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/GeneratedChangelogCatalog.kt",
    ),
    swift: path.join(rootDir, "mobile/modules/bluetooth-sdk/ios/Source/GeneratedChangelogCatalog.swift"),
  }
}

export function generateChangelogCatalog(rootDir, {check = false} = {}) {
  const rendered = renderChangelogCatalog(readChangelogCatalog(rootDir))
  for (const [language, output] of Object.entries(catalogOutputs(rootDir))) {
    if (check) {
      if (!existsSync(output) || readFileSync(output, "utf8") !== rendered[language]) {
        throw new Error(
          `${path.relative(rootDir, output)} is stale; run node .github/scripts/generate-changelog-catalog.mjs`,
        )
      }
      continue
    }
    mkdirSync(path.dirname(output), {recursive: true})
    writeFileSync(output, rendered[language])
  }
}

function main() {
  const rootDir = path.resolve(process.cwd())
  generateChangelogCatalog(rootDir, {check: process.argv.includes("--check")})
  console.log(`${process.argv.includes("--check") ? "Verified" : "Generated"} release changelog catalog`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
