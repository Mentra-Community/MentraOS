import * as RNFS from "@dr.pogodin/react-native-fs"
import {BgTimer} from "../utils/timers"
import {otaArtifactFailure, type OtaArtifactFailure} from "./OtaArtifactFailure"
import type {OtaCheckCurrentGlassesResult, VersionJson} from "./OtaUpdateCheckService"

/**
 * Phone-side artifact staging for hotspot-served OTA (OS-1676).
 *
 * When the glasses have no WiFi, the phone downloads the OTA artifacts itself (over
 * whatever network it is on — the user's tap on "update" is the consent) and serves them
 * to the glasses via the LocalOtaServer over the glasses' hotspot. This module owns:
 *
 * - planning which artifacts the pending update actually needs (from the raw manifest the
 *   update check fetched, so the glasses re-parse byte-identical version data),
 * - downloading them with .part staging and sha256 verification, keyed on disk by hash so
 *   retries and the post-APK continuation reuse verified files,
 * - rewriting the manifest's URL fields to point at the phone server, and
 * - cleanup once the update completes or the manifest moves on.
 */

export type OtaArtifactKind = "apk" | "mtk" | "bes"

export interface OtaArtifactPlanEntry {
  kind: OtaArtifactKind
  /** URL this artifact is fetched from, exactly as it appears in the raw manifest. */
  url: string
  /** Required content hash from the manifest. */
  sha256: string
}

export interface PreparedOtaArtifact extends OtaArtifactPlanEntry {
  filePath: string
}

export interface OtaArtifactDownloadProgress {
  kind: OtaArtifactKind
  /** 0-based index of the artifact being downloaded. */
  index: number
  totalCount: number
  /** Percent of the current artifact, 0-100 (0 when the server sent no length). */
  artifactPercent: number
  bytesWritten: number
  contentLength: number
}

export class OtaArtifactError extends Error {
  constructor(
    public readonly code: "artifact_download_failed" | "artifact_verify_failed" | "manifest_invalid",
    message: string,
    public readonly failure?: OtaArtifactFailure,
    cause?: unknown,
  ) {
    super(message)
    this.name = "OtaArtifactError"
    // Native Errors may contain URLs and paths. Keep the original available locally,
    // but only the bounded, redacted failure snapshot can enter JSON/incident evidence.
    if (cause !== undefined) Object.defineProperty(this, "cause", {value: cause})
  }
}

function artifactPreparationError(
  error: unknown,
  context: Omit<OtaArtifactFailure, "category" | "nativeErrors">,
): OtaArtifactError {
  return new OtaArtifactError(
    error instanceof OtaArtifactError
      ? error.code
      : context.stage === "verify"
      ? "artifact_verify_failed"
      : "artifact_download_failed",
    error instanceof OtaArtifactError ? error.message : "Preparing the update artifact failed",
    otaArtifactFailure(error, context),
    error,
  )
}

const ASG_PACKAGE = "com.mentra.asg_client"

export function otaArtifactsDirectory(): string {
  return `${RNFS.DocumentDirectoryPath}/ota_artifacts`
}

/**
 * Derive the artifact list the pending update needs from a completed check.
 * Works off the raw manifest body (not the normalized check fields) so the URLs and
 * hashes match exactly what the glasses will re-parse.
 */
