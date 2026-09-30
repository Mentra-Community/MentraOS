import type {OtaCheckCurrentGlassesResult} from "./OtaUpdateCheckService"

export const MAX_OTA_AUTO_CHAIN_PASSES = 8
export const OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS = 120_000

type OtaAutoChainSession = {
  approvedDowngrade: boolean
  passCount: number
  releaseRange: OtaAutoChainReleaseRange
  reconnectDeadline: number | null
  seenFingerprints: Set<string>
}

export type OtaAutoChainReleaseRange = {
  fromVersion: string | null
  toVersion: string | null
  /** Exact coordinated release identity for the OTA pin, absent for legacy manifests. */
  releaseVersion?: string | null
}

export type OtaAutoChainAdvanceResult =
  | {advance: true; passCount: number}
  | {advance: false; reason: "inactive" | "duplicate" | "max_passes" | "downgrade_not_approved"}

/**
 * Identify the exact update offer that produced one OTA pass. Including the
 * observed versions and manifest body lets a changed manifest advance while a
 * stale post-install version_info response is rejected as a duplicate.
 */
export function otaAutoChainFingerprint(result: OtaCheckCurrentGlassesResult): string {
  return JSON.stringify({
    manifestUrl: result.manifestUrl ?? "",
    manifestBody: result.manifestBody ?? "",
    buildNumber: result.buildNumber ?? "",
    mtkFirmwareVersion: result.mtkFirmwareVersion ?? "",
    besFirmwareVersion: result.besFirmwareVersion ?? "",
    updates: result.updates,
    targetBuildNumber: result.updateInfo?.versionCode ?? result.latestVersionInfo?.versionCode ?? 0,
    targetBesVersion: result.besVersion ?? "",
    mtkPatch: result.mtkPatch
      ? {
          startFirmware: result.mtkPatch.start_firmware,
          endFirmware: result.mtkPatch.end_firmware,
          url: result.mtkPatch.url,
        }
      : null,
  })
}

export function createOtaAutoChain() {
  let session: OtaAutoChainSession | null = null
  /** Start a chain after the user explicitly approves its first update pass. */
  function beginOtaAutoChain(
    initialFingerprint: string,
    approvedDowngrade: boolean,
    releaseRange: OtaAutoChainReleaseRange,
  ): void {
    session = {
      approvedDowngrade,
      passCount: 1,
      releaseRange: {...releaseRange},
      reconnectDeadline: null,
      seenFingerprints: new Set([initialFingerprint]),
    }
  }

  function isOtaAutoChainActive(): boolean {
    return session !== null
  }

  function otaAutoChainReleaseRange(): OtaAutoChainReleaseRange | null {
    return session ? {...session.releaseRange} : null
  }

  /** End the current chain. Safe to call when no chain is active. */
  function stopOtaAutoChain(): void {
    session = null
  }

  /**
   * Start (or continue) the bounded wait for glasses that are rebooting between
   * passes. Re-renders must not extend the original deadline indefinitely.
   */
  function otaAutoChainReconnectWaitRemaining(now = performance.now()): number | null {
    if (!session) return null

    session.reconnectDeadline ??= now + OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS
    return Math.max(0, session.reconnectDeadline - now)
  }

  /** A successful reconnect allows a future pass to establish a fresh wait. */
  function clearOtaAutoChainReconnectWait(): void {
    if (session) session.reconnectDeadline = null
  }

  /**
   * Admit the next pass of an active chain. Repeated offers, unexpectedly
   * destructive downgrades, and runaway chains fail closed and end automation.
   */
  function tryAdvanceOtaAutoChain(
    fingerprint: string,
    isDowngrade: boolean,
    targetVersion: string | null,
    releaseVersion: string | null = null,
  ): OtaAutoChainAdvanceResult {
    if (!session) {
      return {advance: false, reason: "inactive"}
    }

    if (isDowngrade && !session.approvedDowngrade) {
      stopOtaAutoChain()
      return {advance: false, reason: "downgrade_not_approved"}
    }

    if (session.seenFingerprints.has(fingerprint)) {
      stopOtaAutoChain()
      return {advance: false, reason: "duplicate"}
    }

    if (session.passCount >= MAX_OTA_AUTO_CHAIN_PASSES) {
      stopOtaAutoChain()
      return {advance: false, reason: "max_passes"}
    }

    session.seenFingerprints.add(fingerprint)
    session.passCount += 1
    if (targetVersion) session.releaseRange.toVersion = targetVersion
    if (releaseVersion) session.releaseRange.releaseVersion = releaseVersion
    return {advance: true, passCount: session.passCount}
  }

  return {
    beginOtaAutoChain,
    isOtaAutoChainActive,
    otaAutoChainReleaseRange,
    stopOtaAutoChain,
    otaAutoChainReconnectWaitRemaining,
    clearOtaAutoChainReconnectWait,
    tryAdvanceOtaAutoChain,
  }
}

export type OtaAutoChain = ReturnType<typeof createOtaAutoChain>

// Compatibility helpers for existing host-internal/manual flows. Managed providers own an instance.
const legacyChain = createOtaAutoChain()
export const beginOtaAutoChain = legacyChain.beginOtaAutoChain
export const isOtaAutoChainActive = legacyChain.isOtaAutoChainActive
export const otaAutoChainReleaseRange = legacyChain.otaAutoChainReleaseRange
export const stopOtaAutoChain = legacyChain.stopOtaAutoChain
export const otaAutoChainReconnectWaitRemaining = legacyChain.otaAutoChainReconnectWaitRemaining
export const clearOtaAutoChainReconnectWait = legacyChain.clearOtaAutoChainReconnectWait
export const tryAdvanceOtaAutoChain = legacyChain.tryAdvanceOtaAutoChain
