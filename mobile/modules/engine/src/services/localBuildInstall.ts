/**
 * Local builds: a miniapp a developer serves from their own computer, at a local address (spec, "Miniapps served from
 * a developer's computer").
 *
 * A local address has no domain, so nothing proves the package name such a build claims. It installs as a
 * development build (`dev-*`) of that name, recorded `source: "local"` with its address, beside any installed release
 * of the name, which it stands in for until the person installs a release or uninstalls the package. Like every
 * development build:
 *
 * - it is never registered, and updates from its own address only (`miniappUrlUpdates.ts`);
 * - its data is apart from every other install of the name, and its tokens are marked as a local build's
 *   (`miniappDataPartition.ts`, `LocalMiniappRuntime.requestMiniappAuth`);
 * - its screen never shares an origin with a release of the name (`MiniappLauncher`);
 * - it never gets system privileges;
 * - the signing rule applies to its ZIP;
 * - only the person replaces it (`AppRegistry.isDevelopmentBuild`).
 */
import {isDevMiniappAllowed} from "../runtime/bootstrap"
import {useAppStatusStore} from "../stores/apps"
import appRegistry, {type InstallBundleOptions} from "./AppRegistry"
import {miniappLauncher} from "./MiniappLauncher"
import {MiniappInstallCancelledError} from "./miniappReleaseInstall"

export interface LocalBuildInstall {
  packageName: string
  /** The version its `miniapp.json` names; its ZIP must name it too. It installs as a `dev-*` build. */
  version: string
  /**
   * Its address, as the person installed it: the `local` build's `sourceUrl`, which it updates from. None for an
   * older CLI's release QR, whose server names no build to update to: that build stays as it is.
   */
  sourceUrl?: string
  /** The ZIP's SHA-256, as its `miniapp.json` names it; an older CLI's release QR names none. */
  sha256?: string
  /** The console connection of the server that serves it (`development.reload`, as `mentra dev` serves it). */
  reloadUrl?: string
  /** Download the ZIP; by default, a plain download. */
  downloadBundle?: InstallBundleOptions["downloadBundle"]
  /** True once the install should stop. Nothing activates after that. */
  isCancelled?: () => boolean
}

/** A fresh development build version. Sorted by time, as `gcDevVersions` keeps the newest. */
function developmentVersion(): string {
  return `dev-${Date.now()}`
}

/**
 * Install a local build of `install.packageName` from its ZIP at `bundleUrl` (see the module comment), never asking.
 * The build is downloaded, verified and unpacked first; only then does a running copy of the package stop, so a
 * download that fails leaves it running what it ran. Once the files commit it starts again, background and screen, on
 * the new build. Launches wait while it stops and commits.
 */
export async function installLocalBuild(bundleUrl: string, install: LocalBuildInstall): Promise<void> {
  const {packageName} = install
  if (!isDevMiniappAllowed(packageName)) throw new Error("This deployment does not allow miniapp development")
  const assertCurrent = () => {
    if (install.isCancelled?.()) throw new MiniappInstallCancelledError(packageName)
  }
  let endUpdate: (() => void) | undefined
  let resumeLaunches: (() => void) | undefined
  let restart = false
  try {
    const installed = await appRegistry.installFromUrl(bundleUrl, {
      expectedPackageName: packageName,
      expectedVersion: install.version,
      ...(install.sha256 ? {expectedBundleSha256: install.sha256} : {}),
      versionOverride: developmentVersion(),
      // Without a served hash, the installer records the downloaded ZIP's.
      releaseIdentity: {
        source: "local",
        ...(install.sourceUrl ? {sourceUrl: install.sourceUrl} : {}),
        ...(install.sha256 ? {bundleSha256: install.sha256} : {}),
        ...(install.reloadUrl ? {reloadUrl: install.reloadUrl} : {}),
      },
      ...(install.downloadBundle ? {downloadBundle: install.downloadBundle} : {}),
      // Staged: the new build is on the phone and passed every check. The tile shows as updating only from here,
      // while the running copy stops and the files commit, not for the whole download.
      whenStaged: async () => {
        assertCurrent()
        endUpdate = useAppStatusStore.getState().beginUpdate(packageName)
        resumeLaunches = await miniappLauncher.pauseLaunches(packageName)
        restart = miniappLauncher.isRunning(packageName)
        if (restart) await miniappLauncher.stop(packageName)
      },
      beforeActivate: assertCurrent,
    })
    if (installed.is_error()) throw installed.error
    appRegistry.gcDevVersions(packageName, 1)
  } finally {
    resumeLaunches?.()
    endUpdate?.()
    // What was running starts again, on the new build if it committed and on the one it had otherwise. A mounted
    // screen follows the registry to the new build by itself (`MiniappView`).
    if (restart && !install.isCancelled?.() && !miniappLauncher.isRunning(packageName)) {
      try {
        await miniappLauncher.ensureRunning(packageName, undefined, {checkForUpdate: false})
      } catch (error) {
        console.warn(`Miniapp ${packageName} could not restart after its local build installed`, error)
      }
    }
  }
  await useAppStatusStore.getState().refresh()
}