export function planArtifacts(result: OtaCheckCurrentGlassesResult): OtaArtifactPlanEntry[] {
  if (!result.manifestBody) {
    throw new OtaArtifactError("manifest_invalid", "Check result carries no manifest body")
  }
  let manifest: VersionJson
  try {
    manifest = JSON.parse(result.manifestBody)
  } catch {
    throw new OtaArtifactError("manifest_invalid", "Manifest body is not valid JSON")
  }

  const entries: OtaArtifactPlanEntry[] = []

  if (result.updates.includes("apk")) {
    const app = manifest.apps?.[ASG_PACKAGE] as unknown as Record<string, unknown> | undefined
    const url = typeof app?.apkUrl === "string" ? app.apkUrl : null
    if (!url) {
      throw new OtaArtifactError("manifest_invalid", "Manifest has no apkUrl for the pending APK update")
    }
    entries.push({
      kind: "apk",
      url,
      sha256: requireSha256(app, "APK"),
    })
  }

  if (result.updates.includes("mtk") && result.mtkPatch) {
    const candidates = [...(manifest.mtk_patches ?? []), ...(manifest.mtk_full_ota ? [manifest.mtk_full_ota] : [])]
    const raw = candidates.find((entry) => firmwareUrl(entry) === firmwareUrl(result.mtkPatch!)) as unknown as
      | Record<string, unknown>
      | undefined
    const url = firmwareUrl(raw) ?? firmwareUrl(result.mtkPatch)
    if (!url) {
      throw new OtaArtifactError("manifest_invalid", "Manifest has no URL for the pending MTK patch")
    }
    entries.push({
      kind: "mtk",
      url,
      sha256: requireSha256(raw, "MTK"),
    })
  }

  if (result.updates.includes("bes") && manifest.bes_firmware) {
    const raw = manifest.bes_firmware as unknown as Record<string, unknown>
    const url = firmwareUrl(raw)
    if (!url) {
      throw new OtaArtifactError("manifest_invalid", "Manifest has no URL for the pending BES firmware")
    }
    entries.push({
      kind: "bes",
      url,
      sha256: requireSha256(raw, "BES"),
    })
  }

  return entries
}

/**
 * Download every planned artifact into the on-disk hash-keyed store, reusing files that
 * already verify. Sequential on purpose: progress is legible and the hotspot window that
 * follows is the slow part, not phone-side parallelism.
 */
export async function prepareArtifacts(
  plan: OtaArtifactPlanEntry[],
  onProgress?: (progress: OtaArtifactDownloadProgress) => void,
  nativeDownload?: (
    entry: OtaArtifactPlanEntry,
    destination: string,
    onProgress?: (bytesWritten: number, contentLength: number) => void,
  ) => Promise<{statusCode: number}>,
): Promise<PreparedOtaArtifact[]> {
  const directory = otaArtifactsDirectory()
  try {
    await RNFS.mkdir(directory, {NSURLIsExcludedFromBackupKey: true})
  } catch (error) {
    throw artifactPreparationError(error, {
      artifact: null,
      stage: "save",
      bytesWritten: 0,
      contentLength: 0,
    })
  }

  const prepared: PreparedOtaArtifact[] = []
  for (let index = 0; index < plan.length; index++) {
    const entry = plan[index]
    // Announce each file before cache verification or native download callbacks,
    // so the previous file's 100% cannot linger under the next file's label.
    onProgress?.({
      kind: entry.kind,
      index,
      totalCount: plan.length,
      artifactPercent: 0,
      bytesWritten: 0,
      contentLength: 0,
    })

    const cachedPath = `${directory}/${entry.sha256}`
    try {
      if (await RNFS.exists(cachedPath)) {
        const cachedHash = (await RNFS.hash(cachedPath, "sha256")).toLowerCase()
        if (cachedHash === entry.sha256) {
          prepared.push({...entry, filePath: cachedPath})
          continue
        }
        await safeUnlink(cachedPath)
      }
    } catch (error) {
      throw artifactPreparationError(error, {
        artifact: entry.kind,
        stage: "verify",
        bytesWritten: 0,
        contentLength: 0,
      })
    }

    const partPath = `${directory}/download-${index}.part`
    await safeUnlink(partPath)
    let stage: OtaArtifactFailure["stage"] = "download"
    let bytesWritten = 0
    let contentLength = 0
    let httpStatus: number | undefined
    try {
      const reportProgress = (written: number, length: number) => {
        bytesWritten = written
        contentLength = length
        onProgress?.({
          kind: entry.kind,
          index,
          totalCount: plan.length,
          artifactPercent: contentLength > 0 ? Math.round((bytesWritten / contentLength) * 100) : 0,
          bytesWritten,
          contentLength,
        })
      }
      const downloadResult = nativeDownload
        ? await nativeDownload(entry, partPath, reportProgress)
        : await downloadResumable(entry.url, partPath, reportProgress, (status) => {
            httpStatus = status
          })
      httpStatus = downloadResult.statusCode
      // A resumed native download can finish with 206. Accept it only through
      // the same full-file manifest SHA256 verification below.
      if (downloadResult.statusCode !== 200 && downloadResult.statusCode !== 206) {
        throw new OtaArtifactError(
          "artifact_download_failed",
          `Download of ${entry.kind} artifact failed with HTTP ${downloadResult.statusCode}`,
        )
      }

      stage = "verify"
      const actualSha256 = (await RNFS.hash(partPath, "sha256")).toLowerCase()
      if (actualSha256 !== entry.sha256) {
        throw new OtaArtifactError(
          "artifact_verify_failed",
          `${entry.kind} artifact hash mismatch: expected ${entry.sha256}, got ${actualSha256}`,
        )
      }

      stage = "save"
      const finalPath = `${directory}/${entry.sha256}`
      await safeUnlink(finalPath)
      await RNFS.moveFile(partPath, finalPath)
      prepared.push({...entry, filePath: finalPath})
    } catch (error) {
      await safeUnlink(partPath)
      throw artifactPreparationError(error, {artifact: entry.kind, stage, httpStatus, bytesWritten, contentLength})
    }
  }
  return prepared
}

