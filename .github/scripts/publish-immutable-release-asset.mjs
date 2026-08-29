#!/usr/bin/env node
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

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

function gh(args, options = {}) {
  return execFileSync("gh", args, {stdio: ["ignore", "pipe", "inherit"], ...options})
}

export function matchingAsset(assets, name) {
  const matches = assets.filter((asset) => asset.name === name)
  if (matches.length > 1) throw new Error(`Release contains duplicate asset ${name}`)
  return matches[0] || null
}

export function releaseAssetUploadUrl(repository, releaseId, name) {
  return `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = path.resolve(args.file)
  const name = args.name
  const releaseId = args["release-id"]
  const repository = args.repository
  if (!file || !name || !releaseId || !repository) {
    throw new Error("--file, --name, --release-id, and --repository are required")
  }
  if (path.basename(file) !== name) throw new Error("Immutable asset name must equal the source file basename")
  const pages = JSON.parse(
    gh(["api", "--paginate", "--slurp", `repos/${repository}/releases/${releaseId}/assets?per_page=100`], {
      encoding: "utf8",
    }),
  )
  const assets = pages.flat()
  const existing = matchingAsset(assets, name)
  if (!existing) {
    gh(
      [
        "api",
        "--method",
        "POST",
        "-H",
        "Content-Type: application/octet-stream",
        "--input",
        file,
        releaseAssetUploadUrl(repository, releaseId, name),
      ],
      {stdio: "inherit"},
    )
    console.log(`Published immutable release asset ${name}`)
  } else {
    const downloaded = gh(
      ["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${existing.id}`],
      {encoding: null, maxBuffer: 1024 * 1024 * 1024},
    )
    if (!readFileSync(file).equals(downloaded)) {
      throw new Error(`Refusing to overwrite immutable release asset ${name} with different bytes`)
    }
    console.log(`Verified existing immutable release asset ${name}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
