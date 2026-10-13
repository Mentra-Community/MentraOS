import semver from "semver"

/**
 * Pure helper extracted from `AppRegistry.checkManifestVersions` so it
 * can be unit-tested without dragging in the `expo-file-system`
 * transitively-React-Native dependency tree.
 *
 * Returns `{ok: true}` when the manifest is compatible with the host, or
 * `{ok: false, blocker, reason}` with a user-facing string. Manifests missing
 * either field pass through (legacy single-bundle bundles).
 *
 * `sdkVersion` is the Mentra Miniapp SDK version the bundle targets;
 * `minHostVersion` is the Mentra App version the miniapp requires. A non-empty
 * constraint that does not parse is refused: Store metadata is untrusted, and
 * the extracted ZIP manifest is checked again before activation.
 */
export function checkManifestVersions(
  manifest: {sdkVersion?: string; minHostVersion?: string} | null,
  options: {hostVersion: string; supportedSdkRange: string},
): {ok: true} | {ok: false; blocker: "host" | "sdk"; reason: string} {
  if (!manifest) return {ok: true}
  if (manifest.minHostVersion) {
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
  if (manifest.sdkVersion) {
    const cleanSdk = semver.valid(semver.coerce(manifest.sdkVersion) ?? manifest.sdkVersion)
    if (!cleanSdk) {
      return {ok: false, blocker: "sdk", reason: `Invalid Mentra Miniapp SDK version: ${manifest.sdkVersion}.`}
    }
    if (!semver.satisfies(cleanSdk, options.supportedSdkRange)) {
      return {
        ok: false,
        blocker: "sdk",
        reason: `Built for SDK ${manifest.sdkVersion}; host supports ${options.supportedSdkRange}.`,
      }
    }
  }
  return {ok: true}
}
