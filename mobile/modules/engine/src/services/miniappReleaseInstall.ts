import {useAppStatusStore} from "../stores/apps"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {installWithRuntimeReload} from "../utils/storeInstallRuntime"
import appRegistry, {type InstallBundleOptions} from "./AppRegistry"
import {miniappLauncher} from "./MiniappLauncher"

/**
 * Explicit release installation (QR and manual). The caller authorizes the
 * source; the archive goes through the one AppRegistry installer, which binds
 * it to the expected package and version and applies the signer and version
 * rules again inside its serialized transaction.
 *
 * A running miniapp is stopped for the install and restarted afterwards; its
 * launches wait until the install commits or rolls back.
 */
export async function installMiniappRelease(
  bundleUrl: string,
  options: InstallBundleOptions & {expectedPackageName: string; expectedVersion: string},
): Promise<void> {
  const packageName = options.expectedPackageName
  // An early check avoids stopping an app for a known downgrade. AppRegistry
  // checks again in its serialized filesystem transaction after download.
  appRegistry.assertCanInstallVersion(packageName, options.expectedVersion)
  await installWithRuntimeReload(miniappLauncher, packageName, async () => {
    // A dev probe or snapshot started before this release must not reactivate
    // development code after it commits.
    invalidateDevSnapshotRequests(packageName)
    const result = await appRegistry.installFromUrl(bundleUrl, options)
    if (result.is_error()) throw result.error
  })
  await useAppStatusStore.getState().refresh()
}
