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
//   - beta/latest publishes land in npm's staging queue (see the workflow):
//     a maintainer approves each version before it goes live, so merging to
//     main IS the go signal and the approval is the only remaining gate.
import {readFileSync, appendFileSync} from "node:fs"
import {channelFor, deriveVersion, publishedVersions, CHANNEL_MANIFESTS} from "./npm-channel.mjs"

const packageName = "@mentra/engine"
const packagePath = CHANNEL_MANIFESTS[packageName]

const outputPath = process.env.GITHUB_OUTPUT
const eventName = process.env.GITHUB_EVENT_NAME || ""
const branch = process.env.GITHUB_REF_NAME || ""
const forceRelease = process.env.FORCE_RELEASE === "true"
const dryRun = process.env.DRY_RUN === "true"

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

// Installability gate: every internal peer/dep the stamp will pin must be
// LIVE on this channel before the engine ships — the engine and miniapp
// pipelines run independently, so an engine-only push (or an engine job
// outrunning the peer matrix) must not publish/stage an engine whose peer
// ranges resolve to 404s. Note "live" means approved: staged-but-unapproved
// versions are not in the registry, so on beta/latest the engine waits for
// the peers' approvals (approve bottom-up, then re-run this workflow).
const missingPeers = []
for (const field of ["dependencies", "peerDependencies"]) {
  for (const dep of Object.keys(currentPackage[field] || {})) {
    if (!(dep in CHANNEL_MANIFESTS) || dep === packageName) continue
    if (currentPackage.peerDependenciesMeta?.[dep]?.optional) continue
    const depBase = JSON.parse(readFileSync(CHANNEL_MANIFESTS[dep], "utf8")).version
    const depDerived = deriveVersion(depBase, branch)
    if (!publishedVersions(dep)?.includes(depDerived)) missingPeers.push(`${dep}@${depDerived}`)
  }
}

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
} else if (missingPeers.length > 0 && !dryRun) {
  reason = `waits for ${missingPeers.join(", ")} to be live on this channel`
  console.log(`::notice::${packageName}@${derived} skipped: ${reason}. Publish/approve the peers, then re-run this workflow.`)
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
