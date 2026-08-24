import type {PreinstalledMiniappRegistryEntry} from "@mentra/cloud-client/react-native"
import {appRegistry, isPreinstalledMiniappPackageAllowed, sha256Hex} from "@mentra/engine/internal"
import {Directory, File, Paths} from "expo-file-system"
import semver from "semver"

import {cloudClient} from "@/services/cloudClient"

const LOG_TAG = "PreinstalledMiniappSync"

// The user-facing mobile app version (e.g. "2.12.0"), sourced the same way as
// the rest of the app (see mobile/src/app/index.tsx getLocalVersion).
const MOBILE_APP_VERSION = process.env.EXPO_PUBLIC_MENTRAOS_VERSION || null

/**
 * Whether the current mobile build satisfies an entry's minMobileVersion /
 * maxMobileVersion gate. Both bounds are optional and inclusive. Versions are
 * coerced (semver.coerce) so partial bounds like "2.11" work. If the app
 * version can't be determined or a bound is unparseable, we conservatively
 * treat the gate as satisfied rather than blocking installs on bad metadata.
 */
function isMobileVersionSupported(entry: PreinstalledMiniappRegistryEntry): boolean {
  const min = entry.minMobileVersion
  const max = entry.maxMobileVersion
  if (!min && !max) return true

  const current = semver.coerce(MOBILE_APP_VERSION ?? undefined)
  if (!current) {
    console.warn(
      `${LOG_TAG}: cannot determine mobile app version (EXPO_PUBLIC_MENTRAOS_VERSION=${MOBILE_APP_VERSION}); skipping version gate for ${entry.packageName}`,
    )
    return true
  }

  if (min) {
    const minVer = semver.coerce(min)
    if (minVer && semver.lt(current, minVer)) return false
  }
  if (max) {
    const maxVer = semver.coerce(max)
    if (maxVer && semver.gt(current, maxVer)) return false
  }
  return true
}

function shouldInstall(entry: PreinstalledMiniappRegistryEntry): boolean {
  if (!isPreinstalledMiniappPackageAllowed(entry.packageName)) {
    console.warn(`${LOG_TAG}: refusing remote replacement of build-owned SYSTEM package ${entry.packageName}`)
    return false
  }
  if (!isMobileVersionSupported(entry)) {
    console.log(
      `${LOG_TAG}: skipping ${entry.packageName}@${entry.version} — mobile ${MOBILE_APP_VERSION} outside [${entry.minMobileVersion ?? "*"}, ${entry.maxMobileVersion ?? "*"}]`,
    )
    return false
  }
  // install_once is an initial-delivery policy, not a permanent mandate. If
  // the user later removes it, preserve that choice. keep_updated/mandatory
  // remain admin-enforced policies and may restore a missing package.
  if (entry.installPolicy === "install_once" && appRegistry.wasUserUninstalled(entry.packageName)) return false
  const installedVersions = appRegistry.getInstalledVersions(entry.packageName)
  if (installedVersions.includes(entry.version)) return false
  if (entry.installPolicy === "install_once") return installedVersions.length === 0
  return true
}

async function installEntry(entry: PreinstalledMiniappRegistryEntry): Promise<void> {
  if (!shouldInstall(entry)) return

  console.log(`${LOG_TAG}: installing ${entry.packageName}@${entry.version} (${entry.installPolicy})`)
  const zipPath = await downloadVerifiedBundle(entry)
  const result = await appRegistry.installFromLocalZip(zipPath, {
    expectedPackageName: entry.packageName,
    expectedVersion: entry.version,
    expectedBundleSha256: entry.bundleSha256,
    releaseIdentity: {
      source: "preinstalled_registry",
      bundleSha256: entry.bundleSha256.toLowerCase(),
      channel: entry.channel,
    },
  })
  if (result.is_error()) {
    throw result.error
  }
}

async function downloadVerifiedBundle(entry: PreinstalledMiniappRegistryEntry): Promise<string> {
  const downloadDir = new Directory(Paths.cache, "preinstalled_miniapps")
  if (!downloadDir.exists) downloadDir.create()

  const safeName = `${entry.packageName}-${entry.version}.zip`.replace(/[^a-z0-9._-]/gi, "_")
  const target = new File(downloadDir, safeName)
  if (target.exists) target.delete()

  let output: File
  try {
    output = await File.downloadFileAsync(entry.bundleUrl, target, {idempotent: true})
  } catch (error) {
    throw new Error(`bundle download failed: ${(error as Error)?.message ?? error}`)
  }
  const bytes = await output.bytes()
  const actualSha = await sha256Hex(bytes)
  if (actualSha !== entry.bundleSha256.toLowerCase()) {
    try {
      output.delete()
    } catch {
      // best effort cleanup
    }
    throw new Error(`bundle sha mismatch: expected ${entry.bundleSha256}, got ${actualSha}`)
  }
  return output.uri
}

export const preinstalledMiniappSync = {
  async sync(): Promise<void> {
    let registry
    try {
      registry = await cloudClient.getPreinstalledMiniappRegistry()
    } catch (error) {
      console.warn(`${LOG_TAG}: registry fetch failed: ${(error as Error)?.message ?? error}`)
      return
    }

    for (const entry of registry.entries) {
      try {
        await installEntry(entry)
      } catch (error) {
        console.warn(
          `${LOG_TAG}: failed to install ${entry.packageName}@${entry.version}: ${(error as Error)?.message ?? error}`,
        )
      }
    }
  },
}
