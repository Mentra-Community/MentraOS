#!/usr/bin/env node
import {execFileSync, spawnSync} from "node:child_process"
import {createHash} from "node:crypto"
import {copyFileSync, mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {createInterface} from "node:readline/promises"

import {
  matchingPromotionContainers,
  requirePromotionContainer,
  stateAssets,
  validateStateRecordChain,
} from "../.github/scripts/production-promotion-assets.mjs"
import {ATTESTATION_CHECKS, nextAction, validateAttestation} from "../.github/scripts/production-promotion-state.mjs"

const REPOSITORY = "Mentra-Community/MentraOS"
const DEFAULT_REF = "main"
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BETA_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/
const SHA_PATTERN = /^[0-9a-f]{40}$/

function commandError(message) {
  const error = new Error(message)
  error.showUsage = true
  return error
}

export function parseCliArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  const positionals = []
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]
    if (!item.startsWith("--")) {
      positionals.push(item)
      continue
    }
    const key = item.slice(2)
    if (new Set(["yes", "json", "refresh", "complete"]).has(key)) {
      options[key] = true
      continue
    }
    const value = rest[index + 1]
    if (value === undefined || value.startsWith("--")) throw commandError(`${item} requires a value`)
    options[key] = value
    index += 1
  }
  return {command, options, positionals}
}

function usage() {
  return `Usage: scripts/production-release.mjs <command> [options]

Commands:
  promote  --beta X.Y.Z-beta.N [--yes]
  start    --beta X.Y.Z-beta.N
  status   --release X.Y.Z [--attempt N] [--refresh] [--json]
  next     --release X.Y.Z [--attempt N] [--yes]
  attest   --release X.Y.Z [--attempt N] --check NAME --evidence FILE [--yes]
  release  --release X.Y.Z [--attempt N] [--yes]
  advance  --release X.Y.Z [--attempt N] [--android-percent N | --complete] [--yes]
  abort    --release X.Y.Z [--attempt N] --reason TEXT [--yes]
  packages --beta X.Y.Z-beta.N --phase publish|release [--yes]
  watch    --run RUN_ID

This CLI dispatches protected GitHub workflows. It never reads production
credentials or directly calls Porter, App Store Connect, or Google Play.
See .github/production-release/README.md for the complete procedure.`
}

// Node's default spawn buffer is 1 MB. GitHub listings for this repository
// already exceed it (the release list is several megabytes and the builds
// release alone has hundreds of assets), so every gh call gets a generous
// buffer AND the listings below ask gh to project only the fields used.
const GH_MAX_BUFFER = 64 * 1024 * 1024
const RELEASE_FIELDS = "{id, tag_name, name, draft, prerelease, body, target_commitish}"
const ASSET_FIELDS = "{id, name, digest, size, url, browser_download_url}"

function execGh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: GH_MAX_BUFFER,
    ...options,
  })
}

function ghJson(args) {
  return JSON.parse(execGh(args))
}

