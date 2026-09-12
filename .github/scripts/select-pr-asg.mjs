#!/usr/bin/env node
// Select the ASG client a pull request build should ship.
//
// A PR mobile APK pins an OTA manifest that must point at an ASG client built
// from the PR's own ASG sources. Building one on every PR is wasteful: most
// PRs never touch asg_client, and the coordinated release lane already keeps a
// content-addressed ASG artifact (APK + provenance) per source fingerprint on
// the mentra-coordinated-asg GitHub release. This script computes the PR's
// fingerprint with the same rules as that lane and reports whether such an
// artifact exists ("reuse") or the PR has to build its own ("build").
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {allocateAsgVersion} from "./allocate-asg-version.mjs"
import {computeAsgBuildFingerprintFromGit, requireAsgVersionName} from "./compute-asg-build-identity.mjs"

export function selectPrAsg({assets, fingerprint, baseVersion}) {
  // The allocator implements the release lane's matching rules (complete
  // APK + provenance pair, version code inside the family namespace); its
  // allocation of a new code on a miss is irrelevant here and ignored.
  const allocation = allocateAsgVersion({assets, fingerprint, baseVersion})
  if (allocation.exists) {
    return {
      mode: "reuse",
      fingerprint,
      baseVersion,
      versionCode: allocation.versionCode,
      apkAsset: allocation.apkAsset,
      provenanceAsset: allocation.provenanceAsset,
    }
  }
  return {mode: "build", fingerprint, baseVersion}
}

export function readFamilyBaseVersion(repoRoot) {
  const {version} = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  return requireAsgVersionName(version)
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
  const repoRoot = path.resolve(args["repo-root"] || process.cwd())
  const sourceCommit = args["source-commit"]
  if (!sourceCommit) throw new Error("Missing --source-commit")
  if (!args.assets) throw new Error("Missing --assets")
  const output = path.resolve(repoRoot, args.output || "pr-asg-selection.json")

  const baseVersion = readFamilyBaseVersion(repoRoot)
  const {fingerprint} = computeAsgBuildFingerprintFromGit({repoRoot, sourceCommit, versionName: baseVersion})
  const assets = JSON.parse(readFileSync(path.resolve(args.assets), "utf8"))
  const selection = selectPrAsg({assets, fingerprint, baseVersion})

  mkdirSync(path.dirname(output), {recursive: true})
  writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `mode=${selection.mode}`,
      `fingerprint=${selection.fingerprint}`,
      `version_code=${selection.versionCode ?? ""}`,
      `apk_asset=${selection.apkAsset ?? ""}`,
      `provenance_asset=${selection.provenanceAsset ?? ""}`,
    ]
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {flag: "a"})
  }
  console.log(
    selection.mode === "reuse"
      ? `ASG sources match coordinated build ${selection.versionCode} (${selection.apkAsset}); reusing it.`
      : `No coordinated ASG build matches fingerprint ${selection.fingerprint}; this PR builds its own.`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
