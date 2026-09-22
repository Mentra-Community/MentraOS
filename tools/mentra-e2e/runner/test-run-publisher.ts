import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {lstat, open, type FileHandle} from "node:fs/promises"
import {dirname, isAbsolute, join, parse, resolve, sep} from "node:path"
import {
  canonicalJson,
  MAX_METADATA_BYTES,
  object,
  parsePublicationMetadata,
  requireThat,
  type TestRunAsset,
  type PublicationMetadata,
} from "./test-run-record"

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
interface AssetPath {
  assetId: string
  path: string
}
export interface PublishTestRunOptions {
  metadataPath: string
  assetsPath: string
  evidenceRoot: string
  journalPath: string
  coreUrl: string
  adminUrl: string
  token: string
}
export interface PublicationResult {
  runId: string
  reportUrl: string
  publication: "complete"
  uploadedAssets: number
  sourceOutcome: PublicationMetadata["outcome"]
  sourceEvidence: PublicationMetadata["outcomes"]["evidence"]
}

function origin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Publisher endpoint must be an explicit HTTP(S) origin")
  }
  requireThat(
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "Publisher endpoint must be an HTTPS origin (HTTP is limited to loopback), without credentials or paths",
  )
  return url.origin
}

// Check ancestors as well as the leaf; O_NOFOLLOW alone only protects the final component.
async function noSymlinks(path: string) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    requireThat(!stat.isSymbolicLink(), "Publisher inputs and journal must not traverse symlinks")
  }
  return absolute
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  await noSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    requireThat(
      before.isFile() && before.nlink === 1 && before.size <= limit,
      "Publisher input must be a regular, unlinked file within its size limit",
    )
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    const after = await file.stat()
    requireThat(
      size === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "Publisher input changed while being read",
    )
    return buffer.subarray(0, size)
  } finally {
    await file.close()
  }
}

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))
  } catch {
    throw new Error("Publisher metadata, asset map or acknowledgement is not valid UTF-8 JSON")
  }
}

function assetPaths(value: unknown, run: PublicationMetadata): AssetPath[] {
  const row = object(value, "Local asset map", ["schemaVersion", "assets"])
  requireThat(
    row.schemaVersion === 1 && Array.isArray(row.assets) && row.assets.length === run.assets.length,
    "Local asset map must enumerate every declared asset exactly once",
  )
  const declared = new Set(run.assets.map((asset) => asset.assetId))
  return row.assets.map((value) => {
    const asset = object(value, "Local asset", ["assetId", "path"])
    requireThat(
      typeof asset.assetId === "string" && declared.delete(asset.assetId),
      "Local asset ID is unknown or duplicated",
    )
    requireThat(
      typeof asset.path === "string" &&
        asset.path.length > 0 &&
        asset.path.length <= 4096 &&
        !isAbsolute(asset.path) &&
        !asset.path.includes("\\") &&
        !/[\x00-\x1f\x7f]/.test(asset.path) &&
        asset.path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      "Local asset path must be a relative path without traversal",
    )
    return {assetId: asset.assetId, path: asset.path}
  })
}

async function assetBytes(root: string, local: AssetPath, asset: TestRunAsset) {
  const bytes = await readBounded(join(root, local.path), asset.sizeBytes)
  requireThat(
    bytes.length === asset.sizeBytes && hash(bytes) === asset.sha256,
    `Asset ${asset.assetId} size or SHA-256 does not match its declaration`,
  )
  const signature =
    asset.contentType === "video/mp4"
      ? bytes.subarray(4, 8).toString() === "ftyp"
      : asset.contentType === "video/webm"
        ? bytes.subarray(0, 4).toString("hex") === "1a45dfa3"
        : asset.contentType === "image/png"
          ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
          : asset.contentType === "image/jpeg"
            ? bytes.subarray(0, 3).toString("hex") === "ffd8ff"
            : asset.contentType === "image/webp"
              ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
              : true
  requireThat(signature, `Asset ${asset.assetId} does not match its declared media format`)
  return bytes
}

async function journal(path: string, identity: Record<string, unknown>) {
  await noSymlinks(dirname(path))
  let file: FileHandle
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(`${JSON.stringify({event: "publication", schemaVersion: 1, ...identity})}\n`)
      await file.sync()
      const parent = await open(dirname(path), constants.O_RDONLY)
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const bytes = await readBounded(path, MAX_JOURNAL_BYTES)
  requireThat(
    bytes.length > 0 && bytes[bytes.length - 1] === 10,
    "Upload journal is incomplete; preserve it for reconciliation",
  )
  const rows = bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => json(Buffer.from(line)))
  requireThat(
    canonicalJson(rows[0]) === canonicalJson({event: "publication", schemaVersion: 1, ...identity}),
    "Upload journal belongs to a different immutable publication",
  )
  requireThat(
    rows
      .slice(1)
      .every(
        (row) =>
          row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          (row as Record<string, unknown>).event !== "publication",
      ),
    "Upload journal has conflicting records",
  )
  file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    requireThat(stat.isFile() && stat.nlink === 1, "Upload journal must be a regular file")
  } catch (error) {
    await file.close()
    throw error
  }
  return {
    async append(event: string, details: Record<string, unknown> = {}) {
      const row = `${JSON.stringify({event, at: new Date().toISOString(), ...details})}\n`
      const current = await file.stat()
      requireThat(current.size + Buffer.byteLength(row) <= MAX_JOURNAL_BYTES, "Upload journal reached its size limit")
      await file.writeFile(row)
      await file.sync()
    },
    close: () => file.close(),
  }
}

