#!/usr/bin/env node
import {execFile, execFileSync} from "node:child_process"
import {readFileSync, statSync} from "node:fs"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
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
      `.[] | select(.name == ${JSON.stringify(name)}) | {id, name, state, size} | tojson`,
    ],
    {encoding: "utf8"},
  )
  const assets = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return matchingAsset(assets, name)
}

export function runCurl(args, token) {
  return new Promise((resolve, reject) => {
    const child = execFile("curl", args, {maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
      if (error) {
        // Do not include the command or credentials in diagnostics.
        const failure = new Error(`curl exited with code ${error.code}: ${stderr.trim().slice(0, 300)}`)
        failure.retryable = [5, 6, 7, 18, 28, 35, 52, 55, 56].includes(error.code)
        reject(failure)
      } else {
        resolve(stdout)
      }
    })
    // Keep the credential out of process arguments and error.cmd.
    child.stdin.on("error", () => {}) // An early curl exit is reported by the callback.
    child.stdin.end(`Authorization: Bearer ${token}\n`)
  })
}

// Node fetch/Octokit abandon these large uploads at Undici's 300s headers
// timeout, even with a longer AbortSignal timeout. curl streams the file with
// an exact Content-Length and a bounded 15-minute deadline, without that cap.
// Never blindly retry a POST: the publisher reconciles remote state first.
export async function uploadReleaseAsset({repository, releaseId, name, file, token, run = runCurl}) {
  if (!token) throw new Error("GH_TOKEN is required to upload a release asset")
  const output = await run(
    [
      "--disable",
      "--silent",
      "--show-error",
      "--http1.1",
      "--connect-timeout",
      "30",
      "--max-time",
      "900",
      "--request",
      "POST",
      "--upload-file",
      file,
      "--header",
      "@-",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      `Content-Length: ${statSync(file).size}`,
      "--header",
      "Content-Type: application/octet-stream",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      "--write-out",
      "\n%{http_code}",
      releaseAssetUploadUrl(repository, releaseId, name),
    ],
    token,
  )
  const separator = output.lastIndexOf("\n")
  const status = Number(output.slice(separator + 1))
  if (status !== 201) {
    const detail = output.slice(0, separator).replace(/\s+/g, " ").trim().slice(0, 300)
    const error = new Error(`Uploading ${name} failed with HTTP ${status}: ${detail}`)
    // 422 can mean another attempt completed while we were uploading.
    error.retryable = [408, 422, 429].includes(status) || status >= 500
    throw error
  }
}

export async function publishImmutableReleaseAsset({
  file,
  name,
  releaseId,
  repository,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  run = gh,
  upload = uploadReleaseAsset,
  sleepImpl = sleep,
}) {
  if (!file || !name || !releaseId || !repository) {
    throw new Error("--file, --name, --release-id, and --repository are required")
  }
  file = path.resolve(file)
  if (path.basename(file) !== name) throw new Error("Immutable asset name must equal the source file basename")
  statSync(file) // Fail before touching remote state if the source is missing.
  let lastError
  const attempts = 3
  for (let attempt = 1; attempt <= attempts + 1; attempt += 1) {
    const existing = findReleaseAsset(repository, releaseId, name, run)
    if (existing) {
      if (existing.state === "starter" && existing.size === 0) {
        // GitHub can leave an empty placeholder after an interrupted upload.
        // Completed assets are never deleted or overwritten by this publisher.
        if (attempt <= attempts) {
          run(["api", "--method", "DELETE", `repos/${repository}/releases/assets/${existing.id}`])
        }
      } else {
        if (existing.state !== "uploaded")
          throw new Error(`Unexpected state for release asset ${name}: ${existing.state}`)
        const downloaded = run(
          ["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${existing.id}`],
          {encoding: null, maxBuffer: 1024 * 1024 * 1024},
        )
        if (!readFileSync(file).equals(downloaded)) {
          throw new Error(`Refusing to overwrite immutable release asset ${name} with different bytes`)
        }
        console.log(`Verified existing immutable release asset ${name}`)
        return
      }
    }
    // Reconcile once more after the final failure: GitHub may have accepted
    // the bytes even if its response never reached the runner.
    if (attempt > attempts) throw lastError
    try {
      console.log(`Uploading ${name} (attempt ${attempt}/${attempts})`)
      await upload({repository, releaseId, name, file, token})
      console.log(`Published immutable release asset ${name}`)
      return
    } catch (error) {
      if (!error.retryable) throw error
      lastError = error
      console.warn(`Upload attempt ${attempt}/${attempts} failed: ${error.message}`)
      await sleepImpl(10_000)
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await publishImmutableReleaseAsset({
    file: args.file,
    name: args.name,
    releaseId: args["release-id"],
    repository: args.repository,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
