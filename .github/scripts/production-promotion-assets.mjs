#!/usr/bin/env node
import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {requirePublicHttpsUrl} from "./release-family.mjs"
import {promotionAssetName, validatePromotionChain, validatePromotionRecord} from "./production-promotion-state.mjs"

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const EVIDENCE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,79}$/
const ASSET_PREFIX_PATTERN = /^[a-z0-9][a-z0-9.-]{0,119}$/

function gh(args, options = {}) {
  const stdin = options.input === undefined ? "ignore" : "pipe"
  return execFileSync("gh", args, {stdio: [stdin, "pipe", "inherit"], encoding: "utf8", ...options})
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
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`)
  if (githubOutput) {
    const lines = Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
    appendFileSync(path.resolve(githubOutput), `${lines}\n`)
  }
}

export function promotionContainerTag(releaseIdentity, attempt) {
  if (!VERSION_PATTERN.test(releaseIdentity || "")) throw new Error("release identity must be X.Y.Z")
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer")
  return `mentra-production-promotion-v${releaseIdentity}-attempt-${attempt}`
}

export function promotionContainerName(releaseIdentity, attempt) {
  promotionContainerTag(releaseIdentity, attempt)
  return `Mentra ${releaseIdentity} production promotion attempt ${attempt}`
}

export function prepareEvidenceAsset({file, kind, url, outputDirectory, assetPrefix}) {
  if (!EVIDENCE_KIND_PATTERN.test(kind || "")) throw new Error("evidence kind has an unsupported shape")
  requirePublicHttpsUrl(url, "evidence URL")
  const source = path.resolve(file)
  const bytes = readFileSync(source)
  try {
    JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("production promotion evidence must be JSON")
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const prefix = assetPrefix || `production-evidence-${kind}`
  if (!ASSET_PREFIX_PATTERN.test(prefix)) throw new Error("evidence asset prefix has an unsupported shape")
  const assetName = `${prefix}-${sha256}.json`
  const directory = path.resolve(outputDirectory || path.dirname(source))
  mkdirSync(directory, {recursive: true})
  const assetPath = path.join(directory, assetName)
  if (assetPath !== source) copyFileSync(source, assetPath)
  return {
    assetPath,
    assetName,
    reference: {
      kind,
      url,
      sha256,
      assetName,
    },
  }
}

export function parsePromotionContainer(release) {
  const match =
    /^mentra-production-promotion-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-attempt-([1-9]\d*)$/.exec(
      release?.tag_name || "",
    )
  if (!match) return null
  return {releaseIdentity: match[1], attempt: Number(match[2]), release}
}

export function matchingPromotionContainers(releases, releaseIdentity) {
  return releases
    .map(parsePromotionContainer)
    .filter((entry) => entry?.releaseIdentity === releaseIdentity)
    .sort((left, right) => left.attempt - right.attempt)
}

export function nextPromotionAttempt(releases, releaseIdentity) {
  const matches = matchingPromotionContainers(releases, releaseIdentity)
  return matches.length === 0 ? 1 : matches.at(-1).attempt + 1
}

export function requirePromotionContainer(releases, releaseIdentity, attempt) {
  const tag = promotionContainerTag(releaseIdentity, attempt)
  const matches = releases.filter((release) => release.tag_name === tag)
  if (matches.length !== 1) throw new Error(`Expected exactly one promotion container ${tag}, found ${matches.length}`)
  const release = matches[0]
  if (
    release.draft !== true ||
    release.prerelease !== false ||
    release.name !== promotionContainerName(releaseIdentity, attempt)
  ) {
    throw new Error(`Promotion container ${tag} has unexpected release settings`)
  }
  return release
}

export function requireNewPromotionAttemptAllowed(records, releaseIdentity) {
  for (const record of records) {
    validatePromotionRecord(record)
    if (record.releaseIdentity !== releaseIdentity) {
      throw new Error(`Prior promotion record belongs to ${record.releaseIdentity}, expected ${releaseIdentity}`)
    }
    if (record.state !== "aborted") {
      throw new Error(
        `Cannot start another ${releaseIdentity} promotion while attempt ${record.attempt} is ${record.state}`,
      )
    }
  }
}

export function stateAssets(assets, releaseIdentity, attempt) {
  const pattern = new RegExp(
    `^production-promotion-${releaseIdentity.replaceAll(".", "\\.")}-attempt-${attempt}-(\\d{2,})-([a-z-]+)\\.json$`,
  )
  const seen = new Set()
  const matches = []
  for (const asset of assets) {
    const match = pattern.exec(asset.name)
    if (!match) continue
    const sequence = Number(match[1])
    if (seen.has(sequence)) throw new Error(`Promotion container has duplicate state sequence ${sequence}`)
    seen.add(sequence)
    matches.push({sequence, state: match[2], asset})
  }
  return matches.sort((left, right) => left.sequence - right.sequence)
}

export function validateStateRecordChain(entries, releaseIdentity, attempt) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Promotion has no state record")
  let previous = null
  for (const [index, entry] of entries.entries()) {
    const record = validatePromotionRecord(entry.record)
    if (entry.sequence !== index || record.sequence !== index) {
      throw new Error(`Promotion state chain is not contiguous at sequence ${index}`)
    }
    if (record.releaseIdentity !== releaseIdentity || record.attempt !== attempt) {
      throw new Error(`Promotion state ${index} belongs to another promotion`)
    }
    if (promotionAssetName(record) !== entry.asset.name || record.state !== entry.state) {
      throw new Error(`Promotion state ${index} does not match its immutable asset name`)
    }
    if (previous) validatePromotionChain(previous, record)
    previous = record
  }
  return previous
}

function listReleases(repository) {
  return JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`])).flat()
}

