import {result as Res, type AsyncResult} from "typesafe-ts"

import {useAppStatusStore} from "../stores/apps"
import {installWithRuntimeReload} from "../utils/storeInstallRuntime"
import appRegistry from "./AppRegistry"
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
    const previousVersion = await appRegistry.getActiveVersion(packageName)
    await useAppStatusStore.getState().runUpdate(packageName, () =>
      installWithRuntimeReload(
        miniappLauncher,
        packageName,
        async () => {
          const result = await appRegistry.installFromUrl(`${trimmed}/bundle.zip`, {
            expectedPackageName: packageName,
            expectedVersion: version,
            releaseIdentity: {source: "direct_download"},
          })
          if (result.is_error()) throw result.error
        },
        {
          restorePreviousVersion: () => {
            if (!previousVersion) throw new Error(`No prior version is available for ${packageName}`)
            const result = appRegistry.setActiveVersion(packageName, previousVersion)
            if (result.is_error()) throw result.error
          },
        },
      ),
    )
    await useAppStatusStore.getState().refresh()
    return {packageName, version, name}
  })
}
