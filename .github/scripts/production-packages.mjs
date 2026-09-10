#!/usr/bin/env node
// Stable package publication for a promoted beta.
//
// production-release-packages.yml republishes the exact source of a completed
// coordinated beta as plain X.Y.Z package versions (npm latest, Maven Central,
// SwiftPM) after that source reached main. This module freezes the production
// plan those reusable jobs consume and manages the stable release container
// `mentra-vX.Y.Z` that holds their immutable records. It never touches the
// mobile or Cloud promotion state machine: package evidence lives only in that
// container, and a live promotion attempt is read solely to refuse a
// conflicting frozen beta.
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {isDeepStrictEqual} from "node:util"

import {validateSelectedBeta} from "./prepare-production-promotion.mjs"
import {RELEASE_LIST_FIELDS, parseJsonLines} from "./production-promotion-assets.mjs"
import {createReleasePlan, loadReleaseFamily, serializeReleaseRecord} from "./release-family.mjs"

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

// Identical to the body production-release-rollout.yml writes when it stages
// the canonical records, so whichever workflow allocates the draft first, the
// other one recognizes and reuses it.
export const STABLE_CONTAINER_BODY =
  "Canonical production release records. Publish manually only after the completed promotion and final public-availability checks."

export function npmCandidateTag(releaseIdentity) {
  if (!VERSION_PATTERN.test(releaseIdentity || "")) throw new Error("release identity must be X.Y.Z")
  return `candidate-${releaseIdentity}`
}

export function createProductionPackagesPlan({family, betaPlan, betaManifest, betaManifestUrl, betaManifestSha256}) {
  validateSelectedBeta({family, betaPlan, betaManifest})
  if (!/^https:\/\//.test(betaManifestUrl || "")) throw new Error("beta manifest URL must be HTTPS")
  if (!/^[0-9a-f]{64}$/.test(betaManifestSha256 || "")) throw new Error("beta manifest SHA-256 is invalid")
  // The native build number is frozen by the mobile promotion, which allocates
  // it from store inventories. Package publication never uploads an app, so
  // the beta's own number keeps this plan deterministic without store access.
  const plan = createReleasePlan({
    family,
    channel: "production",
    sourceCommit: betaPlan.sourceCommit,
    nativeBuildNumber: betaPlan.native.buildNumber,
    otaInputs: betaPlan.otaInputs,
  })
  if (!isDeepStrictEqual(plan.changelog, betaPlan.changelog)) {
    throw new Error("Selected beta changelog does not match its frozen source checkout")
  }
  if (!isDeepStrictEqual(Object.keys(plan.members).sort(), Object.keys(betaPlan.members).sort())) {
    throw new Error("Selected beta release family does not match its frozen source checkout")
  }
  plan.promotion = {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaPlan.releaseIdentity,
    selectedBetaManifest: {url: betaManifestUrl, sha256: betaManifestSha256},
    otaManifest: betaManifest.otaManifest,
  }
  return plan
}

export function stableContainerPayload(plan) {
  if (plan?.channel !== "production" || !VERSION_PATTERN.test(plan.releaseIdentity || "")) {
    throw new Error("A frozen production plan is required")
  }
  return {
    tag_name: plan.artifactContainerTag,
    target_commitish: plan.sourceCommit,
    name: plan.artifactContainerName,
    body: STABLE_CONTAINER_BODY,
    draft: true,
    prerelease: false,
  }
}

// The container starts as a draft and is published by hand after the mobile
// rollout completes. Packages may still be published after that, so a
// published (non-draft, non-prerelease) release with the same identity is
// accepted; only a prerelease or a different source is rejected.
export function requireStableContainer(release, plan) {
  const expected = stableContainerPayload(plan)
  if (
    !release ||
    release.tag_name !== expected.tag_name ||
    release.name !== expected.name ||
    typeof release.draft !== "boolean" ||
    release.prerelease !== false ||
    release.target_commitish !== expected.target_commitish
  ) {
    throw new Error(`Stable release container ${expected.tag_name} does not match the frozen production plan`)
  }
  return release
}

export function planStableContainer(releases, plan) {
  const expected = stableContainerPayload(plan)
  const matches = releases.filter((release) => release.tag_name === expected.tag_name)
  if (matches.length > 1) throw new Error(`Multiple releases are tagged ${expected.tag_name}`)
  if (matches.length === 1) return {action: "reuse", release: requireStableContainer(matches[0], plan)}
  return {action: "create", payload: expected}
}

function gh(args, options = {}) {
  const stdin = options.input === undefined ? "ignore" : "pipe"
  return execFileSync("gh", args, {
    stdio: [stdin, "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
}

function listReleases(repository) {
  return parseJsonLines(
    gh([
      "api",
      "--paginate",
      `repos/${repository}/releases?per_page=100`,
      "--jq",
      `.[] | ${RELEASE_LIST_FIELDS} | tojson`,
    ]),
  )
}

function ensureStableContainer({repository, plan}) {
  const allocation = planStableContainer(listReleases(repository), plan)
  if (allocation.action === "reuse") return allocation.release
  try {
    const created = JSON.parse(
      gh(["api", "--method", "POST", `repos/${repository}/releases`, "--input", "-"], {
        input: JSON.stringify(allocation.payload),
      }),
    )
    return requireStableContainer(created, plan)
  } catch (error) {
    // Another workflow (the rollout finalization) may have created the same
    // tag between our listing and this POST; accept it if it matches.
    const retry = planStableContainer(listReleases(repository), plan)
    if (retry.action === "reuse") return retry.release
    throw error
  }
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

function output(values, githubOutput) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) console.log(line)
  if (githubOutput) appendFileSync(path.resolve(githubOutput), `${lines.join("\n")}\n`)
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  if (command === "plan") {
    const betaManifestPath = path.resolve(args["beta-manifest"])
    const plan = createProductionPackagesPlan({
      family: loadReleaseFamily({rootDir: path.resolve(args.root || process.cwd()), requireVersionMirrors: true}),
      betaPlan: readJson(args["beta-plan"]),
      betaManifest: readJson(betaManifestPath),
      betaManifestUrl: args["beta-manifest-url"],
      betaManifestSha256: createHash("sha256").update(readFileSync(betaManifestPath)).digest("hex"),
    })
    writeFileSync(path.resolve(args.output), serializeReleaseRecord(plan))
    output(
      {
        release_identity: plan.releaseIdentity,
        release_set_id: plan.releaseSetId,
        source_commit: plan.sourceCommit,
        stable_tag: plan.artifactContainerTag,
        ota_manifest_url: plan.promotion.otaManifest.url,
        ota_manifest_sha256: plan.promotion.otaManifest.sha256,
        npm_tag: npmCandidateTag(plan.releaseIdentity),
      },
      args["github-output"],
    )
    return
  }
  if (command === "ensure-container") {
    const release = ensureStableContainer({repository: args.repository, plan: readJson(args.plan)})
    output({release_id: release.id, tag: release.tag_name}, args["github-output"])
    return
  }
  throw new Error(`Unknown production packages command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
