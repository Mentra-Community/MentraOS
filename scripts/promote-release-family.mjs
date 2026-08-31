#!/usr/bin/env node
import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {mkdtempSync, readFileSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {createInterface} from "node:readline/promises"

const MENTRAOS_REPOSITORY = "Mentra-Community/MentraOS"
const STARTER_KIT_REPOSITORY = "Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit"
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function fail(message) {
  throw new Error(`Could not promote the release family: ${message}`)
}

function gh(args, options = {}) {
  return execFileSync("gh", args, {encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options}).trim()
}

function ghJson(args) {
  return JSON.parse(gh(args))
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]
    if (item === "--yes") {
      options.yes = true
      continue
    }
    if (!item.startsWith("--")) fail(`unexpected argument ${item}`)
    const value = rest[index + 1]
    if (!value || value.startsWith("--")) fail(`${item} requires a value`)
    options[item.slice(2)] = value
    index += 1
  }
  return {command, options}
}

function usage() {
  return `Usage: bun run release:promote-family -- <command> [options]

Commands:
  start   --next X.Y.Z [--yes]
  finish  --next X.Y.Z --run RUN_ID [--yes]

start promotes an exact Starter Kit dev head to staging before promoting an
exact MentraOS dev head to staging. finish accepts only a successful MentraOS
coordinated beta run, reconciles Starter Kit staging back into dev, and then
prepares this checkout for the next release family.`
}

function versionTuple(version) {
  if (!VERSION_PATTERN.test(version || "")) fail(`${JSON.stringify(version)} is not a plain X.Y.Z version`)
  return version.split(".").map(Number)
}

function requireNextVersion(currentVersion, nextVersion) {
  const current = versionTuple(currentVersion)
  const next = versionTuple(nextVersion)
  for (let index = 0; index < current.length; index += 1) {
    if (next[index] > current[index]) return nextVersion
    if (next[index] < current[index]) break
  }
  fail(`${nextVersion} must be newer than the current family ${currentVersion}`)
}

function branchHead(repository, branch) {
  return gh(["api", `repos/${repository}/branches/${branch}`, "--jq", ".commit.sha"])
}

