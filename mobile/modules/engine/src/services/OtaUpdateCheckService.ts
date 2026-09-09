import BluetoothSdk, {type OtaUpdateInfo} from "@mentra/bluetooth-sdk"
import {ENGINE_RELEASE_METADATA} from "../generated/releaseMetadata"
import {getGlassesSystemTimeMs, isGlassesConnected, useGlassesStore, waitForGlassesState} from "../stores/glasses"
import {maybeFixGlassesClockFromVersionInfo} from "./glassesClockSync"
import {hasConfiguredModernOtaManifestPin, resolveOtaManifestUrl} from "./otaManifestUrl"
import {resolveOtaReleaseVersion} from "./otaReleaseVersion"

/**
 * Phone-side mirror of ASG's `DOWNGRADE_FLOOR_VERSION_CODE`. Set to the versionCode of the first
 * release shipping the shared media root (the first downgrade-safe build). A non-positive value
 * means downgrades are disabled, so the phone must NOT offer them — offering a downgrade the
 * glasses' `DowngradeGate` will refuse leaves the version-change session with no install and the
 * glasses reporting a bare "complete", which would otherwise present as false success. Keep this
 * in lockstep with the ASG/recovery constant at release time.
 */
// Mentra 3.0: matches OtaConstants and RecoveryConstants on the glasses.
// Coordinated releases guarantee higher supported ASG builds can downgrade; no source gate is needed.
// The shipped floor may increase, never decrease, and must stay aligned across all checkers.
// See asg_client/docs/mentra-live-spec.md#ota-and-updates.
export const DOWNGRADE_FLOOR_VERSION_CODE = 51518114

export interface VersionInfo {
  versionCode: number
  versionName: string
  downloadUrl: string
  apkSize: number
  sha256: string
  releaseNotes: string
  isRequired?: boolean
}

export interface MtkPatch {
  start_firmware: string
  end_firmware: string
  url: string
  sha256?: string
}

export interface MtkFullOta {
  start_firmware?: never
  end_firmware: string
  url: string
  sha256: string
  size: number
}

export type MtkUpdate = MtkPatch | MtkFullOta

export interface BesFirmware {
  version: string
  url: string
  sha256?: string
}

export interface VersionJson {
  releaseVersion?: string
  apps?: {
    [packageName: string]: VersionInfo
  }
  mtk_patches?: MtkPatch[]
  mtk_full_ota?: MtkFullOta
  bes_firmware?: BesFirmware
  versionCode?: number
  versionName?: string
  downloadUrl?: string
  apkSize?: number
  sha256?: string
  releaseNotes?: string
}

export interface OtaCheckResult {
  hasCheckCompleted: boolean
  updateAvailable: boolean
  latestVersionInfo: VersionInfo | null
  updates: string[]
  /** Selected MTK artifact: exact-base incremental, otherwise a newer full OTA. */
  mtkPatch: MtkUpdate | null
  besVersion: string | null
  /** True when the pending APK step installs an OLDER build than the glasses currently run. */
  isApkDowngrade: boolean
  /**
   * Raw manifest JSON (stringified) this check actually fetched, or null when the
   * fetch failed. Lets change-watchers baseline on exactly what the check saw,
   * instead of racing it with a second fetch of the same URL.
   */
  manifestBody: string | null
  /** Coordinated release identity for the selected OTA pin. */
  releaseVersion: string | null
  /**
   * Why the check failed, when it did. "network" is retryable (connection/server
   * trouble); "pin_unavailable" is permanent for this app build (manifest 404/gone,
   * unparseable, or carrying no valid ASG pin) — the remedy is updating the app.
   */
  checkFailureReason?: "network" | "pin_unavailable"
}

/**
 * Package the stock glasses client installs as, and the key every apps-shaped manifest pins the
 * ASG APK under. Android forces a distinct package (`.thirdparty` suffix) on any build not signed
 * with Mentra's release key, so a client reporting anything else is a sideloaded build that
 * coexists with the stock system app.
 */
