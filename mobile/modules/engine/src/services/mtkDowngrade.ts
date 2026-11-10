import type {VersionJson} from "./OtaUpdateCheckService"

/** A published MTK downgrade that keeps userdata (scripts/release_mtk_ota.py in mentra_live/mtk). */
export interface MtkDowngrade {
  start_firmware: string
  end_firmware: string
  url: string
  sha256: string
  size: number
}

/**
 * Mentra 3.0's MTK. No downgrade goes below it: downgrades keep userdata (photos and videos), which
 * holds only between builds with the same Android version, security patch level and AVB rollback
 * indexes. The glasses (MtkOtaSelector) and the Bluetooth SDKs keep the same floor.
 */
export const MTK_DOWNGRADE_FLOOR = "MentraLive_20260709"
/** Each published downgrade's record, by its two versions. */
export const MTK_DOWNGRADE_RECORD_BASE_URL = "https://mtkfirmware.mentraglass.com/"

export function normalizeMtkVersion(version: string): string {
  return version.trim().split("_").pop() ?? ""
}

const mtkVersionPattern = /^\d{8}(?:\.\d{1,9})?$/

/** Date, then revision (a date-only version is revision 0); false when either is unknown. */
export function isNewerMtk(target: unknown, current: unknown): boolean {
  if (typeof target !== "string" || typeof current !== "string") return false
  const t = normalizeMtkVersion(target)
  const c = normalizeMtkVersion(current)
  if (!mtkVersionPattern.test(t) || !mtkVersionPattern.test(c)) return false
  const [targetDate, targetRevision = 0] = t.split(".").map(Number)
  const [currentDate, currentRevision = 0] = c.split(".").map(Number)
  return targetDate > currentDate || (targetDate === currentDate && targetRevision > currentRevision)
}

/**
 * The older MTK this manifest pins, from Mentra 3.0's up: its full OTA's version, or else the one
 * version its patches all end at.
 */
export function mtkDowngradeTarget(manifest: VersionJson | undefined, currentVersion: string | undefined): string | null {
  if (!manifest || !currentVersion) return null
  let target: string | null = null
  if (typeof manifest.mtk_full_ota?.end_firmware === "string") {
    target = normalizeMtkVersion(manifest.mtk_full_ota.end_firmware)
  } else {
    for (const patch of manifest.mtk_patches ?? []) {
      const end = typeof patch?.end_firmware === "string" ? normalizeMtkVersion(patch.end_firmware) : ""
      if (target !== null && target !== end) return null
      target = end
    }
  }
  if (!target || !isNewerMtk(currentVersion, target) || isNewerMtk(MTK_DOWNGRADE_FLOOR, target)) return null
  return target
}

/** A complete downgrade from exactly `currentVersion` to `target`. */
export function isMtkDowngrade(entry: unknown, currentVersion: string, target: string): entry is MtkDowngrade {
  const value = entry as Partial<MtkDowngrade> | null
  return (
    !!value &&
    typeof value.start_firmware === "string" &&
    typeof value.end_firmware === "string" &&
    normalizeMtkVersion(value.start_firmware) === normalizeMtkVersion(currentVersion) &&
    normalizeMtkVersion(value.end_firmware) === normalizeMtkVersion(target) &&
    isNewerMtk(currentVersion, target) &&
    !isNewerMtk(MTK_DOWNGRADE_FLOOR, target) &&
    typeof value.url === "string" &&
    /^https?:\/\/[^/\s]+\//.test(value.url) &&
    typeof value.sha256 === "string" &&
    /^[a-fA-F0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) > 0 &&
    (value.size as number) <= 1024 * 1024 * 1024
  )
}

export function mtkDowngradeRecordUrl(currentVersion: string, target: string): string {
  return `${MTK_DOWNGRADE_RECORD_BASE_URL}mtk_ota_downgrade_${normalizeMtkVersion(currentVersion)}_${normalizeMtkVersion(target)}.json`
}

/**
 * The downgrade to the older MTK the manifest pins: from the manifest, or else its published
 * record, which this adds to the manifest so the glasses get it too (on the hotspot they cannot
 * look it up). Null when there is none: the glasses keep their MTK.
 */
export async function resolveMtkDowngrade(
  manifest: VersionJson,
  currentVersion: string | undefined,
  fetchRecord: (url: string) => Promise<unknown> = fetchMtkDowngradeRecord,
): Promise<MtkDowngrade | null> {
  const target = mtkDowngradeTarget(manifest, currentVersion)
  if (!target || !currentVersion) return null
  const listed = manifest.mtk_downgrade_patches?.find((entry) => isMtkDowngrade(entry, currentVersion, target))
  if (listed) return listed
  const url = mtkDowngradeRecordUrl(currentVersion, target)
  let record: unknown
  try {
    record = await fetchRecord(url)
  } catch (error) {
    console.warn(`OTA: no MTK downgrade ${currentVersion} -> ${target} at ${url}; keeping this MTK`, error)
    return null
  }
  if (!isMtkDowngrade(record, currentVersion, target)) {
    console.warn(`OTA: MTK downgrade record at ${url} does not match ${currentVersion} -> ${target}`)
    return null
  }
  manifest.mtk_downgrade_patches = [...(manifest.mtk_downgrade_patches ?? []), record]
  return record
}

async function fetchMtkDowngradeRecord(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
