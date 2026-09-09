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

export function findReleaseAsset(repository, releaseId, name, run = gh) {
  // Filter inside gh so a growing release cannot overflow Node's output buffer.
  // Keep all matching assets across pages so duplicate detection still fails closed.
  const output = run(
    [
      "api",
      "--paginate",
      `repos/${repository}/releases/${releaseId}/assets?per_page=100`,
      "--jq",
      `.[] | select(.name == ${JSON.stringify(name)}) | {id, name} | tojson`,
    ],
    {encoding: "utf8"},
  )
  const assets = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return matchingAsset(assets, name)
}

// Sends the whole asset as a Buffer, so the request always carries an exact
// Content-Length rather than depending on how the installed `gh` build streams
// `--input`, and reports the status and body when GitHub refuses.
//
// uploads.github.com answers a refused upload with an HTML "Whoa there!" page
// instead of a JSON API error, so without that reporting the only signal is an
// exit code. The ~110 MB Mentra Live APK uploaded in 10.7s on 2026-09-04 and
// has since taken ~4 minutes before returning HTTP 400 from the same host, so
// the remaining failure is the runner's upload path, not this request: a small
// asset still uploads to the same release and token in under a second.
export async function uploadReleaseAsset({repository, releaseId, name, body, token, fetchImpl = fetch}) {
  if (!token) throw new Error("GH_TOKEN is required to upload a release asset")
  const response = await fetchImpl(releaseAssetUploadUrl(repository, releaseId, name), {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "content-length": String(body.byteLength),
      "content-type": "application/octet-stream",
      "x-github-api-version": "2022-11-28",
    },
    body,
  })
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300)
    throw new Error(`Uploading ${name} failed with HTTP ${response.status}: ${detail}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = path.resolve(args.file)
  const name = args.name
  const releaseId = args["release-id"]
  const repository = args.repository
  if (!file || !name || !releaseId || !repository) {
    throw new Error("--file, --name, --release-id, and --repository are required")
  }
  if (path.basename(file) !== name) throw new Error("Immutable asset name must equal the source file basename")
  const existing = findReleaseAsset(repository, releaseId, name)
  if (!existing) {
    await uploadReleaseAsset({
      repository,
      releaseId,
      name,
      body: readFileSync(file),
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    })
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