export const STOCK_ASG_PACKAGE = "com.mentra.asg_client"

export type OtaCheckSkippedReason = "disconnected" | "missing_build" | "dev_build" | "unofficial_client"

export interface OtaCheckCurrentGlassesResult extends OtaCheckResult {
  updateInfo: OtaUpdateInfo | null
  isRequired: boolean
  skippedReason?: OtaCheckSkippedReason
  manifestUrl?: string
  buildNumber?: string
  /** Glasses client package, when it reported one. Set on an `unofficial_client` skip. */
  packageName?: string
  mtkFirmwareVersion?: string
  besFirmwareVersion?: string
}

export interface OtaCheckCurrentGlassesOptions {
  waitForBuildNumberMs?: number
  waitForBesVersionMs?: number
  waitForMtkVersionMs?: number
  refreshVersionInfo?: boolean
  fixClockBeforeCheck?: boolean
  /** Downgrade floor override (defaults to DOWNGRADE_FLOOR_VERSION_CODE); for tests. */
  floorVersionCode?: number
}

function emptyCheckResult(
  skippedReason?: OtaCheckSkippedReason,
  extra?: Partial<OtaCheckCurrentGlassesResult>,
): OtaCheckCurrentGlassesResult {
  return {
    hasCheckCompleted: false,
    updateAvailable: false,
    latestVersionInfo: null,
    updates: [],
    mtkPatch: null,
    besVersion: null,
    isApkDowngrade: false,
    manifestBody: null,
    releaseVersion: null,
    updateInfo: null,
    isRequired: true,
    skippedReason,
    ...extra,
  }
}

function glassesConnectedNow(): boolean {
  return isGlassesConnected(useGlassesStore.getState().connection)
}

type ManifestFetchResult = {json: VersionJson | null; failureReason?: "network" | "pin_unavailable"}

async function fetchVersionInfoDetailed(url: string): Promise<ManifestFetchResult> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.warn("Failed to fetch version info:", response.status)
      // 4xx: the manifest does not exist (or is gone) — permanent for this app
      // build, retrying cannot help. Everything else is transient server/network
      // trouble and retryable.
      return {
        json: null,
        failureReason: response.status >= 400 && response.status < 500 ? "pin_unavailable" : "network",
      }
    }
    try {
      return {json: await response.json()}
    } catch (parseError) {
      console.warn("OTA: manifest is not valid JSON:", parseError)
      return {json: null, failureReason: "pin_unavailable"}
    }
  } catch (error) {
    console.warn("OTA: Error fetching version info:", error)
    return {json: null, failureReason: "network"}
  }
}

export async function fetchVersionInfo(url: string): Promise<VersionJson | null> {
  return (await fetchVersionInfoDetailed(url)).json
}

export function checkVersionUpdateAvailable(
  currentBuildNumber: string | undefined,
  versionJson: VersionJson | null,
  floorVersionCode: number = DOWNGRADE_FLOOR_VERSION_CODE,
): boolean {
  return getApkUpdateDirection(currentBuildNumber, versionJson, floorVersionCode) !== null
}

/**
 * Direction of the pending APK change, or null when the glasses already match the manifest.
 * Every apps-shaped manifest the phone drives is an exact pin, so both directions are
 * actionable (mirroring the glasses-side `DowngradeGate`); the ancient top-level manifest
 * shape stays upgrade-only, and zeroed rescue pins are never actionable.
 */
