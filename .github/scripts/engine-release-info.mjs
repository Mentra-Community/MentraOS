#!/usr/bin/env node
// Release decision for @mentra/engine under the channel-promotion scheme
// (npm-channel.mjs): git holds a prerelease base version (only edited on dev),
// and the branch decides what publishes — dev -> X.Y.Z-dev.N (dev tag),
// staging -> X.Y.Z-beta.N (beta tag), main -> X.Y.Z (latest tag). Merging IS
// promoting; no version edits ride the branches.
//
// The engine publishes when its DERIVED version for this branch is absent from
// npm (registry-state detection — promotion merges don't change the version
// field, so git-diff detection cannot see them). Fail-closed rules, same as
// the miniapp pipeline:
//   - E404 is the only "absent" signal (enforced in npm-channel.mjs); any
//     other npm error fails the run.
//   - The first-ever publish never fires off a push: the workflow's bootstrap
//     gate requires a supervised workflow_dispatch with force_release=true.
//   - The main channel (latest = npm's default install) is additionally held
//     behind the NPM_MAIN_CHANNEL repository variable until the team opens it.
import {readFileSync, appendFileSync} from "node:fs"
import {channelFor, deriveVersion, publishedVersions, CHANNEL_MANIFESTS} from "./npm-channel.mjs"

const packageName = "@mentra/engine"
const packagePath = CHANNEL_MANIFESTS[packageName]

const outputPath = process.env.GITHUB_OUTPUT
const eventName = process.env.GITHUB_EVENT_NAME || ""
const branch = process.env.GITHUB_REF_NAME || ""
const forceRelease = process.env.FORCE_RELEASE === "true"
const dryRun = process.env.DRY_RUN === "true"
const mainChannelEnabled = process.env.MAIN_CHANNEL_ENABLED === "true"

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`)
    return
  }
  appendFileSync(outputPath, `${name}=${value}\n`)
}

const currentPackage = JSON.parse(readFileSync(packagePath, "utf8"))
if (currentPackage.name !== packageName) {
  throw new Error(`${packagePath}: expected ${packageName}, found ${currentPackage.name}`)
}

const {tag} = channelFor(branch) // throws on non-channel branches
const derived = deriveVersion(currentPackage.version, branch) // validates the base is a prerelease

const published = publishedVersions(packageName)
const packageExists = published !== null
const versionExists = packageExists && published.includes(derived)

let runRelease = false
let reason
if (versionExists) {
  reason = "already on npm"
  if (branch === "main") {
    console.log(
      `::notice::${packageName}@${derived} is already on npm — to cut a new public release, ` +
        `bump the base version on dev and merge it up.`,
    )
  }
} else if (branch === "main" && !mainChannelEnabled && !forceRelease) {
  reason = "main channel disabled — set repo variable NPM_MAIN_CHANNEL=true"
  console.log(`::notice::${packageName}@${derived} would ship to "latest" but the main channel is disabled. ${reason}.`)
} else {
  // The absent-from-npm bootstrap case still reaches the npm job: its
  // bootstrap gate skips with a notice unless this is a force_release
  // dispatch (and the job also handles dry-run packs).
  runRelease = true
  reason = forceRelease ? "force_release" : "derived version absent from npm"
}
if (!runRelease && eventName === "workflow_dispatch" && dryRun) {
  runRelease = true // dry-run dispatches always get a build+pack preview
  reason = `dry run (${reason})`
}

setOutput("package_name", packageName)
setOutput("version", derived)
setOutput("dist_tag", tag)
setOutput("dry_run", String(dryRun))
setOutput("run_release", String(runRelease))
setOutput("force_release", String(forceRelease))

console.log(`Mentra Engine package: ${packageName}`)
console.log(`Base version: ${currentPackage.version}`)
console.log(`Derived version for ${branch}: ${derived} (dist-tag ${tag})`)
console.log(`On npm already: ${versionExists} (package exists: ${packageExists})`)
console.log(`Run release job: ${runRelease} (${reason})`)
console.log(`Force release: ${forceRelease}. Dry run: ${dryRun}.`)