const RESUMABLE = new Set<OtaArtifactFailure["category"]>(["connection", "internet", "timeout"])
/** Resumes after a dropped connection, such as Android moving the default network to Wi-Fi. */
const MAX_DOWNLOAD_RESUMES = 3
const APPEND_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Download `url` into `partPath`. When the connection drops with bytes on disk, fetch the
 * rest with a Range request into a side file and append it, up to MAX_DOWNLOAD_RESUMES
 * times. The caller's manifest SHA256 check still decides whether the file is good.
 */
async function downloadResumable(
  url: string,
  partPath: string,
  onProgress: (bytesWritten: number, contentLength: number) => void,
  onStatus: (statusCode: number) => void,
): Promise<{statusCode: number}> {
  const restPath = `${partPath}.rest`
  let offset = 0
  for (let resumes = 0; ; resumes++) {
    let rangeHonored = false
    try {
      const result = await RNFS.downloadFile({
        fromUrl: url,
        toFile: offset > 0 ? restPath : partPath,
        headers: offset > 0 ? {Range: `bytes=${offset}-`} : undefined,
        connectionTimeout: 30_000,
        readTimeout: 30_000,
        progressDivider: 5,
        begin: (res) => {
          onStatus(res.statusCode)
          rangeHonored = offset > 0 && res.statusCode === 206 && contentRangeStart(res.headers) === offset
        },
        progress: (res: RNFS.DownloadProgressCallbackResultT) => {
          const base = rangeHonored ? offset : 0
          onProgress(base + res.bytesWritten, base + res.contentLength)
        },
      }).promise
      if (offset === 0) return result
      if (rangeHonored) {
        await appendFileTo(restPath, partPath)
        return {statusCode: 200}
      }
      if (result.statusCode === 200) {
        // The server ignored Range and sent the whole file.
        await RNFS.unlink(partPath)
        await RNFS.moveFile(restPath, partPath)
      } else if (result.statusCode === 206) {
        throw new Error("The resumed download did not start where the file left off")
      }
      return result
    } catch (error) {
      if (rangeHonored) await appendFileTo(restPath, partPath)
      const written = await fileSize(partPath)
      const {category} = otaArtifactFailure(error, {
        artifact: null,
        stage: "download",
        bytesWritten: written,
        contentLength: 0,
      })
      // While Android switches networks, sockets abort and there can briefly be no route at all. On a slow
      // link the server can also close the body early, or the read can stall past its timeout.
      if (resumes >= MAX_DOWNLOAD_RESUMES || written === 0 || !RESUMABLE.has(category)) {
        throw error
      }
      console.warn(`[OTA_PROGRESS] artifact download dropped at ${written} bytes, resuming (${resumes + 1})`)
      offset = written
      // 2, 4, then 8 s: long enough for a new network to join and validate.
      await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, 2_000 * 2 ** resumes))
    } finally {
      await safeUnlink(restPath)
    }
  }
}

function contentRangeStart(headers: Record<string, string> | undefined): number | null {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "content-range")?.[1]
  const match = value ? /^bytes (\d+)-/i.exec(value.trim()) : null
  return match ? Number(match[1]) : null
}