export function getApkUpdateDirection(
  currentBuildNumber: string | undefined,
  versionJson: VersionJson | null,
  floorVersionCode: number = DOWNGRADE_FLOOR_VERSION_CODE,
): "upgrade" | "downgrade" | null {
  if (!currentBuildNumber || !versionJson) {
    return null
  }

  const currentVersion = parseInt(currentBuildNumber, 10)
  if (isNaN(currentVersion)) {
    return null
  }

  let serverVersion: number | undefined
  let exactPin = false

  const appEntry = versionJson.apps?.[STOCK_ASG_PACKAGE]
  if (appEntry) {
    serverVersion = appEntry.versionCode
    exactPin = true
  } else if (versionJson.versionCode) {
    serverVersion = versionJson.versionCode
  }

  if (!serverVersion || isNaN(serverVersion)) {
    return null
  }

  if (serverVersion > currentVersion) {
    return "upgrade"
  }
  // Downgrades require an exact pin AND a target at/above the enabled floor. A non-positive floor
  // disables downgrades entirely, matching ASG's fail-closed DowngradeGate — so the phone never
  // offers what the glasses would refuse.
  if (serverVersion < currentVersion && exactPin && floorVersionCode > 0 && serverVersion >= floorVersionCode) {
    return "downgrade"
  }
  return null
}

export function getLatestVersionInfo(versionJson: VersionJson | null): VersionInfo | null {
  if (!versionJson) {
    return null
  }

  if (versionJson.apps?.[STOCK_ASG_PACKAGE]) {
    return versionJson.apps[STOCK_ASG_PACKAGE]
  }

  if (versionJson.versionCode) {
    return {
      versionCode: versionJson.versionCode,
      versionName: versionJson.versionName || "",
      downloadUrl: versionJson.downloadUrl || "",
      apkSize: versionJson.apkSize || 0,
      sha256: versionJson.sha256 || "",
      releaseNotes: versionJson.releaseNotes || "",
    }
  }

  return null
}

export function findMatchingMtkPatch(
  patches: MtkPatch[] | undefined,
  currentVersion: string | undefined,
): MtkPatch | null {
  if (!patches || !currentVersion) {
    return null
  }

  return (
    patches.find((patch) => {
      return normalizeMtkVersion(patch.start_firmware) === normalizeMtkVersion(currentVersion)
    }) || null
  )
}

function normalizeMtkVersion(version: string): string {
  return version.trim().split("_").pop() ?? ""
}

/** Full OTAs are not rollback packages. Unknown versions must not grant eligibility. */
export function selectMtkUpdate(
  manifest: VersionJson | undefined,
  currentVersion: string | undefined,
): MtkUpdate | null {
  const patch = findMatchingMtkPatch(manifest?.mtk_patches, currentVersion)
  if (patch) return patch
  const full = manifest?.mtk_full_ota
  if (!full || !currentVersion || typeof full.end_firmware !== "string") return null
  const current = normalizeMtkVersion(currentVersion)
  const target = normalizeMtkVersion(full.end_firmware)
  const versionPattern = /^\d{8}(?:\.\d{1,9})?$/
  if (!versionPattern.test(current) || !versionPattern.test(target)) return null
  const [currentDate, currentRevision = 0] = current.split(".").map(Number)
  const [targetDate, targetRevision = 0] = target.split(".").map(Number)
  if (targetDate < currentDate || (targetDate === currentDate && targetRevision <= currentRevision)) return null
  if (
    full.start_firmware !== undefined ||
    typeof full.url !== "string" ||
    !/^https?:\/\/[^/\s]+\//.test(full.url) ||
    typeof full.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(full.sha256) ||
    !Number.isSafeInteger(full.size) ||
    full.size <= 0 ||
    full.size > 1024 * 1024 * 1024
  )
    return null
  return full
}

export function checkBesUpdate(besFirmware: BesFirmware | undefined, currentVersion: string | undefined): boolean {
  if (!besFirmware) {
    return false
  }

  if (!currentVersion) {
    console.log(`📱 BES current version unknown - assuming update needed (server: ${besFirmware.version})`)
    return true
  }
  return compareVersions(besFirmware.version, currentVersion) > 0
}

export function compareVersions(version1: string, version2: string): number {
  if (version1.includes(".") && version2.includes(".")) {
    const parts1 = version1.split(".")
    const parts2 = version2.split(".")
    const maxLen = Math.max(parts1.length, parts2.length)

    for (let i = 0; i < maxLen; i++) {
      const v1 = i < parts1.length ? parseInt(parts1[i], 10) : 0
      const v2 = i < parts2.length ? parseInt(parts2[i], 10) : 0
      if (v1 !== v2) {
        return v1 - v2
      }
    }
    return 0
  }

  return version1.localeCompare(version2)
}