function ensurePromotionBranch(repository, branch, head) {
  const encoded = encodeURIComponent(`heads/${branch}`)
  try {
    const existing = execFileSync("gh", ["api", `repos/${repository}/git/ref/${encoded}`, "--jq", ".object.sha"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (existing !== head) fail(`${repository}:${branch} already points to ${existing}, expected ${head}`)
  } catch (error) {
    if (!String(error.stderr || error.message).includes("HTTP 404")) throw error
    const payload = JSON.stringify({ref: `refs/heads/${branch}`, sha: head})
    gh(["api", "--method", "POST", `repos/${repository}/git/refs`, "--input", "-"], {
      input: payload,
      stdio: ["pipe", "pipe", "inherit"],
    })
  }
}

function existingPromotionPullRequest(repository, branch, target) {
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
  if (pulls.length > 1) fail(`${repository}:${branch} has more than one promotion pull request`)
  return pulls[0]
}

function hasMergeBody(repository, commit, mergeBody) {
  const message = gh(["api", `repos/${repository}/commits/${commit}`, "--jq", ".commit.message"])
  return message.split("\n").includes(mergeBody)
}

function requireMergeBody(repository, commit, mergeBody) {
  if (mergeBody && !hasMergeBody(repository, commit, mergeBody)) {
    fail(`${repository}:${commit} does not contain ${JSON.stringify(mergeBody)}`)
  }
}

function createMetadataCommit(repository, parent, family, mergeBody) {
  const tree = gh(["api", `repos/${repository}/git/commits/${parent}`, "--jq", ".tree.sha"])
  const payload = JSON.stringify({
    message: `chore(release): refresh ${family} release inputs\n\n${mergeBody}`,
    tree,
    parents: [parent],
  })
  return gh(["api", "--method", "POST", `repos/${repository}/git/commits`, "--input", "-", "--jq", ".sha"], {
    input: payload,
    stdio: ["pipe", "pipe", "inherit"],
  })
}

function mergePromotionPullRequest({repository, branch, source, target, family, promotionHead, mergeBody, pull}) {
  if (pull?.headRefOid !== undefined && pull.headRefOid !== promotionHead) {
    fail(`${pull.url} head changed to ${pull.headRefOid}, expected ${promotionHead}`)
  }
  if (pull?.state === "MERGED") {
    requireMergeBody(repository, pull.mergeCommit.oid, mergeBody)
    return pull.mergeCommit.oid
  }

  ensurePromotionBranch(repository, branch, promotionHead)
  if (!pull) {
    const title = `Promote ${branch.includes("refresh-pin") ? "release inputs" : source} to ${target} for ${family}`
    const body = [
      `Promote the exact recorded head \`${promotionHead}\` into \`${target}\` for the ${family} release cut.`,
      "",
      "This pull request was created by `release:promote-family` and must retain the exact recorded head.",
    ].join("\n")
    const url = gh([
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      target,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ])
    pull = {url, state: "OPEN", headRefOid: promotionHead}
  }
  if (pull.state !== "OPEN") fail(`${pull.url} is ${pull.state.toLowerCase()}`)

  console.log(`Waiting for ${pull.url}`)
  execFileSync("gh", ["pr", "checks", pull.url, "--repo", repository, "--watch", "--fail-fast"], {stdio: "inherit"})
  const mergeArgs = ["pr", "merge", pull.url, "--repo", repository, "--merge", "--match-head-commit", promotionHead]
  if (mergeBody) mergeArgs.push("--body", mergeBody)
  gh(mergeArgs)
  const merged = ghJson(["pr", "view", pull.url, "--repo", repository, "--json", "state,mergeCommit"])
  if (merged.state !== "MERGED" || !merged.mergeCommit?.oid) fail(`${pull.url} did not merge`)
  requireMergeBody(repository, merged.mergeCommit.oid, mergeBody)
  return merged.mergeCommit.oid
}

function promoteExactHead({repository, source, target, family, mergeBody}) {
  const sourceHead = branchHead(repository, source)
  const targetHead = branchHead(repository, target)
  const compare = ghJson(["api", `repos/${repository}/compare/${targetHead}...${sourceHead}`])
  if (compare.ahead_by === 0) {
    if (!mergeBody || hasMergeBody(repository, targetHead, mergeBody)) {
      console.log(`${repository}:${target} already contains ${sourceHead}`)
      return targetHead
    }

    const marker = createHash("sha256").update(`${targetHead}\n${mergeBody}`).digest("hex").slice(0, 12)
    const branch = `release/promote-${family}-refresh-pin-${marker}`
    let pull = existingPromotionPullRequest(repository, branch, target)
    if (pull?.state === "MERGED") {
      requireMergeBody(repository, pull.mergeCommit.oid, mergeBody)
      return pull.mergeCommit.oid
    }
    const promotionHead = pull?.headRefOid || createMetadataCommit(repository, targetHead, family, mergeBody)
    requireMergeBody(repository, promotionHead, mergeBody)
    const parent = gh(["api", `repos/${repository}/git/commits/${promotionHead}`, "--jq", ".parents[0].sha"])
    if (parent !== targetHead) fail(`${repository}:${promotionHead} is not based on ${targetHead}`)
    return mergePromotionPullRequest({repository, branch, source, target, family, promotionHead, mergeBody, pull})
  }

  const branch = `release/promote-${family}-${source}-to-${target}-${sourceHead.slice(0, 8)}`
  const pull = existingPromotionPullRequest(repository, branch, target)
  return mergePromotionPullRequest({
    repository,
    branch,
    source,
    target,
    family,
    promotionHead: sourceHead,
    mergeBody,
    pull,
  })
}

function findCoordinatedRun(headSha) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runs = ghJson([
      "run",
      "list",
      "--repo",
      MENTRAOS_REPOSITORY,
      "--workflow",
      "coordinated-release.yml",
      "--branch",
      "staging",
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,status,url",
    ])
    const run = runs.find((candidate) => candidate.headSha === headSha)
    if (run) return run
    execFileSync("sleep", ["10"])
  }
  fail(`no coordinated staging run appeared for ${headSha}`)
}

