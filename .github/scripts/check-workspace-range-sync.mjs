#!/usr/bin/env node
// Guard: every internal @mentra/* semver range must be satisfied by the LOCAL
// workspace package's version.
//
// Why this matters: bun links a workspace package for a bare semver range only
// while the local version satisfies it. Before our packages existed on npm, a
// drifted range failed loudly (404). Once they ARE on npm, the same drift makes
// bun silently install the registry tarball instead of linking the workspace —
// local edits stop taking effect with no error. Prerelease semver makes drift
// easy: 0.1.1-dev.0 does NOT satisfy ^0.1.0-dev.0 (prerelease ranges match only
// their exact patch tuple), so ANY prerelease bump must update dependent ranges
// in the same commit. This check fails CI when that lockstep is missed.
//
// `workspace:*` and `file:` ranges are exempt (they force local linking and
// never reach the registry), as is "*".
import {readFileSync, existsSync, readdirSync} from "node:fs"
import {execFileSync} from "node:child_process"
import path from "node:path"
import {createRequire} from "node:module"

// Use the real semver implementation (bun applies standard semver rules —
// verified empirically); hand-rolling prerelease matching is how bugs happen.
const require = createRequire(import.meta.url)
let semver
for (const base of ["mobile", "sdk", "."]) {
  try {
    semver = require(path.resolve(base, "node_modules/semver"))
    break
  } catch {}
}
if (!semver) {
  console.error("::error::semver not found in any workspace node_modules — run bun install first")
  process.exit(2)
}

// Discover workspace package manifests. Keep the roots explicit — these are
// the three bun workspaces that hold @mentra packages.
const manifests = new Set(["mobile/package.json"])
for (const parent of ["mobile/modules", "cloud-v2/packages", "sdk"]) {
  for (const entry of readdirSync(parent, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue
    const m = path.join(parent, entry.name, "package.json")
    if (existsSync(m)) manifests.add(m)
  }
}

const localVersions = new Map()
const parsed = []
for (const m of manifests) {
  try {
    const d = JSON.parse(readFileSync(m, "utf8"))
    parsed.push([m, d])
    if (d.name?.startsWith("@mentra/") && d.version) localVersions.set(d.name, d.version)
  } catch {}
}

let failures = 0
for (const [file, d] of parsed) {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(d[section] || {})) {
      if (!dep.startsWith("@mentra/")) continue
      if (range === "*" || String(range).startsWith("workspace:")) continue
      // file: deps are workspace-local by definition (the release pipeline
      // rewrites them to real versions at publish time).
      if (String(range).startsWith("file:")) continue
      const local = localVersions.get(dep)
      if (!local) continue // not a workspace package (e.g. @mentra/types from the registry)
      if (!semver.satisfies(local, range)) {
        console.error(
          `::error file=${file}::${d.name || file} ${section} wants ${dep}@${range}, but the workspace has ` +
            `${dep}@${local} — bun would install from the REGISTRY instead of linking local source. ` +
            `Bump the range and the version together (prerelease ranges only match their exact patch tuple).`,
        )
        failures++
      }
    }
  }
}

if (failures) {
  console.error(`${failures} internal range(s) out of lockstep with workspace versions`)
  process.exit(1)
}
console.log(`workspace range sync OK (${localVersions.size} @mentra workspace packages checked)`)
