import * as RNFS from "@dr.pogodin/react-native-fs"
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
  ) {
    super(message)
    this.name = "OtaArtifactError"
  }
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
    const raw = (manifest.mtk_patches ?? []).find(
      (patch) => firmwareUrl(patch) === firmwareUrl(result.mtkPatch!),
    ) as unknown as Record<string, unknown> | undefined
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
  await RNFS.mkdir(directory, {NSURLIsExcludedFromBackupKey: true})

  const prepared: PreparedOtaArtifact[] = []
  for (let index = 0; index < plan.length; index++) {
    const entry = plan[index]

    const cachedPath = `${directory}/${entry.sha256}`
    if (await RNFS.exists(cachedPath)) {
      const cachedHash = (await RNFS.hash(cachedPath, "sha256")).toLowerCase()
      if (cachedHash === entry.sha256) {
        prepared.push({...entry, filePath: cachedPath})
        continue
      }
      await safeUnlink(cachedPath)
    }

    const partPath = `${directory}/download-${index}.part`
    await safeUnlink(partPath)
    try {
      const reportProgress = (bytesWritten: number, contentLength: number) => {
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
        : await RNFS.downloadFile({
            fromUrl: entry.url,
            toFile: partPath,
            connectionTimeout: 30_000,
            readTimeout: 30_000,
            progressDivider: 5,
            progress: (res: RNFS.DownloadProgressCallbackResultT) => {
              reportProgress(res.bytesWritten, res.contentLength)
            },
          }).promise
      if (downloadResult.statusCode !== 200) {
        throw new OtaArtifactError(
          "artifact_download_failed",
          `Download of ${entry.kind} artifact failed with HTTP ${downloadResult.statusCode}`,
        )
      }

      const actualSha256 = (await RNFS.hash(partPath, "sha256")).toLowerCase()
      if (actualSha256 !== entry.sha256) {
        throw new OtaArtifactError(
          "artifact_verify_failed",
          `${entry.kind} artifact hash mismatch: expected ${entry.sha256}, got ${actualSha256}`,
        )
      }

      const finalPath = `${directory}/${entry.sha256}`
      await safeUnlink(finalPath)
      await RNFS.moveFile(partPath, finalPath)
      prepared.push({...entry, filePath: finalPath})
    } catch (error) {
      await safeUnlink(partPath)
      if (error instanceof OtaArtifactError) {
        throw error
      }
      throw new OtaArtifactError(
        "artifact_download_failed",
        `Download of ${entry.kind} artifact failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return prepared
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
