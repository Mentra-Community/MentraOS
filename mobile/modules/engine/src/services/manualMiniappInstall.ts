import {result as Res, type AsyncResult} from "typesafe-ts"

import {useAppStatusStore} from "../stores/apps"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {installWithRuntimeReload} from "../utils/storeInstallRuntime"
import appRegistry, {getDevAppRecords, registerDevApp} from "./AppRegistry"
import {runInstallFilesystemTransaction} from "./installOperation"
import {miniappLauncher} from "./MiniappLauncher"
import {canUseManualMiniappRelease} from "./SystemMiniappPolicy"

/** Explicit release QR installation; the archive must match the displayed manifest. */
export function installMiniappFromJsonUrl(
  baseUrl: string,
): AsyncResult<{packageName: string; version: string; name: string}, Error> {
  return Res.try_async(async () => {
    const trimmed = baseUrl.replace(/\/$/, "")
    const manifestRes = await fetch(`${trimmed}/miniapp.json`)
    if (!manifestRes.ok) throw new Error(`Failed to fetch miniapp.json: ${manifestRes.status}`)
    const manifest = (await manifestRes.json()) as Record<string, unknown>
    const packageName = typeof manifest.packageName === "string" ? manifest.packageName.trim() : ""
    const version = typeof manifest.version === "string" ? manifest.version.trim() : ""
    if (!packageName) throw new Error("miniapp.json missing packageName")
    if (!version) throw new Error("miniapp.json missing version")
    const name = typeof manifest.name === "string" ? manifest.name : packageName
    if (!canUseManualMiniappRelease(packageName)) {
      throw new Error(`Miniapp ${packageName} cannot be manually updated in this workspace`)
    }
    // Releases are immutable. Local edits without version bumps use a dev QR;
    // replacing the same directory would destroy the runtime rollback target.
    if (appRegistry.getInstalledVersions(packageName).includes(version)) {
      throw new Error(
        `Miniapp ${packageName}@${version} is already installed. Increase its version or use a development QR code.`,
      )
    }
    invalidateDevSnapshotRequests(packageName)
    // A snapshot may already have passed its activation guard. Let that
    // filesystem transaction settle before capturing the recovery target.
    const {previousDev, previousVersion} = await runInstallFilesystemTransaction(async () => ({
      previousDev: getDevAppRecords().find((app) => app.packageName === packageName),
      previousVersion: await appRegistry.getActiveVersion(packageName),
    }))
    await useAppStatusStore.getState().runUpdate(packageName, () =>
      installWithRuntimeReload(
        miniappLauncher,
        packageName,
        async () => {
          const result = await appRegistry.installFromUrl(`${trimmed}/bundle.zip`, {
            expectedPackageName: packageName,
            expectedVersion: version,
            rejectExistingVersion: true,
            preserveDevSnapshots: true,
            releaseIdentity: {source: "direct_download"},
          })
          if (result.is_error()) throw result.error
        },
        {
          restorePreviousVersion: async () => {
            if (!previousVersion && !previousDev) throw new Error(`No prior version is available for ${packageName}`)
            if (previousVersion) {
              const result = appRegistry.setActiveVersion(packageName, previousVersion)
              if (result.is_error()) throw result.error
            }
            if (previousDev) await registerDevApp(previousDev)
          },
        },
      ),
    )
    appRegistry.gcDevVersions(packageName, 0)
    await useAppStatusStore.getState().refresh()
    return {packageName, version, name}
  })
}
