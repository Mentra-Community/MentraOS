#!/usr/bin/env node
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {appendFileSync, mkdirSync, readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

import {exampleTestflightDestination} from "./example-release-records.mjs"
import {finalizeReleaseManifest, releaseRecordSha256} from "./release-family.mjs"
import {artifactUrl, legacyArtifactUrl, listReleaseAssets} from "./release-artifact-storage.mjs"
import {completedReleaseDownloads} from "./publish-coordinated-release-page.mjs"

export function selectCoreReleaseArtifacts({run, jobs, artifacts, repository, branch, runId}) {
  if (!/^[1-9]\d*$/.test(String(runId)) || !["dev", "staging"].includes(branch)) {
    throw new Error("An exact core run ID and dev/staging branch are required")
  }
  if (
    String(run.id) !== String(runId) ||
    run.repository?.full_name !== repository ||
    run.path !== ".github/workflows/coordinated-release.yml" ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.head_branch !== branch ||
    !/^[0-9a-f]{40}$/.test(run.head_sha || "")
  ) {
    throw new Error("Source must be a coordinated core run from this repository and channel")
  }
  // The core may still be notifying/dispatching, or an old combined run may
  // have failed only its examples. Require the finalizer, not the run conclusion.
  const finalizers = jobs.filter((job) => job.name === "Finalize immutable release bill of materials")
  if (finalizers.length !== 1 || finalizers[0].conclusion !== "success") {
    throw new Error("Core release finalization has not succeeded")
  }
  const plans = artifacts.filter((artifact) => artifact.name.startsWith("coordinated-release-plan-"))
  if (plans.length !== 1 || plans[0].expired) throw new Error("Expected one unexpired core release plan")
  const channel = branch === "dev" ? "dev" : "beta"
  const match = new RegExp(`^coordinated-release-plan-mentra-(\\d+\\.\\d+\\.\\d+-${channel}\\.[1-9]\\d*)$`).exec(
    plans[0].name,
  )
  if (!match) throw new Error("Core plan artifact has the wrong release channel")
  const identity = match[1]
  const resultName = `coordinated-release-result-mentra-${identity}`
  const results = artifacts.filter((artifact) => artifact.name === resultName)
  if (results.length !== 1 || results[0].expired) throw new Error("Expected one unexpired finalized core result")
  return {identity, channel, planName: plans[0].name, resultName}
}

export function validateCoreReleaseHandoff({plan, manifest, run, selection, repository}) {
  if (
    plan.releaseIdentity !== selection.identity ||
    plan.channel !== selection.channel ||
    plan.sourceCommit !== run.head_sha ||
    plan.releaseSetId !== `mentra-${selection.identity}` ||
    plan.artifactContainerTag !== `mentra-builds-v${plan.familyBaseVersion}` ||
    plan.artifactNames?.releaseManifest !== `mentra-release-${selection.identity}.json`
  ) {
    throw new Error("Release plan does not match the selected core run")
  }
  // Reuse the core validator for the entire publication closure. This also
  // checks that the manifest binds the exact plan digest, source and identity.
  assert.deepEqual(finalizeReleaseManifest({plan, results: manifest, completedAt: manifest.completedAt}), manifest)
  assert.equal(manifest.releasePlanSha256, releaseRecordSha256(plan))
  assert.ok(
    [artifactUrl, legacyArtifactUrl].some(
      (url) => manifest.otaManifest.url === url(repository, plan.artifactContainerTag, plan.artifactNames.otaManifest),
    ),
    "OTA manifest URL must identify this release's exact artifact",
  )
  const destination = exampleTestflightDestination(plan.channel)
  const downloads = completedReleaseDownloads(plan, manifest)
  return {
    source_commit: plan.sourceCommit,
    release_identity: plan.releaseIdentity,
    release_set_id: plan.releaseSetId,
    mobile_apk_url: downloads.apk.url,
    mobile_apk_name: downloads.apk.coordinate,
    mobile_ipa_url: downloads.ipa.url,
    mobile_ipa_name: downloads.ipa.coordinate,
    plan_artifact: selection.planName,
    manifest_url: manifest.otaManifest.url,
    manifest_sha256: manifest.otaManifest.sha256,
    example_play_track: plan.channel === "dev" ? "internal" : "beta",
    example_testflight_group: destination.group,
    example_testflight_audience: destination.audience,
  }
}

async function main() {
  const {GITHUB_REPOSITORY: repository, BRANCH: branch, SOURCE_RUN_ID: runId, GITHUB_OUTPUT: output} = process.env
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || !/^[1-9]\d*$/.test(runId || "")) {
    throw new Error("Repository and numeric SOURCE_RUN_ID are required")
  }
  const gh = (...args) => execFileSync("gh", args, {encoding: "utf8", maxBuffer: 16 * 1024 * 1024})
  const api = (route) => JSON.parse(gh("api", `repos/${repository}/${route}`))
  const pages = (route, field) =>
    JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/${route}`)).flatMap((page) => page[field])
  const run = api(`actions/runs/${runId}`)
  const selection = selectCoreReleaseArtifacts({
    run,
    repository,
    branch,
    runId,
    jobs: pages(`actions/runs/${runId}/jobs?filter=latest&per_page=100`, "jobs"),
    artifacts: pages(`actions/runs/${runId}/artifacts?per_page=100`, "artifacts"),
  })
  mkdirSync("release-handoff", {recursive: true})
  gh("run", "download", runId, "--repo", repository, "--name", selection.planName, "--dir", "release-handoff/plan")
  gh(
    "run",
    "download",
    runId,
    "--repo",
    repository,
    "--name",
    selection.resultName,
    "--dir",
    "release-handoff/finalized",
  )
  const plan = JSON.parse(readFileSync("release-handoff/plan/release-plan.json", "utf8"))
  const manifestPath = path.join("release-handoff/finalized", `mentra-release-${selection.identity}.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const outputs = validateCoreReleaseHandoff({plan, manifest, run, selection, repository})
  const release = api(`releases/tags/${plan.artifactContainerTag}`)
  if (release.draft || !release.prerelease || release.tag_name !== plan.artifactContainerTag) {
    throw new Error("Core release container must be a public prerelease")
  }
  // Compare the uploaded result with the immutable, publicly downloadable record.
  const assets = await listReleaseAssets(repository, release)
  const matches = assets.filter((asset) => asset.name === plan.artifactNames.releaseManifest)
  if (matches.length !== 1) throw new Error("Expected exactly one published core manifest")
  execFileSync(
    process.execPath,
    [
      ".github/scripts/verify-public-release-asset.mjs",
      "--file",
      manifestPath,
      "--url",
      matches[0].browser_download_url,
    ],
    {stdio: "inherit"},
  )
  outputs.release_id = String(release.id)
  for (const [key, value] of Object.entries(outputs)) {
    if (/[\r\n]/.test(String(value))) throw new Error(`Invalid output ${key}`)
    appendFileSync(output, `${key}=${value}\n`)
  }
  console.log(`Loaded finalized ${plan.releaseIdentity} from core run ${runId}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
