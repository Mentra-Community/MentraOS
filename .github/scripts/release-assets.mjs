#!/usr/bin/env node
import {mkdtemp, rm} from "node:fs/promises"
import {createReadStream, existsSync} from "node:fs"
import {pipeline} from "node:stream/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {
  artifactBaseUrl,
  artifactUrl,
  createR2Store,
  downloadAsset,
  gh,
  listReleaseAssets,
  resolveRelease,
  updateIndex,
} from "./release-artifact-storage.mjs"

export function parseArgs(argv) {
  const result = {patterns: []}
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]
    if (option === "--clobber") {
      result.clobber = true
      continue
    }
    if (!option.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Expected option/value: ${option}`)
    const value = argv[++index]
    if (option === "--pattern") result.patterns.push(value)
    else result[option === "--repo" ? "repository" : option.slice(2)] = value
  }
  return result
}

export function matchesPattern(name, pattern) {
  const expression = pattern
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("")
  return new RegExp(`^${expression}$`).test(name)
}

export async function removeAsset(repository, id, store) {
  if (!String(id).startsWith("r2:")) {
    if (!/^\d+$/.test(String(id))) throw new Error("Invalid GitHub asset ID")
    gh(["api", "--method", "DELETE", `repos/${repository}/releases/assets/${id}`])
    return
  }
  const key = id.slice(3)
  const parts = key.split("/")
  if (parts.length !== 5 || `${parts[0]}/${parts[1]}` !== repository || parts[2] !== "releases")
    throw new Error("Invalid R2 asset ID")
  artifactUrl(repository, parts[3], parts[4])
  store ||= await createR2Store()
  await store.remove(key)
  await updateIndex(store, repository, parts[3], (assets) => assets.filter((asset) => asset.id !== id))
}

async function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  const repository = args.repository || process.env.GITHUB_REPOSITORY
  if (command === "fetch") {
    const directory = await mkdtemp(path.join(tmpdir(), "mentra-artifact-"))
    try {
      const file = path.join(directory, "asset")
      await downloadAsset(repository, {id: args["asset-id"]}, file)
      await pipeline(createReadStream(file), process.stdout)
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
    return
  }
  if (command === "remove") return removeAsset(repository, args["asset-id"])
  if (command === "url" && args.existing !== "true") {
    console.log(args.name ? artifactUrl(repository, args.tag, args.name) : artifactBaseUrl(repository, args.tag))
    return
  }
  const release = resolveRelease(repository, {releaseId: args["release-id"], tag: args.tag})
  const assets = await listReleaseAssets(repository, release)
  if (command === "list") {
    console.log(JSON.stringify(assets))
    return
  }
  if (command === "url") {
    // Preserve the exact URL of historical records, including frozen production
    // selections, even if the same bytes have subsequently been mirrored to R2.
    const legacy = JSON.parse(
      gh(["api", "--paginate", "--slurp", `repos/${repository}/releases/${release.id}/assets?per_page=100`]),
    )
      .flat()
      .filter((a) => a.name === args.name && a.state === "uploaded")
    if (legacy.length === 1) {
      console.log(legacy[0].browser_download_url)
      return
    }
    if (legacy.length > 1) throw new Error(`Duplicate legacy artifact ${args.name}`)
    const matches = assets.filter((a) => a.name === args.name)
    if (matches.length !== 1) throw new Error(`Expected one existing artifact ${args.name}; found ${matches.length}`)
    console.log(matches[0].browser_download_url)
    return
  }
  if (command === "download") {
    if (!args.patterns.length) throw new Error("At least one --pattern is required")
    const selected = new Map()
    for (const pattern of args.patterns) {
      const matches = assets.filter((asset) => matchesPattern(asset.name, pattern))
      if (!matches.length) throw new Error(`No artifacts matched ${pattern}`)
      for (const asset of matches) {
        if (selected.has(asset.name) && selected.get(asset.name).id !== asset.id)
          throw new Error(`Duplicate artifact ${asset.name}`)
        selected.set(asset.name, asset)
      }
    }
    for (const asset of selected.values()) {
      if (path.basename(asset.name) !== asset.name) throw new Error("Invalid artifact filename")
      const file = path.join(args.dir || ".", asset.name)
      if (!args.clobber && existsSync(file))
        throw new Error(`Artifact destination exists: ${file}; use --clobber to replace it`)
      await downloadAsset(repository, asset, file)
    }
    return
  }
  if (command === "sweep") {
    const days = Number(args.days)
    if (!Number.isFinite(days) || days < 1 || !["pr-builds", "oem-app-builds"].includes(release.tag_name))
      throw new Error("Sweep only supports rolling PR/OEM builds")
    const cutoff = Date.now() - days * 86400000
    for (const asset of assets) {
      if (!String(asset.id).startsWith("r2:") && Date.parse(asset.created_at) < cutoff)
        await removeAsset(repository, asset.id)
    }
    // R2 lifecycle rules expire rolling objects using their current modification
    // time. Do not delete by stale index entries: a concurrent rerun may have
    // atomically replaced the same key since this sweep listed it.
    if (assets.some((asset) => String(asset.id).startsWith("r2:") && Date.parse(asset.created_at) < cutoff)) {
      await updateIndex(await createR2Store(), repository, release.tag_name, (current) =>
        current.filter((asset) => Date.parse(asset.created_at) >= cutoff),
      )
    }
    return
  }
  throw new Error(`Unknown artifact command ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