export async function checkForOtaUpdate(
  otaVersionUrl: string,
  currentBuildNumber: string,
  currentMtkVersion?: string,
  currentBesVersion?: string,
  floorVersionCode: number = DOWNGRADE_FLOOR_VERSION_CODE,
): Promise<OtaCheckResult> {
  try {
    console.log("OTA: Checking for OTA update - URL: " + otaVersionUrl + ", current build: " + currentBuildNumber)
    const fetched = await fetchVersionInfoDetailed(otaVersionUrl)
    const versionJson = fetched.json
    if (!versionJson) {
      return {
        hasCheckCompleted: false,
        updateAvailable: false,
        latestVersionInfo: null,
        updates: [],
        mtkPatch: null,
        besVersion: null,
        isApkDowngrade: false,
        manifestBody: null,
        releaseVersion: null,
        checkFailureReason: fetched.failureReason ?? "network",
      }
    }
    const latestVersionInfo = getLatestVersionInfo(versionJson)

    // A manifest whose ASG pin is missing/zeroed cannot verify anything for modern
    // glasses (zeroed pins are only legitimate in the frozen legacy rescue manifests
    // that pre-39 glasses are checked against). Report the check as FAILED rather
    // than silently completing as "up to date" — an unverifiable state must never
    // present as a verified one.
    const currentVersionNumber = parseInt(currentBuildNumber, 10)
    const pinnedEntry = versionJson?.apps?.[STOCK_ASG_PACKAGE]
    const pinnedVersion = pinnedEntry?.versionCode ?? versionJson?.versionCode
    if (
      versionJson &&
      Number.isFinite(currentVersionNumber) &&
      currentVersionNumber >= 39 &&
      !(typeof pinnedVersion === "number" && pinnedVersion > 0)
    ) {
      console.error(
        `OTA: manifest at ${otaVersionUrl} has no valid ASG pin (versionCode=${String(pinnedVersion)}) - treating check as failed`,
      )
      return {
        hasCheckCompleted: false,
        updateAvailable: false,
        latestVersionInfo: null,
        updates: [],
        mtkPatch: null,
        besVersion: null,
        isApkDowngrade: false,
        manifestBody: null,
        releaseVersion: null,
        checkFailureReason: "pin_unavailable",
      }
    }

    const apkDirection = getApkUpdateDirection(currentBuildNumber, versionJson, floorVersionCode)
    const apkUpdateAvailable = apkDirection !== null
    console.log(
      `OTA: APK update available: ${apkUpdateAvailable} (current: ${currentBuildNumber}, direction: ${apkDirection ?? "none"})`,
    )

    const mtkPatch = selectMtkUpdate(versionJson, currentMtkVersion)
    const mtkUpdateAvailable = mtkPatch !== null
    if (!currentMtkVersion && versionJson?.mtk_patches?.length) {
      console.log(`OTA: MTK current version unknown - skipping MTK patch check`)
    }
    console.log(
      `OTA: MTK patch available: ${mtkUpdateAvailable ? "yes" : "no"} (current MTK: ${currentMtkVersion || "unknown"})`,
    )

    const besUpdateAvailable = checkBesUpdate(versionJson?.bes_firmware, currentBesVersion)
    console.log(`OTA: BES update available: ${besUpdateAvailable} (current BES: ${currentBesVersion || "unknown"})`)

    const updates: string[] = []
    if (apkUpdateAvailable) updates.push("apk")
    if (mtkUpdateAvailable) updates.push("mtk")
    if (besUpdateAvailable) updates.push("bes")

    console.log(`OTA: OTA check result - updates available: ${updates.length > 0}, updates: [${updates.join(", ")}]`)

    return {
      hasCheckCompleted: true,
      updateAvailable: updates.length > 0,
      latestVersionInfo,
      updates,
      mtkPatch,
      besVersion: versionJson?.bes_firmware?.version || null,
      isApkDowngrade: apkDirection === "downgrade",
      manifestBody: versionJson ? JSON.stringify(versionJson) : null,
      releaseVersion: resolveOtaReleaseVersion({
        manifestReleaseVersion: versionJson.releaseVersion,
        manifestUrl: otaVersionUrl,
        packagedManifestUrl: ENGINE_RELEASE_METADATA.otaManifestUrl,
        packagedReleaseIdentity: ENGINE_RELEASE_METADATA.releaseIdentity,
      }),
    }
  } catch (error) {
    console.error("Error checking for OTA update:", error)
    return {
      hasCheckCompleted: false,
      updateAvailable: false,
      latestVersionInfo: null,
      updates: [],
      mtkPatch: null,
      besVersion: null,
      isApkDowngrade: false,
      manifestBody: null,
      releaseVersion: null,
      checkFailureReason: "network",
    }
  }
}

