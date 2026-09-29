import {useAppStatusStore} from "../stores/apps"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {installWithRuntimeReload} from "../utils/storeInstallRuntime"
import appRegistry, {type InstallBundleOptions} from "./AppRegistry"
import {miniappLauncher} from "./MiniappLauncher"

/** Shared release installation for QR and Store callers. Source authorization stays with the caller. */
export async function installMiniappRelease(
  bundleUrl: string,
  options: InstallBundleOptions & {expectedPackageName: string; expectedVersion: string; onlyIfStopped?: boolean},
): Promise<void> {
  const {onlyIfStopped, ...installOptions} = options
  const packageName = options.expectedPackageName
  // An early check avoids stopping an app for a known downgrade. AppRegistry
  // checks again in its serialized filesystem transaction after download.
  appRegistry.assertCanInstallVersion(packageName, options.expectedVersion)
  const install = async (beforeActivate?: () => void) => {
    if (!onlyIfStopped) invalidateDevSnapshotRequests(packageName)
    const result = await appRegistry.installFromUrl(bundleUrl, {
      ...installOptions,
      beforeActivate: () => {
        installOptions.beforeActivate?.()
        beforeActivate?.()
      },
    })
    if (result.is_error()) throw result.error
  }
  if (onlyIfStopped) {
    await miniappLauncher.installWhenIdle(packageName, (beforeActivate) =>
      useAppStatusStore.getState().runUpdate(packageName, () => {
        if (appRegistry.wasUserUninstalled(packageName)) throw new Error(`${packageName} was uninstalled`)
        return install(beforeActivate)
      }),
    )
  } else {
    await useAppStatusStore
      .getState()
      .runUpdate(packageName, () => installWithRuntimeReload(miniappLauncher, packageName, install))
  }
  await useAppStatusStore.getState().refresh()
}
