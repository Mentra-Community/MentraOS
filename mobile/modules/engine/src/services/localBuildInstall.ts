/**
 * Local-network builds (spec, "Local-network miniapps"): a miniapp a developer serves from their own machine.
 *
 * A local address has no domain, so nothing proves the package name such a build claims. It installs as a
 * development snapshot (`dev-*`) of that name, recorded `source: "local"`, beside any installed release of the name,
 * which it stands in for until a release install or an uninstall replaces it. Like every development build:
 *
 * - it is never registered and never updates from a URL;
 * - its data is apart from every other install of the name, and its tokens are marked as a local build's
 *   (`miniappDataPartition.ts`, `LocalMiniappRuntime.requestMiniappAuth`);
 * - its screen never shares an origin with a release of the name (`MiniappLauncher`);
 * - it never gets system privileges;
 * - the signing rule applies to its ZIP.
 *
 * With a development server (`development` in its `miniapp.json`, as `mentra dev` serves it), it loads live from
 * that server, which reloads it; the snapshot is what opens while the server is away. Without one, the snapshot is
 * the selected build.
 */
import {isDevMiniappAllowed} from "../runtime/bootstrap"
import {useAppStatusStore} from "../stores/apps"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {installWithRuntimeReload} from "../utils/storeInstallRuntime"
import appRegistry, {
  registerDevApp,
  unregisterDevApp,
  type DevAppRecord,
  type InstallBundleOptions,
} from "./AppRegistry"
import {miniappLauncher} from "./MiniappLauncher"
import {MiniappInstallCancelledError} from "./miniappReleaseInstall"

/** The development server a local build loads live from: its Home tile and routing record, less the package. */
export type LocalBuildServer = Omit<DevAppRecord, "packageName" | "sourcePackageName">

export interface LocalBuildInstall {
  packageName: string
  /** The version its `miniapp.json` names; its ZIP must name it too. It installs as a `dev-*` snapshot. */
  version: string
  /** Its address, as the person installed it: the `local` release's `sourceUrl`. */
  sourceUrl: string
  /** The ZIP's SHA-256, when its `miniapp.json` names one. */
  sha256?: string
  /** Its development server. */
  server?: LocalBuildServer
  compatibilityPolicy?: InstallBundleOptions["compatibilityPolicy"]
  /** Download the ZIP; by default, a plain download. */
  downloadBundle?: InstallBundleOptions["downloadBundle"]
  /** True once the install should stop. Nothing activates after that. */
  isCancelled?: () => boolean
}

/** A fresh development snapshot version. Sorted by time, as `gcDevVersions` keeps the newest. */
function snapshotVersion(): string {
  return `dev-${Date.now()}`
}

/**
 * Install a local-network build of `install.packageName` from its ZIP at `bundleUrl` (see the module comment). A
 * running copy of the package stops, and starts again on the new build; launches wait until the files commit.
 */
export async function installLocalBuild(bundleUrl: string, install: LocalBuildInstall): Promise<void> {
  const {packageName} = install
  if (!isDevMiniappAllowed(packageName)) throw new Error("This deployment does not allow miniapp development")
  // Checked before the files activate and again before each routing write: an install whose session ended
  // meanwhile selects nothing in a later one.
  const assertCurrent = () => {
    if (install.isCancelled?.()) throw new MiniappInstallCancelledError(packageName)
  }
  const version = snapshotVersion()
  await useAppStatusStore.getState().runUpdate(packageName, () =>
    installWithRuntimeReload(miniappLauncher, packageName, async () => {
      // A snapshot download an earlier development launch started must not land over this build.
      invalidateDevSnapshotRequests(packageName)
      const installed = await appRegistry.installFromUrl(bundleUrl, {
        expectedPackageName: packageName,
        expectedVersion: install.version,
        ...(install.sha256 ? {expectedBundleSha256: install.sha256} : {}),
        versionOverride: version,
        releaseIdentity: {
          source: "local",
          sourceUrl: install.sourceUrl,
          ...(install.sha256 ? {bundleSha256: install.sha256} : {}),
        },
        ...(install.compatibilityPolicy ? {compatibilityPolicy: install.compatibilityPolicy} : {}),
        ...(install.downloadBundle ? {downloadBundle: install.downloadBundle} : {}),
        beforeActivate: assertCurrent,
      })
      if (installed.is_error()) throw installed.error
      assertCurrent()
      // Live code from the server is unsigned, so it never runs under a package with a recorded publisher (a signed
      // snapshot records one): such a build runs its snapshot.
      if (install.server && !appRegistry.getPublisherKeyFingerprint(packageName)) {
        await registerDevApp({...install.server, packageName}, {assertCurrent})
      } else {
        unregisterDevApp(packageName)
        appRegistry.selectDevSnapshot(packageName, version)
      }
      appRegistry.gcDevVersions(packageName, 1)
    }),
  )
  await useAppStatusStore.getState().refresh()
}

/**
 * Run the package's installed release again in place of a development build of its name, as reinstalling the release
 * does: the current account's development selection and builds of the package go, and a running copy stops and starts
 * again on the release. A live context that still holds an earlier account's selection keeps it until it stops.
 */
export async function restoreInstalledRelease(
  packageName: string,
  options: {isCancelled?: () => boolean} = {},
): Promise<void> {
  const assertCurrent = () => {
    if (options.isCancelled?.()) throw new MiniappInstallCancelledError(packageName)
  }
  await installWithRuntimeReload(miniappLauncher, packageName, async () => {
    // Checked again once the restore holds the install queue, before anything is cleared.
    assertCurrent()
    if (!(await appRegistry.clearDevelopmentSelection(packageName, {assertCurrent}))) {
      console.warn(
        `${packageName}'s development build belongs to an earlier account's context; it stays until it stops`,
      )
    }
  })
  await useAppStatusStore.getState().refresh()
}