async function requestJson(
  url: string,
  token: string,
  body: string | Uint8Array,
  contentType: string,
  method: "POST" | "PUT",
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method,
      body: typeof body === "string" ? body : new Uint8Array(body),
      headers: {"authorization": `Bearer ${token}`, "content-type": contentType},
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new Error("Evidence upload request failed or timed out; rerun to reconcile server state")
  }
  if (![200, 201].includes(response.status)) {
    await response.body?.cancel()
    // Do not display response bodies: an endpoint could reflect the bearer token into an error.
    throw new Error(`Evidence upload returned HTTP ${response.status}; no response body was logged`)
  }
  const reader = response.body?.getReader()
  requireThat(reader, "Evidence upload acknowledgement is empty")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.length
      requireThat(size <= MAX_METADATA_BYTES, "Evidence upload acknowledgement exceeds 1 MiB")
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return json(Buffer.concat(chunks))
}

/** Publishes already recorded data only. A successful upload never changes test or fixture verdicts. */
export async function publishTestRun(options: PublishTestRunOptions): Promise<PublicationResult> {
  const coreUrl = origin(options.coreUrl)
  const adminUrl = origin(options.adminUrl)
  requireThat(
    typeof options.token === "string" && /^[!-~]{32,4096}$/.test(options.token),
    "A valid TEST_RUN_INGEST_TOKEN is required in the environment",
  )
  const root = await noSymlinks(options.evidenceRoot)
  requireThat((await lstat(root)).isDirectory(), "Evidence root must be a directory")
  const metadata = await readBounded(options.metadataPath, MAX_METADATA_BYTES)
  const run = parsePublicationMetadata(json(metadata))
  const locals = assetPaths(json(await readBounded(options.assetsPath, MAX_METADATA_BYTES)), run)
  const paths = new Map(locals.map((asset) => [asset.assetId, asset]))
  const payload = canonicalJson(run)
  requireThat(Buffer.byteLength(payload) <= MAX_METADATA_BYTES, "Canonical metadata exceeds 1 MiB")
  // Verify every byte before metadata POST; read again just before PUT and send that verified buffer.
  for (const asset of run.assets) await assetBytes(root, paths.get(asset.assetId)!, asset)
  const payloadSha256 = hash(payload)
  const log = await journal(resolve(options.journalPath), {
    runId: run.runId,
    payloadSha256,
    coreUrl,
    adminUrl,
    assetSelectionSha256: hash(
      canonicalJson({root, locals: [...locals].sort((a, b) => a.assetId.localeCompare(b.assetId))}),
    ),
  })
  const expectedPath = `/?testRun=${run.runId}`
  async function reconcile(): Promise<string[]> {
    await log.append("metadata-intent")
    const response = object(
      await requestJson(`${coreUrl}/api/internal/test-runs`, options.token, payload, "application/json", "POST"),
      "Metadata acknowledgement",
      ["runId", "reportPath", "created", "payloadSha256", "missingAssetIds"],
    )
    requireThat(
      response.runId === run.runId &&
        response.payloadSha256 === payloadSha256 &&
        response.reportPath === expectedPath &&
        typeof response.created === "boolean" &&
        Array.isArray(response.missingAssetIds) &&
        response.missingAssetIds.every((id) => typeof id === "string" && paths.has(id)) &&
        new Set(response.missingAssetIds).size === response.missingAssetIds.length,
      "Metadata acknowledgement does not match the immutable publication",
    )
    await log.append("metadata-acknowledged", {missingAssets: response.missingAssetIds.length})
    return response.missingAssetIds as string[]
  }
  try {
    const missing = await reconcile()
    for (const assetId of missing) {
      const asset = run.assets.find((asset) => asset.assetId === assetId)!
      const bytes = await assetBytes(root, paths.get(assetId)!, asset)
      await log.append("asset-intent", {assetId})
      const response = object(
        await requestJson(
          `${coreUrl}/api/internal/test-runs/${run.runId}/assets/${assetId}`,
          options.token,
          bytes,
          asset.contentType,
          "PUT",
        ),
        "Asset acknowledgement",
        ["assetId", "uploaded", "created"],
      )
      requireThat(
        response.assetId === assetId && response.uploaded === true && typeof response.created === "boolean",
        "Asset acknowledgement does not match the declared asset",
      )
      await log.append("asset-acknowledged", {assetId})
    }
    requireThat((await reconcile()).length === 0, "Evidence remains incomplete on the server; rerun to reconcile")
    const reportUrl = `${adminUrl}${expectedPath}`
    await log.append("publication-complete", {reportUrl})
    return {
      runId: run.runId,
      reportUrl,
      publication: "complete",
      uploadedAssets: missing.length,
      sourceOutcome: run.outcome,
      sourceEvidence: run.outcomes.evidence,
    }
  } catch (error) {
    // The journal records uncertainty, not untrusted error text or authentication material.
    await log.append("publication-interrupted")
    throw error
  } finally {
    await log.close()
  }
}