export function parseJsonLines(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// `gh api --paginate` cannot combine --slurp with --jq, so page through with a
// projection that emits one JSON object per line and parse those lines.
function ghPaginated(endpoint, projection) {
  return parseJsonLines(execGh(["api", "--paginate", endpoint, "--jq", `.[] | ${projection} | tojson`]))
}

function branchHead(repository, branch) {
  return execGh(["api", `repos/${repository}/branches/${branch}`, "--jq", ".commit.sha"]).trim()
}

function compareCommits(repository, base, head) {
  // Only the relationship is needed. The full compare payload lists commits
  // and file patches, which for a whole release cycle exceeds the spawn buffer
  // (spawnSync gh ENOBUFS), so trim it in gh before it reaches this process.
  return ghJson([
    "api",
    `repos/${repository}/compare/${base}...${head}?per_page=1`,
    "--jq",
    "{status: .status, ahead_by: .ahead_by, behind_by: .behind_by}",
  ])
}

function ensureCommitIsOnBranch(repository, commit, branch) {
  const head = branchHead(repository, branch)
  const comparison = compareCommits(repository, commit, head)
  if (comparison.behind_by !== 0) {
    throw new Error(`${repository}:${commit} is not contained in ${branch}`)
  }
}

export function branchPromotionState(sourceToTarget, targetToSource) {
  if (sourceToTarget.behind_by === 0) return "complete"
  if (targetToSource.behind_by === 0) return "ready"
  return "diverged"
}

function requirePromotionRelationship(repository, target, sourceCommit) {
  const targetHead = branchHead(repository, target)
  const sourceToTarget = compareCommits(repository, sourceCommit, targetHead)
  if (sourceToTarget.behind_by === 0) return {state: "complete", targetHead}
  const targetToSource = compareCommits(repository, targetHead, sourceCommit)
  const state = branchPromotionState(sourceToTarget, targetToSource)
  if (state === "diverged") {
    throw new Error(
      `${repository}:${sourceCommit} does not contain ${target} at ${targetHead}; back-merge ${target} into staging and complete a new coordinated beta before promotion`,
    )
  }
  return {state, targetHead}
}

function promotionBranchHead(repository, branch) {
  const encoded = encodeURIComponent(`heads/${branch}`)
  try {
    return execFileSync("gh", ["api", `repos/${repository}/git/ref/${encoded}`, "--jq", ".object.sha"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    if (!String(error.stderr || error.message).includes("HTTP 404")) throw error
    return undefined
  }
}

function ensurePromotionBranch(repository, branch, commit) {
  const existing = promotionBranchHead(repository, branch)
  if (existing) {
    if (existing !== commit) throw new Error(`${repository}:${branch} points to ${existing}, expected ${commit}`)
    return
  }
  execGh([
    "api",
    "--method",
    "POST",
    `repos/${repository}/git/refs`,
    "-f",
    `ref=refs/heads/${branch}`,
    "-f",
    `sha=${commit}`,
  ])
}

// A promotion pull request's head is the exact beta source commit, so every
// check-run of the coordinated release that built that beta is attached to it,
// including jobs that do not gate the beta (the Bluetooth example's store
// publishes). `gh pr checks --fail-fast` would count those, and the advisory
// pull-request bots, as merge blockers. The promotion gate is therefore the
// repository's own aggregate of required area builds, the `ci-gate-*` commit
// status, and only if no such status exists on the head do the pull-request
// triggered check-runs (never push-triggered ones) decide.
const CI_GATE_CONTEXT = /^ci-gate(-[a-z0-9-]+)?$/
const PROMOTION_GATE_POLL_SECONDS = 30
const PROMOTION_GATE_TIMEOUT_SECONDS = 4 * 60 * 60
// Right after the pull request is created only the beta's push-triggered rows
// exist; the pull request's own builders and the ci-gate status register over
// the following minutes. Until that settling window has elapsed, an empty gate
// means "not registered yet", never "nothing to run".
const PROMOTION_GATE_SETTLE_SECONDS = 15 * 60
const PROMOTION_GATE_CALL_TIMEOUT_MS = 2 * 60 * 1000

export function promotionGateState(rows, {settled = false} = {}) {
  if (!Array.isArray(rows)) throw new Error("Pull request checks must be an array")
  const gates = rows.filter((row) => CI_GATE_CONTEXT.test(row.name || "") && !row.workflow)
  const relevant = gates.length > 0 ? gates : rows.filter((row) => row.event === "pull_request")
  const failed = relevant.filter((row) => row.bucket === "fail" || row.bucket === "cancel")
  if (failed.length > 0) return {state: "failed", rows: failed}
  const pending = relevant.filter((row) => row.bucket === "pending")
  if (pending.length > 0) return {state: "pending", rows: pending}
  if (relevant.length === 0 && !settled) return {state: "pending", rows: []}
  return {state: "passed", rows: relevant}
}

function pullRequestChecks(url, repository) {
  // gh exits 8 while checks are pending and 1 when any failed; the JSON is
  // still complete in both cases, so read stdout regardless of the status.
  const result = spawnSync(
    "gh",
    ["pr", "checks", url, "--repo", repository, "--json", "name,workflow,event,bucket,description"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GH_MAX_BUFFER,
      timeout: PROMOTION_GATE_CALL_TIMEOUT_MS,
    },
  )
  if (result.error) throw result.error
  const output = (result.stdout || "").trim()
  if (!output.startsWith("[")) {
    throw new Error(`gh pr checks failed for ${url}: ${(result.stderr || output).trim()}`)
  }
  return JSON.parse(output)
}

function waitForPromotionGate(url, repository) {
  const started = Date.now()
  const deadline = started + PROMOTION_GATE_TIMEOUT_SECONDS * 1000
  for (;;) {
    const settled = Date.now() - started >= PROMOTION_GATE_SETTLE_SECONDS * 1000
    const gate = promotionGateState(pullRequestChecks(url, repository), {settled})
    const names = gate.rows.map((row) => row.name).join(", ") || "checks to register"
    if (gate.state === "failed") throw new Error(`${url} has failing checks: ${names}`)
    if (gate.state === "passed") {
      console.log(`Checks passed for ${url}${names ? `: ${names}` : ""}`)
      return
    }
    if (Date.now() > deadline) throw new Error(`${url} checks are still pending: ${names}`)
    console.log(`Waiting on: ${names}`)
    execFileSync("sleep", [String(PROMOTION_GATE_POLL_SECONDS)])
  }
}

function promoteExactCommit({repository, sourceCommit, target, releaseIdentity, mergeBody}) {
  ensureCommitIsOnBranch(repository, sourceCommit, "staging")
  const relationship = requirePromotionRelationship(repository, target, sourceCommit)
  const {targetHead} = relationship
  if (relationship.state === "complete") {
    console.log(`${repository}:${target} already contains ${sourceCommit}`)
    return targetHead
  }

  const branch = `release/promote-${releaseIdentity}-staging-to-${target}-${sourceCommit.slice(0, 8)}`
  ensurePromotionBranch(repository, branch, sourceCommit)
  const pulls = ghJson([
    "pr",
    "list",
    "--repo",
    repository,
    "--head",
    branch,
    "--base",
    target,
    "--state",
    "all",
    "--json",
    "url,state,headRefOid,mergeCommit",
  ])
  if (pulls.length > 1) throw new Error(`${repository}:${branch} has more than one promotion pull request`)
  let pull = pulls[0]
  if (pull && pull.headRefOid !== sourceCommit) {
    throw new Error(`${pull.url} head is ${pull.headRefOid}, expected ${sourceCommit}`)
  }
  if (pull?.state === "MERGED") {
    ensureCommitIsOnBranch(repository, sourceCommit, target)
    return pull.mergeCommit.oid
  }
  if (!pull) {
    const body = [
      `Promote the exact coordinated beta source \`${sourceCommit}\` from \`staging\` into \`${target}\`.`,
      "",
      "This pull request was created by `production-release promote` and must retain the exact recorded head.",
    ].join("\n")
    const url = execGh([
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      target,
      "--head",
      branch,
      "--title",
      `Promote staging to ${target} for ${releaseIdentity}`,
      "--body",
      body,
    ]).trim()
    pull = {url, state: "OPEN", headRefOid: sourceCommit}
  }
  if (pull.state !== "OPEN") throw new Error(`${pull.url} is ${pull.state.toLowerCase()}`)

  console.log(`Waiting for ${pull.url}`)
  waitForPromotionGate(pull.url, repository)
  const currentTargetHead = branchHead(repository, target)
  if (currentTargetHead !== targetHead) {
    throw new Error(
      `${repository}:${target} moved from ${targetHead} to ${currentTargetHead} while checks ran; rerun promotion`,
    )
  }
  const mergeArgs = ["pr", "merge", pull.url, "--repo", repository, "--merge", "--match-head-commit", sourceCommit]
  if (mergeBody) mergeArgs.push("--body", mergeBody)
  execGh(mergeArgs)
  const merged = ghJson(["pr", "view", pull.url, "--repo", repository, "--json", "state,mergeCommit"])
  if (merged.state !== "MERGED" || !merged.mergeCommit?.oid) throw new Error(`${pull.url} did not merge`)
  ensureCommitIsOnBranch(repository, sourceCommit, target)
  return merged.mergeCommit.oid
}

export function releaseBranchSources(result, betaIdentity) {
  if (result?.schemaVersion !== 1 || result.releaseIdentity !== betaIdentity || result.channel !== "beta") {
    throw new Error(`The coordinated release result does not describe completed beta ${betaIdentity}`)
  }
  const mentraosCommit = result.sourceCommit
  if (!SHA_PATTERN.test(mentraosCommit || "")) throw new Error("The beta result has no valid MentraOS source commit")
  if (!result.completedAt) throw new Error("The beta result is not complete")
  return {mentraosCommit}
}

function loadReleaseBranchSources(betaIdentity) {
  const family = betaIdentity.slice(0, betaIdentity.indexOf("-beta."))
  const assetName = `mentra-release-${betaIdentity}.json`
  const matches = parseJsonLines(
    execGh([
      "release",
      "view",
      `mentra-builds-v${family}`,
      "--repo",
      REPOSITORY,
      "--json",
      "assets",
      "--jq",
      `.assets[] | select(.name == ${JSON.stringify(assetName)}) | {name, apiUrl, digest} | tojson`,
    ]),
  )
  if (matches.length > 1) throw new Error(`Release contains duplicate asset ${assetName}`)
  const asset = matches[0]
  if (!asset) throw new Error(`Completed release asset ${assetName} was not found`)
  const contents = execGh(["api", "-H", "Accept: application/octet-stream", asset.apiUrl], {
    maxBuffer: 20 * 1024 * 1024,
  })
  if (asset.digest) {
    const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`
    if (digest !== asset.digest) throw new Error(`${assetName} digest is ${digest}, expected ${asset.digest}`)
  }
  return releaseBranchSources(JSON.parse(contents), betaIdentity)
}

function listReleases() {
  return ghPaginated(`repos/${REPOSITORY}/releases?per_page=100`, RELEASE_FIELDS)
}

function resolveAttempt(releases, releaseIdentity, requestedAttempt) {
  const matches = matchingPromotionContainers(releases, releaseIdentity)
  if (requestedAttempt !== undefined) {
    const attempt = Number(requestedAttempt)
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw commandError("--attempt must be a positive integer")
    requirePromotionContainer(releases, releaseIdentity, attempt)
    return attempt
  }
  if (matches.length === 0) throw new Error(`No production promotion exists for ${releaseIdentity}`)
  return matches.at(-1).attempt
}

function loadLatestRecord(releaseIdentity, requestedAttempt) {
  const releases = listReleases()
  const attempt = resolveAttempt(releases, releaseIdentity, requestedAttempt)
  const release = requirePromotionContainer(releases, releaseIdentity, attempt)
  const assets = ghPaginated(`repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`, ASSET_FIELDS)
  const states = stateAssets(assets, releaseIdentity, attempt)
  if (states.length === 0) throw new Error(`Promotion ${releaseIdentity} attempt ${attempt} has no state record`)
  const entries = states.map((state) => {
    const contents = execGh(
      ["api", "-H", "Accept: application/octet-stream", `repos/${REPOSITORY}/releases/assets/${state.asset.id}`],
      {encoding: "utf8", maxBuffer: 20 * 1024 * 1024},
    )
    return {...state, record: JSON.parse(contents)}
  })
  const record = validateStateRecordChain(entries, releaseIdentity, attempt)
  const latest = entries.at(-1)
  return {record, release, asset: latest.asset}
}

function requireVersion(value) {
  if (!VERSION_PATTERN.test(value || "")) throw commandError("--release must be a plain X.Y.Z version")
  return value
}

function dispatch(workflow, fields) {
  const args = ["workflow", "run", workflow, "--repo", REPOSITORY, "--ref", DEFAULT_REF]
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`)
  const result = execGh(args)
  if (result.trim()) process.stdout.write(result)
  console.log(`Dispatched ${workflow} from ${DEFAULT_REF}.`)
  console.log(`https://github.com/${REPOSITORY}/actions/workflows/${workflow}`)
}

export function statusSummary(record) {
  const action = nextAction(record)
  return {
    promotionId: record.promotionId,
    releaseIdentity: record.releaseIdentity,
    attempt: record.attempt,
    selectedBeta: record.selectedBeta.identity,
    state: record.state,
    sequence: record.sequence,
    sourceCommit: record.source.mentraosCommit,
    evidenceCount: record.evidence.length,
    nextAction: action,
  }
}

function printStatus(record, asJson) {
  const summary = statusSummary(record)
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`${summary.promotionId}: ${summary.state}`)
  console.log(`Selected beta: ${summary.selectedBeta}`)
  console.log(`MentraOS source: ${summary.sourceCommit}`)
  console.log(`Evidence records: ${summary.evidenceCount}`)
  if (summary.nextAction.kind === "none") console.log("Next action: none")
  else if (summary.nextAction.kind === "attest") console.log(`Next action: attest ${summary.nextAction.check}`)
  else if (summary.nextAction.kind === "workflow") {
    console.log(`Next action: ${summary.nextAction.phase} through ${summary.nextAction.workflow}`)
  } else console.log(`Next action: run '${summary.nextAction.command}'`)
}

async function confirmEffect(message, options) {
  if (options.yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing a mutating command without an interactive terminal; rerun with --yes after reviewing it")
  }
  console.log(message)
  const reader = createInterface({input: process.stdin, output: process.stdout})
  const answer = await reader.question("Type the release identity to continue: ")
  reader.close()
  if (answer !== options.release) throw new Error("Confirmation did not match the release identity")
}

function verifyCheckoutForStart() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding: "utf8"}).trim()
  const actual = execGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim()
  if (actual !== REPOSITORY) throw new Error(`This checkout is ${actual}, expected ${REPOSITORY}`)
  const dirty = execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim()
  if (dirty) throw new Error("start requires a clean checkout; commit or move local changes first")
}

