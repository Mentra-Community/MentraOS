#!/usr/bin/env node
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"

const packagePath = "mobile/modules/engine/package.json"
const workflowPath = ".github/workflows/engine-release.yml"

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

function fileExistsAt(ref, path) {
  try {
    git(["cat-file", "-e", `${ref}:${path}`])
    return true
  } catch {
    return false
  }
}

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`)
    return
  }
  execFileSync("bash", ["-lc", 'cat >> "$GITHUB_OUTPUT"'], {
    input: `${name}=${value}\n`,
    env: process.env,
  })
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

const previousPackage = beforeSha ? readJsonAt(beforeSha, packagePath) : null
const previousVersion = previousPackage?.version || ""
// A missing package at the before-SHA is the initial release, so 0.1.0 is
// published when the Engine package first lands on dev.
const versionChanged = Boolean(beforeSha) && previousVersion !== currentVersion
// Also run when this workflow first lands. That covers the stacked-PR merge
// order where the Engine package reaches dev before its release workflow.
const workflowAdded = Boolean(beforeSha) && !fileExistsAt(beforeSha, workflowPath)
const runRelease = versionChanged || workflowAdded || forceRelease || (eventName === "workflow_dispatch" && dryRun)

setOutput("package_name", currentPackage.name)
setOutput("version", currentVersion)
setOutput("previous_version", previousVersion)
setOutput("compare_sha", beforeSha)
setOutput("version_changed", String(versionChanged))
setOutput("workflow_added", String(workflowAdded))
setOutput("force_release", String(forceRelease))
setOutput("dry_run", String(dryRun))
setOutput("run_release", String(runRelease))

console.log(`Mentra Engine package: ${currentPackage.name}`)
console.log(`Current version: ${currentVersion}`)
console.log(`Previous version: ${previousVersion || "(not present)"}`)
console.log(`Compare SHA: ${beforeSha || "(unavailable)"}`)
console.log(`Version changed: ${versionChanged}`)
console.log(`Release workflow added: ${workflowAdded}`)
console.log(`Force release: ${forceRelease}`)
console.log(`Dry run: ${dryRun}`)
console.log(`Run release job: ${runRelease}`)
