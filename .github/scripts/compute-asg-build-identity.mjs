#!/usr/bin/env node
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {mkdirSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const BUILD_INPUT_PATHS = [
  "asg_client",
  ".github/scripts/compute-asg-build-identity.mjs",
  ".github/scripts/build-coordinated-asg.sh",
]
const EXCLUDED_PREFIXES = ["asg_client/ota_manifests/"]
const BUILD_CONTRACT = {androidBuildVariant: "release", javaVersion: "17"}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function computeAsgBuildFingerprint({entries, latestInputCommitTimestamp, contract = BUILD_CONTRACT}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("ASG build inputs must not be empty")
  if (!Number.isSafeInteger(latestInputCommitTimestamp) || latestInputCommitTimestamp <= 0) {
    throw new Error("latestInputCommitTimestamp must be a positive integer")
  }
  const normalizedEntries = entries
    .map(({mode, object, path: entryPath}) => {
      if (!/^\d{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/.test(object) || !entryPath) {
        throw new Error(`Invalid ASG build input entry: ${JSON.stringify({mode, object, path: entryPath})}`)
      }
      return {mode, object, path: entryPath}
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const payload = canonicalize({schemaVersion: 1, contract, entries: normalizedEntries})
  const fingerprint = createHash("sha256")
    .update(`${JSON.stringify(payload)}\n`)
    .digest("hex")
  return {
    schemaVersion: 1,
    fingerprint,
    latestInputCommitTimestamp,
    contract,
    entries: normalizedEntries,
  }
}

export function finalizeAsgBuildIdentity({buildFingerprint, versionCode}) {
  const {fingerprint} = buildFingerprint
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid ASG build fingerprint")
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || versionCode > 2_100_000_000) {
    throw new Error(`Allocated ASG versionCode ${versionCode} is outside the Android-safe range`)
  }
  const versionName = `asg.${versionCode}.${fingerprint.slice(0, 12)}`
  return {
    ...buildFingerprint,
    versionCode,
    versionName,
    apkAsset: `mentra-live-asg-${versionCode}-${fingerprint}.apk`,
    provenanceAsset: `mentra-live-asg-${versionCode}-${fingerprint}.json`,
  }
}

export function computeAsgBuildIdentity({entries, latestInputCommitTimestamp, versionCode, contract = BUILD_CONTRACT}) {
  return finalizeAsgBuildIdentity({
    buildFingerprint: computeAsgBuildFingerprint({entries, latestInputCommitTimestamp, contract}),
    versionCode,
  })
}

function git(repoRoot, args) {
  return execFileSync("git", args, {cwd: repoRoot, encoding: "utf8"}).trim()
}

export function computeAsgBuildFingerprintFromGit({repoRoot, sourceCommit}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("sourceCommit must be a full lowercase Git SHA")
  const tree = git(repoRoot, ["ls-tree", "-r", sourceCommit, "--", ...BUILD_INPUT_PATHS])
  const entries = tree
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{6})\s+\S+\s+([0-9a-f]+)\t(.+)$/.exec(line)
      if (!match) throw new Error(`Unexpected git ls-tree row: ${line}`)
      return {mode: match[1], object: match[2], path: match[3]}
    })
    .filter((entry) => !EXCLUDED_PREFIXES.some((prefix) => entry.path.startsWith(prefix)))
  const latestInputCommitTimestamp = Number(
    git(repoRoot, [
      "log",
      "-1",
      "--format=%ct",
      sourceCommit,
      "--",
      ...BUILD_INPUT_PATHS,
      ...EXCLUDED_PREFIXES.map((prefix) => `:(exclude)${prefix}**`),
    ]),
  )
  return computeAsgBuildFingerprint({entries, latestInputCommitTimestamp})
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
  const sourceCommit = args["source-commit"] || git(repoRoot, ["rev-parse", "HEAD"])
  const output = path.resolve(repoRoot, args.output || "asg-build-identity.json")
  const buildFingerprint = computeAsgBuildFingerprintFromGit({repoRoot, sourceCommit})
  const identity = args["version-code"]
    ? finalizeAsgBuildIdentity({buildFingerprint, versionCode: Number(args["version-code"])})
    : buildFingerprint
  mkdirSync(path.dirname(output), {recursive: true})
  writeFileSync(output, `${JSON.stringify(identity, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `fingerprint=${identity.fingerprint}`,
      `version_code=${identity.versionCode ?? ""}`,
      `version_name=${identity.versionName ?? ""}`,
      `apk_asset=${identity.apkAsset ?? ""}`,
      `provenance_asset=${identity.provenanceAsset ?? ""}`,
    ]
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {flag: "a"})
  }
  console.log(
    identity.versionName
      ? `Wrote ASG build identity ${identity.versionName} to ${output}`
      : `Wrote ASG build fingerprint ${identity.fingerprint} to ${output}`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