function verifyCheckoutForPromotion() {
  verifyCheckoutForStart()
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding: "utf8"}).trim()
  const branch = execFileSync("git", ["branch", "--show-current"], {cwd: root, encoding: "utf8"}).trim()
  if (branch !== "staging") throw new Error(`promote requires a staging checkout, not ${branch || "detached HEAD"}`)
  const localHead = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim()
  const remoteHead = branchHead(REPOSITORY, "staging")
  if (localHead !== remoteHead) throw new Error(`local staging is ${localHead}, but remote staging is ${remoteHead}`)
}

async function confirmBranchPromotion(betaIdentity, options) {
  if (options.yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing branch promotion without an interactive terminal; rerun with --yes after reviewing it")
  }
  console.log(`This promotes the exact ${betaIdentity} MentraOS source from staging to main.`)
  const reader = createInterface({input: process.stdin, output: process.stdout})
  const answer = await reader.question("Type the beta identity to continue: ")
  reader.close()
  if (answer !== betaIdentity) throw new Error("Confirmation did not match the beta identity")
}

function uploadAttestation({release, record, check, evidenceFile}) {
  const original = path.resolve(evidenceFile)
  const contents = readFileSync(original)
  const sha256 = createHash("sha256").update(contents).digest("hex")
  const name = `production-attestation-${record.promotionId}-${check}-${sha256.slice(0, 12)}.json`
  const directory = mkdtempSync(path.join(tmpdir(), "mentra-production-attestation-"))
  const staged = path.join(directory, name)
  copyFileSync(original, staged)
  execFileSync(
    process.execPath,
    [
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../.github/scripts/publish-immutable-release-asset.mjs",
      ),
      "--file",
      staged,
      "--name",
      name,
      "--release-id",
      String(release.id),
      "--repository",
      REPOSITORY,
    ],
    {stdio: "inherit"},
  )
  return {name, sha256}
}