function downloadReleasePlan(runId) {
  const artifacts = ghJson([
    "api",
    `repos/${MENTRAOS_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`,
  ]).artifacts
  const candidates = artifacts.filter(
    (artifact) => !artifact.expired && artifact.name.startsWith("coordinated-release-plan-"),
  )
  if (candidates.length !== 1) {
    fail(`run ${runId} has ${candidates.length} available coordinated release-plan artifacts, expected 1`)
  }

  const directory = mkdtempSync(path.join(tmpdir(), "mentra-release-plan-"))
  try {
    execFileSync(
      "gh",
      [
        "run",
        "download",
        String(runId),
        "--repo",
        MENTRAOS_REPOSITORY,
        "--name",
        candidates[0].name,
        "--dir",
        directory,
      ],
      {stdio: "inherit"},
    )
    return JSON.parse(readFileSync(path.join(directory, "release-plan.json"), "utf8"))
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}

function commitTrailer(repository, commit, key) {
  const message = gh(["api", `repos/${repository}/commits/${commit}`, "--jq", ".commit.message"])
  const prefix = `${key}: `
  const values = message
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
  if (values.length !== 1) fail(`${repository}:${commit} must contain exactly one ${key} trailer`)
  return values[0]
}

function requireSuccessfulBetaRun(runId, currentVersion) {
  if (!/^\d+$/.test(runId || "")) fail("finish requires --run RUN_ID")
  const run = ghJson(["api", `repos/${MENTRAOS_REPOSITORY}/actions/runs/${runId}`])
  if (
    run.path !== ".github/workflows/coordinated-release.yml" ||
    run.event !== "push" ||
    run.head_branch !== "staging" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    fail(`${run.html_url || `run ${runId}`} is not a successful coordinated staging release`)
  }

  const stagingHead = branchHead(MENTRAOS_REPOSITORY, "staging")
  if (run.head_sha !== stagingHead) {
    fail(`${run.html_url} released ${run.head_sha}, but the current staging release cut is ${stagingHead}`)
  }
  const starterKitSource = commitTrailer(MENTRAOS_REPOSITORY, stagingHead, "Starter-Kit-Source")
  if (!/^[0-9a-f]{40}$/.test(starterKitSource)) {
    fail(`${MENTRAOS_REPOSITORY}:${stagingHead} has an invalid Starter-Kit-Source trailer`)
  }

  const plan = downloadReleasePlan(runId)
  const expectedIdentity = `${currentVersion}-beta.${run.run_number}`
  if (
    plan.familyBaseVersion !== currentVersion ||
    plan.channel !== "beta" ||
    plan.sequence !== run.run_number ||
    plan.releaseIdentity !== expectedIdentity ||
    plan.sourceCommit !== stagingHead ||
    plan.starterKitSource?.repository !== STARTER_KIT_REPOSITORY ||
    plan.starterKitSource?.branch !== "staging" ||
    plan.starterKitSource?.sourceCommit !== starterKitSource
  ) {
    fail(`${run.html_url} release plan does not match the current ${currentVersion} beta cut`)
  }
  return {run, plan}
}

function requireDevCheckout() {
  const repository = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
  if (repository !== MENTRAOS_REPOSITORY) fail(`this checkout is ${repository}, expected ${MENTRAOS_REPOSITORY}`)
  const dirty = execFileSync("git", ["status", "--porcelain"], {cwd: rootDir, encoding: "utf8"}).trim()
  if (dirty) fail("release-family promotion requires a clean MentraOS checkout")
  const branch = execFileSync("git", ["branch", "--show-current"], {cwd: rootDir, encoding: "utf8"}).trim()
  if (branch !== "dev") fail(`this checkout is on ${branch || "a detached HEAD"}, expected dev`)
  const head = execFileSync("git", ["rev-parse", "HEAD"], {cwd: rootDir, encoding: "utf8"}).trim()
  const remoteHead = branchHead(MENTRAOS_REPOSITORY, "dev")
  if (head !== remoteHead) fail(`local dev is ${head}, but ${MENTRAOS_REPOSITORY}:dev is ${remoteHead}`)
}

async function confirm(command, currentVersion, nextVersion, yes) {
  if (yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("rerun with --yes after reviewing the release cut")
  console.log(`${command} the ${currentVersion} release cut and prepare ${nextVersion}.`)
  const reader = createInterface({input: process.stdin, output: process.stdout})
  const answer = await reader.question(`Type ${currentVersion} to continue: `)
  reader.close()
  if (answer !== currentVersion) fail("confirmation did not match the current release family")
}

async function main() {
  const {command, options} = parseArgs(process.argv.slice(2))
  if (!command || command === "help" || command === "--help") {
    console.log(usage())
    return
  }
  if (!new Set(["start", "finish"]).has(command)) fail(`unknown command ${command}`)

  const currentVersion = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version
  const nextVersion = requireNextVersion(currentVersion, options.next)
  requireDevCheckout()
  await confirm(command, currentVersion, nextVersion, options.yes)

  if (command === "start") {
    const starterKitStagingHead = promoteExactHead({
      repository: STARTER_KIT_REPOSITORY,
      source: "dev",
      target: "staging",
      family: currentVersion,
    })
    const mentraosStagingHead = promoteExactHead({
      repository: MENTRAOS_REPOSITORY,
      source: "dev",
      target: "staging",
      family: currentVersion,
      mergeBody: `Starter-Kit-Source: ${starterKitStagingHead}`,
    })
    const run = findCoordinatedRun(mentraosStagingHead)
    console.log(`Beta release started: ${run.url}`)
    console.log(
      `After it succeeds: bun run release:promote-family -- finish --next ${nextVersion} --run ${run.databaseId}`,
    )
    return
  }

  requireSuccessfulBetaRun(options.run, currentVersion)
  promoteExactHead({
    repository: STARTER_KIT_REPOSITORY,
    source: "staging",
    target: "dev",
    family: currentVersion,
  })
  execFileSync("bun", [path.join(rootDir, "scripts/prepare-next-release-family.mjs"), nextVersion], {
    cwd: rootDir,
    stdio: "inherit",
  })
  console.log(`Starter Kit history is reconciled and this checkout is ready for the ${nextVersion} preparation PR.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
