#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {productionBuildFloor, reserveNativeBuilds, validateNativeReservation} from "./native-build-numbers.mjs"

const LEDGER_BRANCH = "mentra-native-build-ledger"
const LEDGER_PATH = "native-builds.json"

// Each update creates a child of the observed ledger commit. GitHub's
// non-force ref update rejects concurrent siblings, so only one reservation
// wins and the loser rereads before allocating. No workflow-level lock can
// drop another branch's pending allocation, and retries keep their numbers.
export async function reserveOnGitHub({repository, token, request, dryRun = false, fetchImpl = fetch}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("Invalid GitHub repository")
  if (!token) throw new Error("GH_TOKEN is required for the native build ledger")
  async function api(endpoint, method = "GET", body) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${endpoint}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    })
    if (response.status === 404 && method === "GET" && endpoint.startsWith("git/ref/")) return null
    if (!response.ok) {
      const error = new Error(`Native build ledger ${method} ${endpoint} failed (${response.status})`)
      error.status = response.status
      throw error
    }
    return response.json()
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const ref = await api(`git/ref/heads/${LEDGER_BRANCH}`)
    let state = {schemaVersion: 1, reservations: []}
    if (ref) {
      const commit = await api(`git/commits/${ref.object.sha}`)
      const tree = await api(`git/trees/${commit.tree.sha}`)
      const file = tree.tree.find((entry) => entry.path === LEDGER_PATH && entry.type === "blob")
      if (!file) throw new Error("Existing native build ledger has no state file; refusing to reset it")
      const blob = await api(`git/blobs/${file.sha}`)
      state = JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"))
    }
    const result = reserveNativeBuilds(state, request)
    if (result.reused || dryRun) return result.reservation
    const tree = await api("git/trees", "POST", {
      tree: [{path: LEDGER_PATH, mode: "100644", type: "blob", content: `${JSON.stringify(result.state)}\n`}],
    })
    const commit = await api("git/commits", "POST", {
      message: `Reserve native builds for ${request.key}`,
      tree: tree.sha,
      parents: ref ? [ref.object.sha] : [],
    })
    try {
      if (ref) await api(`git/refs/heads/${LEDGER_BRANCH}`, "PATCH", {sha: commit.sha, force: false})
      else await api("git/refs", "POST", {ref: `refs/heads/${LEDGER_BRANCH}`, sha: commit.sha})
      return result.reservation
    } catch (error) {
      if (![409, 422].includes(error.status)) throw error
      // A competing allocator may have won. Re-read and recompute; never force.
    }
  }
  throw new Error("Native build ledger remained busy; retry this run without changing its reservation key")
}

async function main() {
  const args = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith("--") || process.argv[i + 1] === undefined)
      throw new Error("Expected --name value pairs")
    args[process.argv[i].slice(2)] = process.argv[i + 1]
  }
  const beta = args["beta-plan"] ? JSON.parse(readFileSync(args["beta-plan"], "utf8")) : null
  const baseVersion = beta?.familyBaseVersion || JSON.parse(readFileSync("package.json", "utf8")).version
  if (args["dry-run"] === "true" && args["restored-plan"]) {
    const plan = JSON.parse(readFileSync(args["restored-plan"], "utf8"))
    const reservation = validateNativeReservation(plan.native.reservation, {
      baseVersion,
      sourceCommit: args["source-commit"],
      count: Number(args.count || 1),
    })
    if (reservation.key !== args.key) throw new Error("Dry-run retry changed its reservation key")
    writeFileSync(args.output, `${JSON.stringify(reservation, null, 2)}\n`)
    return
  }
  const floor = args.inventory
    ? productionBuildFloor({
        inventory: JSON.parse(readFileSync(args.inventory, "utf8")),
        betaBuildNumber: beta.native.buildNumber,
        baseVersion,
        includeCompatibilityLab: Number(args.count || 1) === 2,
      })
    : 0
  const reservation = await reserveOnGitHub({
    repository: args.repository,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    dryRun: args["dry-run"] === "true",
    request: {
      key: args.key,
      baseVersion,
      sourceCommit: args["source-commit"],
      count: Number(args.count || 1),
      minimumSequence: Number(args["minimum-sequence"] || 1),
      minimumBuildNumber: floor,
    },
  })
  writeFileSync(args.output, `${JSON.stringify(reservation, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
