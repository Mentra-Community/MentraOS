// Single source of truth for build numbers across iOS and Android.
//
// Every build number belongs to the release family of the checkout (see
// notes/superpowers/specs/2026-09-14-family-build-numbers.md):
//
//   MAJOR × 100,000,000 + MINOR × 1,000,000 + PATCH × 10,000 + sequence
//
// Release builds are pinned by CI (MENTRAOS_PINNED_BUILD_NUMBER) to the sequence
// the coordinated pipeline allocated. Every other build, local or pull-request
// CI, takes a sequence above every release of the family, derived from the HEAD
// commit's committer time, so the app and the ASG client built from the same
// commit share a number and a dev build always installs over a release of the
// family. Same number for iOS CFBundleVersion and Android versionCode.
//
// Pinning: release scripts set MENTRAOS_PINNED_BUILD_NUMBER before invoking
// `bun expo prebuild`, so the value baked into the native projects matches
// what the script logs in its summary.
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {nonReleaseBuildNumber} from "../../.github/scripts/release-family.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function headCommitterTime(root = repositoryRoot) {
  const output = execFileSync("git", ["log", "-1", "--format=%ct"], {cwd: root, encoding: "utf8"}).trim()
  const seconds = Number(output)
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error(`Unexpected git committer time ${JSON.stringify(output)}`)
  return seconds
}

export function familyBaseVersion(root = repositoryRoot) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
}

export function getBuildNumber() {
  const pinned = process.env.MENTRAOS_PINNED_BUILD_NUMBER
  if (pinned) {
    const n = parseInt(pinned, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return nonReleaseBuildNumber(familyBaseVersion(), headCommitterTime())
}
