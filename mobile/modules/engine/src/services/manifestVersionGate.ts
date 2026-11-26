import semver from "semver"

const sdkPackage = require("@mentra/miniapp/package.json") as {apiLevel: number; oldestApiLevel: number}

/** The Miniapp SDK API levels this engine runs: those of the `@mentra/miniapp` it ships (sdk/README.md). */
export const MINIAPP_API_LEVELS = {current: sdkPackage.apiLevel, oldest: sdkPackage.oldestApiLevel}

/**
 * Pure helper extracted from `AppRegistry.checkManifestVersions` so it
 * can be unit-tested without dragging in the `expo-file-system`
 * transitively-React-Native dependency tree.
 *
 * Returns `{ok: true}` when the manifest is compatible with the host, or
 * `{ok: false, blocker, reason}` with a log string.
 *
 * `minHostVersion` is the Mentra App version the miniapp requires: the only rule apps released before API levels
 * check. `minApiLevel` is the Miniapp SDK API level the bundle was built with; a manifest without one was built before
 * levels, at level 1. A host whose level is lower lacks part of the contract the miniapp uses (blocker `host`: update
 * the app); one whose oldest level is higher no longer runs what the miniapp relies on (blocker `sdk`: update the
 * miniapp). A constraint that does not parse is refused: Store metadata is untrusted, and the extracted ZIP manifest is
 * checked again before activation.
 */
export function checkManifestVersions(
  manifest: {minHostVersion?: string; minApiLevel?: number} | null,
  options: {hostVersion?: string; apiLevels?: {current: number; oldest: number}},
): {ok: true} | {ok: false; blocker: "host" | "sdk"; reason: string} {
  if (!manifest) return {ok: true}
  if (manifest.minHostVersion && options.hostVersion) {
    const cleanHost = semver.valid(semver.coerce(options.hostVersion) ?? options.hostVersion)
    const cleanMin = semver.valid(semver.coerce(manifest.minHostVersion) ?? manifest.minHostVersion)
    if (!cleanMin) {
      return {ok: false, blocker: "host", reason: `Invalid minimum Mentra App version: ${manifest.minHostVersion}.`}
    }
    if (cleanHost && semver.lt(cleanHost, cleanMin)) {
      return {
        ok: false,
        blocker: "host",
        reason: `Requires Mentra App ${manifest.minHostVersion}+; this host is ${options.hostVersion}.`,
      }
    }
  }
  const level = manifest.minApiLevel ?? 1
  const {current, oldest} = options.apiLevels ?? MINIAPP_API_LEVELS
  if (!Number.isInteger(level) || level < 1) {
    return {ok: false, blocker: "host", reason: `Invalid Miniapp SDK API level: ${manifest.minApiLevel}.`}
  }
  if (level > current) {
    return {ok: false, blocker: "host", reason: `Built at Miniapp SDK API level ${level}; this host runs ${current}.`}
  }
  if (level < oldest) {
    return {
      ok: false,
      blocker: "sdk",
      reason: `Built at Miniapp SDK API level ${level}; this host runs ${oldest} and later.`,
    }
  }
  return {ok: true}
}
