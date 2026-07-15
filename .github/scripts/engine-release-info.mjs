#!/usr/bin/env node
import {execFileSync} from "node:child_process"
import {appendFileSync, readFileSync} from "node:fs"

const packagePath = "mobile/modules/engine/package.json"

const outputPath = process.env.GITHUB_OUTPUT
const eventName = process.env.GITHUB_EVENT_NAME || ""
const eventPath = process.env.GITHUB_EVENT_PATH
const forceRelease = process.env.FORCE_RELEASE === "true"
const dryRun = process.env.DRY_RUN === "true"

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function readJsonAt(ref, path) {
  try {
    return JSON.parse(git(["show", `${ref}:${path}`]))
  } catch {
    return null
  }
}

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`)
    return
  }
  appendFileSync(outputPath, `${name}=${value}\n`)
}

const currentPackage = JSON.parse(readFileSync(packagePath, "utf8"))
const currentVersion = currentPackage.version

if (!currentPackage.name) {
  throw new Error(`Missing name in ${packagePath}`)
}

if (!currentVersion) {
  throw new Error(`Missing version in ${packagePath}`)
}

let beforeSha = process.env.ENGINE_COMPARE_SHA || ""
if (!beforeSha && eventPath) {
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"))
    beforeSha = event.before || ""
  } catch {
    beforeSha = ""
  }
}

if (/^0+$/.test(beforeSha)) {
  beforeSha = ""
}

// The before-SHA may not exist in a shallow checkout (or at all, after a
// force-push to dev): fetch just that commit, and treat any failure as
// "previous state unknown".
if (beforeSha) {
  try {
    git(["fetch", "--depth=1", "origin", beforeSha])
  } catch {
    // readJsonAt below returns null for an unresolvable ref; fail closed there.
  }
}

const previousPackage = beforeSha ? readJsonAt(beforeSha, packagePath) : null
const previousVersion = previousPackage?.version || ""
// FAIL CLOSED (same gate as the bluetooth-sdk/miniapp siblings): a release only
// auto-fires when the previous state is KNOWN and the version actually moved.
// An unresolvable before-SHA, a git error, or the package being new all yield
// hasPreviousVersion=false — no auto-publish. The first-ever publish is a
// deliberate, supervised `workflow_dispatch` with force_release=true.
const hasPreviousVersion = Boolean(previousPackage?.version)
const versionChanged = hasPreviousVersion && previousVersion !== currentVersion
const runRelease = versionChanged || forceRelease || (eventName === "workflow_dispatch" && dryRun)

setOutput("package_name", currentPackage.name)
setOutput("version", currentVersion)
setOutput("dry_run", String(dryRun))
setOutput("run_release", String(runRelease))

console.log(`Mentra Engine package: ${currentPackage.name}`)
console.log(`Current version: ${currentVersion}`)
console.log(`Previous version: ${previousVersion || "(unknown — releases fail closed)"}`)
console.log(`Compare SHA: ${beforeSha || "(unavailable)"}`)
console.log(`Version changed: ${versionChanged}`)
console.log(`Force release: ${forceRelease}`)
console.log(`Dry run: ${dryRun}`)
console.log(`Run release job: ${runRelease}`)