export function requireCommandState(command, record, options = {}) {
  const action = nextAction(record)
  if (command === "next" && action.kind !== "workflow") {
    throw new Error(`Promotion state ${record.state} does not have an automated next phase`)
  }
  if (command === "attest") {
    if (action.kind !== "attest" || action.check !== options.check) {
      throw new Error(`Promotion state ${record.state} expects ${action.check || action.kind}, not ${options.check}`)
    }
  }
  if (command === "release" && record.state !== "stores-approved") {
    throw new Error(`Public release requires stores-approved, not ${record.state}`)
  }
  if (command === "advance" && !new Set(["rolling-out", "finalizing"]).has(record.state)) {
    throw new Error(`Rollout advancement requires rolling-out or finalizing, not ${record.state}`)
  }
  if (command === "abort" && record.state === "finalizing") {
    throw new Error("Cannot abort after the 100 percent rollout checkpoint; resume finalization")
  }
  if (command === "abort" && new Set(["aborted", "completed"]).has(record.state)) {
    throw new Error(`Cannot abort terminal promotion state ${record.state}`)
  }
  return action
}

export function validateAdvanceOptions(record, options) {
  requireCommandState("advance", record)
  const percent = options["android-percent"]
  if (Boolean(percent) === Boolean(options.complete)) {
    throw commandError("advance requires exactly one of --android-percent N or --complete")
  }
  if (percent && (!/^\d+$/.test(percent) || Number(percent) < 1 || Number(percent) > 99)) {
    throw commandError("--android-percent must be an integer from 1 through 99; use --complete for 100")
  }
  if (record.state === "finalizing" && !options.complete) {
    throw commandError("a finalizing promotion can only be resumed with --complete")
  }
  return {action: options.complete ? "complete" : "advance", androidPercent: percent || "100"}
}