export async function checkCurrentGlassesForUpdate(
  options: OtaCheckCurrentGlassesOptions = {},
): Promise<OtaCheckCurrentGlassesResult> {
  const {
    waitForBuildNumberMs = 0,
    waitForBesVersionMs = 5000,
    waitForMtkVersionMs = 2000,
    refreshVersionInfo = true,
    fixClockBeforeCheck = true,
    floorVersionCode = DOWNGRADE_FLOOR_VERSION_CODE,
  } = options

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  if (!hasConfiguredModernOtaManifestPin()) {
    console.log("OTA: check skipped - this app or Engine package has no embedded OTA manifest pin")
    return emptyCheckResult("dev_build")
  }

  if (refreshVersionInfo) {
    void BluetoothSdk.requestVersionInfo()
      .then((versionInfo) => {
        useGlassesStore.getState().setGlassesInfo(versionInfo)
      })
      .catch((error) => {
        console.warn("OTA: Failed to request version_info from glasses:", error)
      })
  }

  let buildNumber = useGlassesStore.getState().buildNumber
  if (!buildNumber && waitForBuildNumberMs > 0) {
    await waitForGlassesState("buildNumber", (value) => !!value, waitForBuildNumberMs)
    buildNumber = useGlassesStore.getState().buildNumber
  }

  if (!buildNumber || !(parseInt(buildNumber, 10) > 0)) {
    // Covers absent, non-numeric, and zero build numbers: a glasses version we
    // cannot parse means nothing is verifiable, so skip rather than ghost an
    // "up to date" result from a comparison that never really ran.
    return emptyCheckResult("missing_build")
  }

  // A sideloaded ASG client installs under its own package (Android forces the `.thirdparty`
  // suffix on any build not signed with Mentra's release key) and coexists with the stock system
  // app. Its build number is therefore not comparable to the manifest's pin, and installing the
  // manifest APK would replace the stock package while the sideloaded client keeps holding the
  // link and reporting its own unchanged version — an update prompt that can never be satisfied.
  // Absent means the glasses predate the field: assume stock, preserving existing behavior.
  const packageName = useGlassesStore.getState().packageName
  if (packageName && packageName !== STOCK_ASG_PACKAGE) {
    console.log(`OTA: check skipped - glasses run an unofficial client (${packageName})`)
    return emptyCheckResult("unofficial_client", {buildNumber, packageName})
  }

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  let besFirmwareVersion = useGlassesStore.getState().besFirmwareVersion
  if (!besFirmwareVersion && waitForBesVersionMs > 0) {
    console.log("OTA: BES version still unknown - waiting up to 5s for it to arrive...")
    await waitForGlassesState("besFirmwareVersion", (value) => !!value, waitForBesVersionMs)
    besFirmwareVersion = useGlassesStore.getState().besFirmwareVersion
    if (besFirmwareVersion) {
      console.log(`OTA: BES version arrived: ${besFirmwareVersion}`)
    } else {
      console.log("OTA: BES version still unknown after extended wait - will assume BES update if published")
    }
  }

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  let mtkFirmwareVersion = useGlassesStore.getState().mtkFirmwareVersion
  if (!mtkFirmwareVersion && waitForMtkVersionMs > 0) {
    await waitForGlassesState("mtkFirmwareVersion", (value) => !!value, waitForMtkVersionMs)
    mtkFirmwareVersion = useGlassesStore.getState().mtkFirmwareVersion
  }

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  if (fixClockBeforeCheck) {
    const systemTimeMs = getGlassesSystemTimeMs()
    await maybeFixGlassesClockFromVersionInfo(systemTimeMs > 0 ? systemTimeMs : undefined).catch((error) => {
      console.warn("OTA: clock fix attempt failed; continuing OTA check", error)
    })
  }

  const manifestUrl = resolveOtaManifestUrl(useGlassesStore.getState().otaVersionUrl, buildNumber)
  if (!manifestUrl) {
    console.log("OTA: check skipped - no OTA manifest pin resolved")
    return emptyCheckResult("dev_build")
  }
  const result = await checkForOtaUpdate(
    manifestUrl,
    buildNumber,
    mtkFirmwareVersion,
    besFirmwareVersion,
    floorVersionCode,
  )

  if (!result.hasCheckCompleted) {
    return {
      ...result,
      updateInfo: null,
      isRequired: true,
      manifestUrl,
      buildNumber,
      mtkFirmwareVersion,
      besFirmwareVersion,
    }
  }

  const mtkUpdatedThisSession = useGlassesStore.getState().mtkUpdatedThisSession
  let filteredUpdates = result.updates
  if (mtkUpdatedThisSession && filteredUpdates.includes("mtk")) {
    console.log("OTA: Filtering out MTK - already updated this session (pending reboot)")
    filteredUpdates = filteredUpdates.filter((update) => update !== "mtk")
  }

  // Pre-migration parity: an update is only surfaced when the manifest also
  // carries APK version metadata. A firmware-only manifest (mtk_patches /
  // bes_firmware with no APK entry) is therefore dropped here — same as the
  // legacy host check. Loud-log it so the case is visible in the field;
  // surfacing firmware-only updates is a deliberate behavior change to make
  // separately, not silently inside the boundary migration.
  if (filteredUpdates.length > 0 && !result.latestVersionInfo) {
    console.warn(
      `OTA: manifest lists updates [${filteredUpdates.join(", ")}] but has no APK version metadata - ` +
        "reporting no update (legacy behavior)",
    )
  }
  const updateAvailable = filteredUpdates.length > 0 && !!result.latestVersionInfo
  const isApkDowngrade = result.isApkDowngrade && filteredUpdates.includes("apk")
  const updateInfo = updateAvailable
    ? {
        available: true,
        versionCode: result.latestVersionInfo?.versionCode || 0,
        versionName: result.latestVersionInfo?.versionName || "",
        updates: filteredUpdates,
        totalSize: 0,
        ...(filteredUpdates.includes("bes") && result.besVersion ? {besVersion: result.besVersion} : {}),
        isDowngrade: isApkDowngrade,
      }
    : null

  useGlassesStore.getState().setOtaUpdateAvailable(updateInfo)

  return {
    ...result,
    updateAvailable,
    updates: filteredUpdates,
    isApkDowngrade,
    updateInfo,
    // Required-update policy: an EXPLICIT isRequired in the manifest is the
    // release-engineering escape hatch and wins in both directions. When absent,
    // upgrades keep the historical forced default, but downgrades are always
    // skippable — a version change that resets glasses settings must be
    // declinable unless someone explicitly forced it.
    isRequired:
      result.latestVersionInfo?.isRequired === true
        ? true
        : result.latestVersionInfo?.isRequired === false
          ? false
          : !isApkDowngrade,
    manifestUrl,
    buildNumber,
    mtkFirmwareVersion,
    besFirmwareVersion,
  }
}
