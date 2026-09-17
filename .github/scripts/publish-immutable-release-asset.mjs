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
  // Preserve HTTP status and rate-limit headers on failures, including lookup
  // failures. A failed lookup must never be interpreted as an absent asset.
  try {
    const output = execFileSync("gh", [...args, "--include"], {stdio: ["ignore", "pipe", "pipe"], ...options})
    const body = output.toString().replace(responseHeadersPattern(), "")
    return typeof output === "string" ? body : Buffer.from(body)
  } catch (error) {
    throw githubError(error, error.stdout?.toString(), error.stderr?.toString())
  }
}

function responseHeadersPattern() {
  return /^HTTP\/\S+ \d{3}[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/gm
}

function rateLimitDetails(headers, status, detail = "") {
  const retryAfter = headers["retry-after"]
  let retryAfterMs = retryAfter
    ? /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : Date.parse(retryAfter) - Date.now()
    : undefined
  const rateLimited =
    headers["x-ratelimit-remaining"] === "0" || status === 429 || (status === 403 && /rate limit/i.test(detail))
  if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"]) {
    retryAfterMs = Math.max(retryAfterMs || 0, Number(headers["x-ratelimit-reset"]) * 1000 - Date.now())
  }
  if (rateLimited && retryAfterMs === undefined) retryAfterMs = 60_000
  return {retryAfterMs, rateLimited}
}

export function githubError(error, output = "", stderr = "") {
  const block = [...output.matchAll(responseHeadersPattern())].at(-1)?.[0]
  const status = Number(block?.match(/^HTTP\/\S+ (\d{3})/)?.[1] || stderr.match(/HTTP (\d{3})/)?.[1]) || undefined
  const headers = Object.fromEntries(
    (block || "")
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.includes(":"))
      .map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
  )
  const details = rateLimitDetails(headers, status, stderr)
  const code =
    /timeout|timed out|connection reset|unexpected EOF|TLS handshake|temporary failure|connection refused/i.test(stderr)
      ? "ECONNRESET"
      : error.code
  return Object.assign(new Error(stderr.trim().slice(0, 500) || error.message, {cause: error}), {
    status,
    code,
    ...details,
  })
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
          finish(
            Object.assign(
              new Error(
                `Uploading ${name} failed with HTTP ${status}: ${detail.replace(/\s+/g, " ").trim().slice(0, 300)}`,
              ),
              {status, ...rateLimitDetails(response.headers, status, detail)},
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

async function hashDownload(stream) {
  const hash = createHash("sha256")
  let pending = Buffer.alloc(0)
  let headers
  for await (const chunk of stream) {
    if (headers !== undefined) {
      hash.update(chunk)
      continue
    }
    pending = Buffer.concat([pending, chunk])
    // gh --include emits one final response header block, followed by the
    // binary body. Keep only that block, even when it spans stream chunks.
    const boundary = /\r?\n\r?\n/.exec(pending.toString("latin1"))
    if (!boundary) {
      if (pending.length > 64 * 1024) throw new Error("GitHub download response headers exceed 64 KiB")
      continue
    }
    const offset = boundary.index + boundary[0].length
    headers = pending.subarray(0, offset).toString("utf8")
    if (!/^HTTP\/\S+ \d{3}/.test(headers)) throw new Error("GitHub download is missing HTTP response headers")
    hash.update(pending.subarray(offset))
    pending = null
  }
  return {digest: hash.digest("hex"), headers: headers || ""}
}

export async function verifyReleaseAsset({repository, file, asset, spawnImpl = spawn}) {
  const mismatch = () => new Error(`Refusing to overwrite immutable release asset ${asset.name} with different bytes`)
  if (asset.size !== statSync(file).size) throw mismatch()
  const expected = await hashStream(createReadStream(file))
  // Stream verification too: the OTA bundle can be much larger than the APK.
  const download = spawnImpl(
    "gh",
    ["api", "--include", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${asset.id}`],
    {stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000},
  )
  let stderr = ""
  download.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(0, 4096)
  })
  const completed = new Promise((resolve) => {
    download.on("error", (error) => resolve({error}))
    download.on("close", (code, signal) => resolve({code, signal}))
  })
  let result
  try {
    result = await hashDownload(download.stdout)
  } catch (error) {
    download.kill()
    await completed
    throw error
  }
  const {digest: actual, headers} = result
  const {code, signal, error} = await completed
  if (error) throw error
  if (code !== 0)
    throw githubError(
      Object.assign(new Error(`Downloading ${asset.name} for verification failed (${signal || code})`), {
        code: signal === "SIGTERM" ? "ETIMEDOUT" : undefined,
      }),
      headers,
      stderr,
    )
  if (!/^HTTP\/\S+ 2\d{2}/.test(headers))
    throw new Error(`Downloading ${asset.name} did not return successful HTTP headers`)
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
  const backoff = async (error, attempt) => {
    const delay = Math.max(5000 * 2 ** (attempt - 1), error.retryAfterMs || 0)
    // Do not violate a long Retry-After or hold a release job indefinitely.
    if (delay > 120_000) throw error
    log(`${name}: ${error.message}; retrying after ${delay / 1000}s`)
    await wait(delay)
  }
  const recover = async (operation) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation()
      } catch (error) {
        if (!retryable(error) || attempt === maxAttempts) throw error
        await backoff(error, attempt)
      }
    }
  }
  const lookup = () => recover(findAsset)
  const verifyExisting = (asset) => recover(() => verify({repository, file, asset}))
  let existing = await lookup()
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let cooledDown = false
    if (existing?.state === "uploaded") {
      await verifyExisting(existing)
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
        // The same credential is used for reconciliation. Honor the upload's
        // cooldown before making ANY further API request, even on the last try.
        if (error.status === 429 || error.rateLimited || error.retryAfterMs !== undefined) {
          await backoff(error, attempt)
          cooledDown = true
        }
        // A response can be lost after GitHub commits the asset. Reconcile
        // even on the last attempt, and verify bytes before accepting a race.
        existing = await lookup()
        if (existing?.state === "uploaded") {
          await verifyExisting(existing)
          log(`Verified completed immutable release asset ${name} after upload error`)
          return
        }
        // GitHub documents an empty starter after a terminal 502. Only clean
        // that specific outcome of this invocation, never an ambiguous timeout.
        if (error.status === 502 && existing?.state === "starter" && existing.size === 0) {
          const confirmed = await lookup()
          if (confirmed?.id === existing.id && confirmed.state === "starter" && confirmed.size === 0) {
            await recover(() => removeAsset(existing.id))
            log(`Removed empty failed upload placeholder for ${name} (asset ${existing.id}) after HTTP 502`)
            existing = null
          } else existing = confirmed
          if (existing?.state === "uploaded") {
            await verifyExisting(existing)
            log(`Verified completed immutable release asset ${name} before placeholder cleanup`)
            return
          }
        }
        if (!retryable(error) && !(error.status === 422 && existing)) throw error
      }
    }
    if (attempt === maxAttempts) break
    if (!cooledDown) await backoff(lastError, attempt)
    existing = await lookup()
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