/** RNFS has no native concatenation; copy in bounded base64 chunks. */
async function appendFileTo(from: string, to: string): Promise<void> {
  const size = await fileSize(from)
  let position = 0
  while (position < size) {
    const chunk = await RNFS.read(from, Math.min(APPEND_CHUNK_BYTES, size - position), position, "base64")
    const padding = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0
    const bytes = (chunk.length / 4) * 3 - padding
    if (bytes <= 0) throw new Error("Could not read the resumed artifact bytes")
    await RNFS.appendFile(to, chunk, "base64")
    position += bytes
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await RNFS.exists(path)) ? Number((await RNFS.stat(path)).size) : 0
  } catch {
    return 0
  }
}

/**
 * Point the manifest's artifact URLs at the phone server, leaving every other field
 * semantically identical to what the update check saw. Entries we host get
 * `<baseUrl>/artifacts/<sha256>`; entries the update does not need keep their CDN URLs.
 * Only URL fields change: target versions, sizes, and manifest hashes remain untouched.
 */
export function rewriteManifestForLocalServer(
  manifestBody: string,
  artifacts: PreparedOtaArtifact[],
  baseUrl: string,
): string {
  let manifest: VersionJson
  try {
    manifest = JSON.parse(manifestBody)
  } catch {
    throw new OtaArtifactError("manifest_invalid", "Manifest body is not valid JSON")
  }
  const byUrl = new Map(artifacts.map((artifact) => [artifact.url, artifact]))
  const localUrl = (artifact: PreparedOtaArtifact) => `${baseUrl}/artifacts/${artifact.sha256}`

  for (const app of Object.values(manifest.apps ?? {})) {
    const record = app as unknown as Record<string, unknown>
    const artifact = typeof record.apkUrl === "string" ? byUrl.get(record.apkUrl) : undefined
    if (artifact) {
      record.apkUrl = localUrl(artifact)
    }
  }

  for (const patch of manifest.mtk_patches ?? []) {
    rewriteFirmwareEntry(patch as unknown as Record<string, unknown>, byUrl, localUrl)
  }
  if (manifest.mtk_full_ota) {
    rewriteFirmwareEntry(manifest.mtk_full_ota as unknown as Record<string, unknown>, byUrl, localUrl)
  }
  if (manifest.bes_firmware) {
    rewriteFirmwareEntry(manifest.bes_firmware as unknown as Record<string, unknown>, byUrl, localUrl)
  }

  return JSON.stringify(manifest)
}

/** Delete every stored artifact whose hash is not in `keepSha256s` (plus stray .part files). */
export async function cleanupArtifacts(keepSha256s: string[] = []): Promise<void> {
  const directory = otaArtifactsDirectory()
  if (!(await RNFS.exists(directory))) {
    return
  }
  const keep = new Set(keepSha256s.map((sha) => sha.toLowerCase()))
  const items = await RNFS.readDir(directory)
  for (const item of items) {
    if (!item.isFile()) continue
    if (keep.has(item.name.toLowerCase())) continue
    await safeUnlink(item.path)
  }
}

function rewriteFirmwareEntry(
  entry: Record<string, unknown>,
  byUrl: Map<string, PreparedOtaArtifact>,
  localUrl: (artifact: PreparedOtaArtifact) => string,
): void {
  const url = firmwareUrl(entry)
  const artifact = url ? byUrl.get(url) : undefined
  if (!artifact) {
    return
  }
  entry.url = localUrl(artifact)
  // Overwrite the legacy key too when present, so no glasses build can prefer a stale
  // CDN URL over the local one.
  if (typeof entry.firmwareUrl === "string") {
    entry.firmwareUrl = localUrl(artifact)
  }
}

function firmwareUrl(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null
  }
  const record = entry as Record<string, unknown>
  if (typeof record.url === "string" && record.url.length > 0) {
    return record.url
  }
  if (typeof record.firmwareUrl === "string" && record.firmwareUrl.length > 0) {
    return record.firmwareUrl
  }
  return null
}

function requireSha256(entry: Record<string, unknown> | undefined, label: string): string {
  const sha256 = typeof entry?.sha256 === "string" ? entry.sha256.trim().toLowerCase() : ""
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new OtaArtifactError("manifest_invalid", `${label} artifact has no valid manifest sha256`)
  }
  return sha256
}

async function safeUnlink(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) {
      await RNFS.unlink(path)
    }
  } catch {
    // Best-effort: a leftover file only wastes space and is cleaned up next run.
  }
}
