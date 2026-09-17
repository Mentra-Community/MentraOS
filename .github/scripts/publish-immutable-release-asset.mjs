#!/usr/bin/env node
import {execFileSync, spawn} from "node:child_process"
import {createHash} from "node:crypto"
import {createReadStream, statSync} from "node:fs"
import {request} from "node:https"
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

// Stream with backpressure and an explicit length. Native HTTPS avoids fetch's
// implicit 300s headers deadline; these limits separately bound connection,
// inactivity (including waiting for a response), and the entire transfer.
export async function uploadReleaseAsset({
  repository,
  releaseId,
  name,
  file,
  token,
  requestImpl = request,
  connectTimeoutMs = 30_000,
  idleTimeoutMs = 120_000,
  totalTimeoutMs = 15 * 60_000,
  log = console.log,
}) {
  if (!token) throw new Error("GH_TOKEN is required to upload a release asset")
  const size = statSync(file).size
  const started = Date.now()
  await new Promise((resolve, reject) => {
    const source = createReadStream(file)
    let connectTimer,
      totalTimer,
      progressTimer,
      response,
      settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(totalTimer)
      clearInterval(progressTimer)
      source.destroy()
      response?.destroy()
      req.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timeout = (phase) =>
      finish(
        Object.assign(
          new Error(
            `Uploading ${name} timed out (${phase}) after ${Math.round((Date.now() - started) / 1000)}s; ` +
              `read ${source.bytesRead}/${size} bytes from disk`,
          ),
          {code: "ETIMEDOUT"},
        ),
      )
    const req = requestImpl(
      releaseAssetUploadUrl(repository, releaseId, name),
      {
        method: "POST",
        agent: false,
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${token}`,
          "content-length": String(size),
          "content-type": "application/octet-stream",
          "user-agent": "mentra-release-publisher",
          "x-github-api-version": "2022-11-28",
        },
      },
      (incoming) => {
        response = incoming
        clearTimeout(connectTimer)
        let detail = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          detail = (detail + chunk).slice(0, 1024)
        })
        response.on("error", finish)
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) return finish()
          const status = response.statusCode
          const retryAfter = response.headers["retry-after"]
          let retryAfterMs = retryAfter
            ? /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now()
            : undefined
          const rateLimited = response.headers["x-ratelimit-remaining"] === "0"
          if (rateLimited && response.headers["x-ratelimit-reset"]) {
            retryAfterMs = Math.max(
              retryAfterMs || 0,
              Number(response.headers["x-ratelimit-reset"]) * 1000 - Date.now(),
            )
          }
          finish(
            Object.assign(
              new Error(
                `Uploading ${name} failed with HTTP ${status}: ${detail.replace(/\s+/g, " ").trim().slice(0, 300)}`,
              ),
              {status, retryAfterMs, rateLimited},
            ),
          )
        })
      },
    )
    req.on("error", finish)
    source.on("error", finish)
    req.on("socket", (socket) => socket.once("secureConnect", () => clearTimeout(connectTimer)))
    req.setTimeout(idleTimeoutMs, () => timeout("no network activity"))
    connectTimer = setTimeout(() => timeout("connection"), connectTimeoutMs)
    totalTimer = setTimeout(() => timeout("total transfer deadline"), totalTimeoutMs)
    progressTimer = setInterval(
      () => log(`Uploading ${name}: read ${source.bytesRead}/${size} bytes from disk`),
      30_000,
    )
    source.pipe(req)
  })
  log(`Uploaded ${name} (${size} bytes) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

async function hashStream(stream) {
  const hash = createHash("sha256")
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

export async function verifyReleaseAsset({repository, file, asset, spawnImpl = spawn}) {
  const mismatch = () => new Error(`Refusing to overwrite immutable release asset ${asset.name} with different bytes`)
  if (asset.size !== statSync(file).size) throw mismatch()
  const expected = await hashStream(createReadStream(file))
  // Stream verification too: the OTA bundle can be much larger than the APK.
  const download = spawnImpl(
    "gh",
    ["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${asset.id}`],
    {stdio: ["ignore", "pipe", "inherit"], timeout: 15 * 60_000},
  )
  const completed = new Promise((resolve) => {
    download.on("error", (error) => resolve({error}))
    download.on("close", (code, signal) => resolve({code, signal}))
  })
  const actual = await hashStream(download.stdout)
  const {code, signal, error} = await completed
  if (error) throw error
  if (code !== 0) throw new Error(`Downloading ${asset.name} for verification failed (${signal || code})`)
  if (actual !== expected) throw mismatch()
}

function retryable(error) {
  return (
    [408, 429, 500, 502, 503, 504].includes(error.status) ||
    (error.status === 403 && (error.rateLimited || error.retryAfterMs !== undefined)) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH"].includes(error.code)
  )
}

export async function publishReleaseAsset({
  repository,
  releaseId,
  name,
  file,
  token,
  findAsset = () => findReleaseAsset(repository, releaseId, name),
  upload = uploadReleaseAsset,
  verify = verifyReleaseAsset,
  removeAsset = (id) => gh(["api", "--method", "DELETE", `repos/${repository}/releases/assets/${id}`]),
  wait = sleep,
  log = console.log,
  maxAttempts = 3,
}) {
  if (path.basename(file) !== name) throw new Error("Immutable asset name must equal the source file basename")
  let existing = await findAsset()
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (existing?.state === "uploaded") {
      await verify({repository, file, asset: existing})
      log(`Verified existing immutable release asset ${name}`)
      return
    }
    if (existing) {
      // A starter can also be an active upload. Never delete one just because
      // our request timed out or another invocation left it behind.
      lastError = new Error(
        `Asset ${name} is incomplete (id ${existing.id}, state ${existing.state}, size ${existing.size}); ` +
          "inspect the upload before removing a failed placeholder",
      )
    } else {
      log(`Uploading ${name}, attempt ${attempt}/${maxAttempts}`)
      try {
        await upload({repository, releaseId, name, file, token, log})
        log(`Published immutable release asset ${name}`)
        return
      } catch (error) {
        lastError = error
        // A response can be lost after GitHub commits the asset. Reconcile
        // even on the last attempt, and verify bytes before accepting a race.
        existing = await findAsset()
        if (existing?.state === "uploaded") {
          await verify({repository, file, asset: existing})
          log(`Verified completed immutable release asset ${name} after upload error`)
          return
        }
        // GitHub documents an empty starter after a terminal 502. Only clean
        // that specific outcome of this invocation, never an ambiguous timeout.
        if (error.status === 502 && existing?.state === "starter" && existing.size === 0) {
          const confirmed = await findAsset()
          if (confirmed?.id === existing.id && confirmed.state === "starter" && confirmed.size === 0) {
            await removeAsset(existing.id)
            log(`Removed empty failed upload placeholder for ${name} (asset ${existing.id}) after HTTP 502`)
            existing = null
          } else existing = confirmed
          if (existing?.state === "uploaded") {
            await verify({repository, file, asset: existing})
            log(`Verified completed immutable release asset ${name} before placeholder cleanup`)
            return
          }
        }
        if (!retryable(error) && !(error.status === 422 && existing)) throw error
      }
    }
    if (attempt === maxAttempts) break
    const delay = Math.max(5000 * 2 ** (attempt - 1), lastError.retryAfterMs || 0)
    // Do not violate a long Retry-After or hold a release job indefinitely.
    if (delay > 120_000) throw lastError
    log(`${name}: ${lastError.message}; reconciling again in ${delay / 1000}s`)
    await wait(delay)
    existing = await findAsset()
  }
  throw new Error(`Could not publish ${name} after ${maxAttempts} attempts: ${lastError.message}`, {cause: lastError})
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file || !args.name || !args["release-id"] || !args.repository) {
    throw new Error("--file, --name, --release-id, and --repository are required")
  }
  await publishReleaseAsset({
    repository: args.repository,
    releaseId: args["release-id"],
    name: args.name,
    file: path.resolve(args.file),
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