// Stable packages (npm latest, Maven Central, SwiftPM) are keyed on the
// promoted beta, not on a promotion attempt, so they can ship before, during,
// or after store review.
export const PACKAGE_PHASES = Object.freeze(["publish", "release"])

export function validatePackagesOptions(options) {
  if (!BETA_PATTERN.test(options.beta || "")) throw commandError("packages requires --beta X.Y.Z-beta.N")
  if (!PACKAGE_PHASES.includes(options.phase))
    throw commandError("packages requires --phase publish or --phase release")
  return {beta_identity: options.beta, phase: options.phase}
}

export function packagesConfirmationMessage(request) {
  return request.phase === "publish"
    ? `This publishes the plain ${request.beta_identity.replace(/-beta\.\d+$/, "")} package versions under a candidate npm dist-tag and stages Maven Central and SwiftPM. GitHub will still require production-packages approval.`
    : `This moves npm latest, publishes Maven Central, and pushes the public SwiftPM tag for ${request.beta_identity.replace(/-beta\.\d+$/, "")}. GitHub will still require production-packages-release approval.`
}

export function advanceConfirmationMessage(request) {
  return request.action === "complete"
    ? "This requests final verification and completion of the public release."
    : `This requests increasing the Android production rollout to ${request.androidPercent}%.`
}

