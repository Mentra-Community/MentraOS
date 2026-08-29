#!/usr/bin/env node
import {execFileSync} from "node:child_process"
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
  start    --beta X.Y.Z-beta.N
  status   --release X.Y.Z [--attempt N] [--refresh] [--json]
  next     --release X.Y.Z [--attempt N] [--yes]
  attest   --release X.Y.Z [--attempt N] --check NAME --evidence FILE [--yes]
  release  --release X.Y.Z [--attempt N] [--yes]
  advance  --release X.Y.Z [--attempt N] [--android-percent N | --complete] [--yes]
  abort    --release X.Y.Z [--attempt N] --reason TEXT [--yes]
  watch    --run RUN_ID

This CLI dispatches protected GitHub workflows. It never reads production
credentials or directly calls Porter, App Store Connect, or Google Play.
See .github/production-release/README.md for the complete procedure.`
}

function execGh(args, options = {}) {
  return execFileSync("gh", args, {encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options})
}

function ghJson(args) {
  return JSON.parse(execGh(args))
}

function listReleases() {
  return ghJson(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/releases?per_page=100`]).flat()
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
  const assets = ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`,
  ]).flat()
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

  if (command === "start") {
    if (!BETA_PATTERN.test(options.beta || "")) throw commandError("start requires --beta X.Y.Z-beta.N")
    verifyCheckoutForStart()
    dispatch("production-release-prepare.yml", {beta_identity: options.beta})
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
    await confirmEffect(
      options.complete
        ? "This requests final verification and completion of the public release."
        : `This requests increasing the Android production rollout to ${percent}%.`,
      {...options, release: releaseIdentity},
    )
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
