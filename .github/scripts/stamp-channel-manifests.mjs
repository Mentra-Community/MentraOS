#!/usr/bin/env node
// Stamps every independent developer-tool manifest in the CI checkout with its DERIVED
// version for the current branch, and rewrites internal ranges to match — the
// publish-time half of the channel-promotion scheme (see npm-channel.mjs).
//
// Two rewrites per manifest:
//   - version: base X.Y.Z-dev.N -> the channel's derived version
//   - dependencies/peerDependencies/optionalDependencies ranges pointing at
//     OTHER channel-released packages -> ^<that package's derived version>
//     (devDependencies are not shipped; `workspace:*`, `file:` and `*` ranges
//     are left for the existing rewrite-file-deps.mjs / npm semantics)
//
// Stamping the WHOLE tool set at once (not just the package being packed) keeps
// every later reader consistent: rewrite-file-deps.mjs pins `file:` deps from
// the referenced manifest's (now derived) version, and
// stamp-template-versions.mjs reads the (now derived) miniapp/miniapp-cli
// versions for the scaffolder template.
//
// Mutates the checkout that gets packed/published — NEVER committed. Run it
// AFTER `bun install` (a frozen install would reject the changed version
// fields) and before pack/publish.
//
// Usage: node stamp-channel-manifests.mjs   (branch from GITHUB_REF_NAME)
import {readFileSync, writeFileSync} from "node:fs"
import {CHANNEL_MANIFESTS, deriveVersion, deriveRange} from "./npm-channel.mjs"

const branch = process.env.GITHUB_REF_NAME || ""
const RANGE_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"]

const baseVersions = {}
const manifests = {}
for (const [name, path] of Object.entries(CHANNEL_MANIFESTS)) {
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  if (manifest.name !== name) {
    throw new Error(`${path}: expected package ${name}, found ${manifest.name}`)
  }
  manifests[name] = {path, manifest}
  baseVersions[name] = manifest.version
}

for (const [name, {path, manifest}] of Object.entries(manifests)) {
  const derived = deriveVersion(baseVersions[name], branch)
  const lines = []
  if (manifest.version !== derived) {
    lines.push(`  version ${manifest.version} -> ${derived}`)
    manifest.version = derived
  }
  for (const field of RANGE_FIELDS) {
    const deps = manifest[field]
    if (!deps) continue
    for (const dep of Object.keys(deps)) {
      if (!(dep in CHANNEL_MANIFESTS)) continue
      const range = deps[dep]
      if (range === "*" || range.startsWith("workspace:") || range.startsWith("file:")) continue
      const derivedRange = deriveRange(baseVersions[dep], branch)
      if (range === derivedRange) continue
      lines.push(`  ${field}.${dep} ${range} -> ${derivedRange}`)
      deps[dep] = derivedRange
    }
  }
  if (lines.length) {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n")
    console.log(`${name} (${path}):\n${lines.join("\n")}`)
  } else {
    console.log(`${name}: already at channel state for "${branch}"`)
  }
}