function listAssets(repository, releaseId) {
  return JSON.parse(
    gh(["api", "--paginate", "--slurp", `repos/${repository}/releases/${releaseId}/assets?per_page=100`]),
  ).flat()
}

function resolveContainer(repository, releaseIdentity, attempt) {
  return requirePromotionContainer(listReleases(repository), releaseIdentity, attempt)
}

function createContainer({repository, releaseIdentity, targetCommit}) {
  const releases = listReleases(repository)
  const priorRecords = matchingPromotionContainers(releases, releaseIdentity)
    .map(({attempt, release}) => loadPromotionState({repository, releaseIdentity, attempt, release})?.record)
    .filter(Boolean)
  requireNewPromotionAttemptAllowed(priorRecords, releaseIdentity)
  const attempt = nextPromotionAttempt(releases, releaseIdentity)
  const tag = promotionContainerTag(releaseIdentity, attempt)
  const name = promotionContainerName(releaseIdentity, attempt)
  const payload = JSON.stringify({
    tag_name: tag,
    target_commitish: targetCommit,
    name,
    body: "Append-only evidence for an in-progress Mentra production promotion. This draft is not a customer release.",
    draft: true,
    prerelease: false,
  })
  const release = JSON.parse(
    gh(["api", "--method", "POST", `repos/${repository}/releases`, "--input", "-"], {input: payload}),
  )
  requirePromotionContainer([...releases, release], releaseIdentity, attempt)
  return {release, attempt}
}

function loadPromotionState({repository, releaseIdentity, attempt, release}) {
  const states = stateAssets(listAssets(repository, release.id), releaseIdentity, attempt)
  if (states.length === 0) return null
  const entries = states.map((state) => {
    const bytes = gh(
      ["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${state.asset.id}`],
      {encoding: null, maxBuffer: 20 * 1024 * 1024},
    )
    return {...state, bytes, record: JSON.parse(bytes.toString("utf8"))}
  })
  const record = validateStateRecordChain(entries, releaseIdentity, attempt)
  const latest = entries.at(-1)
  return {release, latest, record}
}

function downloadLatest({repository, releaseIdentity, attempt, outputFile}) {
  const release = resolveContainer(repository, releaseIdentity, attempt)
  const loaded = loadPromotionState({repository, releaseIdentity, attempt, release})
  if (!loaded) throw new Error(`Promotion ${releaseIdentity} attempt ${attempt} has no state record`)
  const {latest, record} = loaded
  mkdirSync(path.dirname(outputFile), {recursive: true})
  writeFileSync(outputFile, latest.bytes)
  return {release, latest, record}
}

function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  if (command === "create-container") {
    const result = createContainer({
      repository: args.repository,
      releaseIdentity: args.release,
      targetCommit: args["target-commit"],
    })
    output(
      {
        release_id: result.release.id,
        release_identity: args.release,
        attempt: result.attempt,
        tag: result.release.tag_name,
      },
      args["github-output"],
    )
    return
  }
  if (command === "resolve") {
    const release = resolveContainer(args.repository, args.release, Number(args.attempt))
    output({release_id: release.id, tag: release.tag_name}, args["github-output"])
    return
  }
  if (command === "download-latest") {
    const result = downloadLatest({
      repository: args.repository,
      releaseIdentity: args.release,
      attempt: Number(args.attempt),
      outputFile: path.resolve(args.output),
    })
    output(
      {
        release_id: result.release.id,
        tag: result.release.tag_name,
        asset_id: result.latest.asset.id,
        asset_name: result.latest.asset.name,
        state: result.record.state,
        sequence: result.record.sequence,
      },
      args["github-output"],
    )
    return
  }
  if (command === "prepare-evidence") {
    const result = prepareEvidenceAsset({
      file: args.file,
      kind: args.kind,
      url: args.url,
      outputDirectory: args["output-directory"],
      assetPrefix: args["asset-prefix"],
    })
    writeFileSync(path.resolve(args.output), `${JSON.stringify(result.reference, null, 2)}\n`)
    output(
      {asset_path: result.assetPath, asset_name: result.assetName, sha256: result.reference.sha256},
      args["github-output"],
    )
    return
  }
  if (command === "publish-record") {
    const recordPath = path.resolve(args.record)
    const record = validatePromotionRecord(JSON.parse(readFileSync(recordPath, "utf8")))
    const expectedName = promotionAssetName(record)
    if (path.basename(recordPath) !== expectedName) throw new Error(`Record file must be named ${expectedName}`)
    execFileSync(
      process.execPath,
      [
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "publish-immutable-release-asset.mjs"),
        "--file",
        recordPath,
        "--name",
        expectedName,
        "--release-id",
        args["release-id"],
        "--repository",
        args.repository,
      ],
      {stdio: "inherit"},
    )
    return
  }
  throw new Error(`Unknown production promotion asset command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