async function main(argv = process.argv.slice(2)) {
  const {command, options, positionals} = parseCliArgs(argv)
  if (!command || command === "help" || command === "--help" || positionals.length > 0) {
    console.log(usage())
    if (!command || positionals.length > 0) process.exitCode = 2
    return
  }

  if (command === "watch") {
    if (!/^\d+$/.test(options.run || "")) throw commandError("watch requires --run RUN_ID")
    execFileSync("gh", ["run", "watch", options.run, "--repo", REPOSITORY, "--exit-status"], {stdio: "inherit"})
    return
  }

  if (command === "promote") {
    if (!BETA_PATTERN.test(options.beta || "")) throw commandError("promote requires --beta X.Y.Z-beta.N")
    verifyCheckoutForPromotion()
    const sources = loadReleaseBranchSources(options.beta)
    ensureCommitIsOnBranch(REPOSITORY, sources.mentraosCommit, "staging")
    requirePromotionRelationship(REPOSITORY, "main", sources.mentraosCommit)
    await confirmBranchPromotion(options.beta, options)
    promoteExactCommit({
      repository: REPOSITORY,
      sourceCommit: sources.mentraosCommit,
      target: "main",
      releaseIdentity: options.beta,
    })
    console.log(`Branch promotion for ${options.beta} is complete. Continue from a clean, up-to-date main checkout.`)
    return
  }

  if (command === "start") {
    if (!BETA_PATTERN.test(options.beta || "")) throw commandError("start requires --beta X.Y.Z-beta.N")
    verifyCheckoutForStart()
    dispatch("production-release-prepare.yml", {beta_identity: options.beta})
    return
  }

  if (command === "packages") {
    const request = validatePackagesOptions(options)
    await confirmEffect(packagesConfirmationMessage(request), {
      ...options,
      release: request.beta_identity.replace(/-beta\.\d+$/, ""),
    })
    dispatch("production-release-packages.yml", request)
    return
  }

  const releaseIdentity = requireVersion(options.release)
  const loaded = loadLatestRecord(releaseIdentity, options.attempt)

  if (command === "status") {
    printStatus(loaded.record, options.json)
    if (options.refresh) {
      if (
        !new Set([
          "stores-submitted",
          "stores-approved",
          "public-release-approved",
          "rolling-out",
          "finalizing",
          "completed",
        ]).has(loaded.record.state)
      ) {
        throw new Error(`Store refresh is unavailable in promotion state ${loaded.record.state}`)
      }
      dispatch("production-release-status.yml", {
        release_identity: releaseIdentity,
        attempt: loaded.record.attempt,
      })
    }
    return
  }

  if (command === "next") {
    const action = requireCommandState(command, loaded.record)
    await confirmEffect(
      `This will dispatch ${action.workflow} phase ${action.phase}. Protected production effects still require GitHub approval.`,
      {...options, release: releaseIdentity},
    )
    dispatch(action.workflow, {
      release_identity: releaseIdentity,
      attempt: loaded.record.attempt,
      phase: action.phase,
    })
    return
  }

  if (command === "attest") {
    if (!ATTESTATION_CHECKS[options.check]) throw commandError("attest requires a supported --check")
    if (!options.evidence) throw commandError("attest requires --evidence FILE")
    requireCommandState(command, loaded.record, options)
    const attestation = JSON.parse(readFileSync(path.resolve(options.evidence), "utf8"))
    validateAttestation(attestation, loaded.record, options.check)
    await confirmEffect(
      `This will append passing human evidence for ${options.check}. It does not deploy or publish anything.`,
      {...options, release: releaseIdentity},
    )
    const uploaded = uploadAttestation({
      release: loaded.release,
      record: loaded.record,
      check: options.check,
      evidenceFile: options.evidence,
    })
    dispatch("production-release-attest.yml", {
      release_identity: releaseIdentity,
      attempt: loaded.record.attempt,
      check: options.check,
      evidence_asset: uploaded.name,
      evidence_sha256: uploaded.sha256,
    })
    return
  }

  if (command === "release") {
    requireCommandState(command, loaded.record)
    await confirmEffect(
      "This requests public release of the exact approved store candidates. GitHub will still require production-store-release approval.",
      {...options, release: releaseIdentity},
    )
    dispatch("production-release-store-release.yml", {
      release_identity: releaseIdentity,
      attempt: loaded.record.attempt,
      phase: "release",
    })
    return
  }

  if (command === "advance") {
    const request = validateAdvanceOptions(loaded.record, options)
    await confirmEffect(advanceConfirmationMessage(request), {...options, release: releaseIdentity})
    dispatch("production-release-rollout.yml", {
      release_identity: releaseIdentity,
      attempt: loaded.record.attempt,
      action: request.action,
      android_percent: request.androidPercent,
    })
    return
  }

  if (command === "abort") {
    requireCommandState(command, loaded.record)
    if (!options.reason) throw commandError("abort requires --reason TEXT")
    await confirmEffect(
      "This permanently aborts this promotion attempt. It does not roll back Cloud or remove installed mobile builds.",
      {...options, release: releaseIdentity},
    )
    dispatch("production-release-abort.yml", {
      release_identity: releaseIdentity,
      attempt: loaded.record.attempt,
      reason: options.reason,
    })
    return
  }

  throw commandError(`Unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(`production-release: ${error.message}`)
    if (error.showUsage) console.error(`\n${usage()}`)
    process.exitCode = 1
  }
}
