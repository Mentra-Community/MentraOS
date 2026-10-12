import {useAppStatusStore} from "../stores/apps"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {installWithRuntimeReload, MiniappRunningError} from "../utils/storeInstallRuntime"
import appRegistry, {type InstallBundleOptions} from "./AppRegistry"
import {markMiniappUpdateDeferred} from "./deferredMiniappUpdates"
import {miniappLauncher} from "./MiniappLauncher"
import {canShowRunningUpdatePrompt, emitRunningUpdateFailed, requestRunningUpdatePrompt} from "./runningUpdatePrompt"

export interface ReleaseInstallOptions extends InstallBundleOptions {
  expectedPackageName: string
  expectedVersion: string
  /**
   * An automatic update: replace only an installed miniapp and never stop a
   * running one. A running or starting miniapp defers it with
   * {@link MiniappRunningError}; it resumes when the miniapp stops.
   */
  onlyIfStopped?: boolean
  /**
   * With `onlyIfStopped`: when the user is running the miniapp, stage the
   * release and ask whether to update now. Declined or unshown prompts defer.
   */
  askIfRunning?: boolean
  /**
   * True once the session that requested the install has ended (sign-out or a
   * deployment switch). The release is then never activated, no prompt is
   * shown, and nothing restarts into the ended session.
   */
  isCancelled?: () => boolean
}

/** The session that requested an install ended before the release activated. */
export class MiniappInstallCancelledError extends Error {
  constructor(packageName: string) {
    super(`The update of ${packageName} was cancelled because its session ended`)
    this.name = "MiniappInstallCancelledError"
  }
}

/**
 * Shared release installation for QR and Store callers. The caller authorizes
 * the source; the archive goes through the one AppRegistry installer, which
 * binds it to the expected package and version and applies the signer and
 * version rules again inside its serialized transaction.
 *
 * - Explicit installs stop a running miniapp, install, and restart it; its
 *   launches wait until the install commits or rolls back.
 * - Automatic updates of an idle miniapp mark it as updating before the
 *   download and hold launches only while its files change.
 * - Automatic updates of a running miniapp with `askIfRunning` download,
 *   verify and unpack first, then ask; on Update the miniapp closes, the
 *   release commits, and the miniapp reopens.
 */
export async function installMiniappRelease(bundleUrl: string, options: ReleaseInstallOptions): Promise<void> {
  const {onlyIfStopped, askIfRunning, isCancelled, ...requestedOptions} = options
  const packageName = options.expectedPackageName
  const assertCurrent = () => {
    if (isCancelled?.()) throw new MiniappInstallCancelledError(packageName)
  }
  // Only the activation hook is wrapped: a `whenStaged` hook moves unpacking
  // out of the serialized install queue, so it is never added here.
  const installOptions: InstallBundleOptions = isCancelled
    ? {
        ...requestedOptions,
        beforeActivate: () => {
          assertCurrent()
          requestedOptions.beforeActivate?.()
        },
      }
    : requestedOptions
  assertCurrent()
  // An early check avoids stopping or reserving an app for a known downgrade.
  // AppRegistry checks again in its serialized filesystem transaction.
  appRegistry.assertCanInstallVersion(packageName, options.expectedVersion)

  if (!onlyIfStopped) {
    await useAppStatusStore.getState().runUpdate(packageName, () =>
      installWithRuntimeReload(miniappLauncher, packageName, async () => {
        // A dev probe or snapshot started before this release must not
        // reactivate development code after it commits.
        invalidateDevSnapshotRequests(packageName)
        const result = await appRegistry.installFromUrl(bundleUrl, installOptions)
        if (result.is_error()) throw result.error
      }),
    )
    await useAppStatusStore.getState().refresh()
    return
  }

  assertStillInstalled(packageName)
  try {
    if (askIfRunning && miniappLauncher.isProjectedRunning(packageName)) {
      await installRunningUpdate(bundleUrl, installOptions, packageName, options.expectedVersion, isCancelled)
    } else {
      await installIdleUpdate(bundleUrl, installOptions, packageName)
    }
  } catch (error) {
    if (error instanceof MiniappRunningError) markMiniappUpdateDeferred(packageName)
    throw error
  }
  await useAppStatusStore.getState().refresh()
}

/** Automatic updates replace an installed miniapp; they never bring back one the user removed. */
function assertStillInstalled(packageName: string): void {
  if (appRegistry.getInstalledVersions(packageName).length === 0) {
    throw new Error(`${packageName} is no longer installed`)
  }
}

function installIdleUpdate(bundleUrl: string, options: InstallBundleOptions, packageName: string): Promise<void> {
  return miniappLauncher.installWhenIdle(packageName, (reserveActivation) =>
    useAppStatusStore.getState().runUpdate(packageName, async () => {
      const result = await appRegistry.installFromUrl(bundleUrl, {
        ...options,
        beforeActivate: () => {
          options.beforeActivate?.()
          assertStillInstalled(packageName)
          reserveActivation()
        },
      })
      if (result.is_error()) throw result.error
    }),
  )
}

async function installRunningUpdate(
  bundleUrl: string,
  options: InstallBundleOptions,
  packageName: string,
  version: string,
  isCancelled: (() => boolean) | undefined,
): Promise<void> {
  const assertCurrent = () => {
    if (isCancelled?.()) throw new MiniappInstallCancelledError(packageName)
  }
  // Do not download a release the user would not be asked about.
  if (!canShowRunningUpdatePrompt(packageName)) throw new MiniappRunningError(packageName)
  const displayName =
    useAppStatusStore.getState().apps.find((app) => app.packageName === packageName)?.name ?? packageName
  const installedVersion = (await appRegistry.getActiveVersion(packageName)) ?? ""

  let accepted = false
  let committed = false
  let endUpdate: (() => void) | undefined
  let resumeLaunches: (() => void) | undefined
  let stopped: {reopen: boolean} | undefined
  let failure: unknown
  try {
    const result = await appRegistry.installFromUrl(bundleUrl, {
      ...options,
      whenStaged: async () => {
        assertCurrent()
        await options.whenStaged?.()
        // The download, signer, version and compatibility checks have passed
        // and the files are unpacked; nothing is reserved yet. If the user
        // closed the miniapp meanwhile, it updates like an idle one.
        if (miniappLauncher.isRunning(packageName)) {
          const answer = await requestRunningUpdatePrompt({packageName, displayName, version})
          if (answer !== "update") throw new MiniappRunningError(packageName)
          assertCurrent()
          accepted = true
        }
        endUpdate = useAppStatusStore.getState().beginUpdate(packageName)
        resumeLaunches = await miniappLauncher.pauseLaunches(packageName)
        if (miniappLauncher.isRunning(packageName)) {
          // Started again without the user's consent to close it: defer.
          if (!accepted) throw new MiniappRunningError(packageName)
          const state = useAppStatusStore.getState()
          stopped = {reopen: state.foregroundedPackage === packageName}
          if (stopped.reopen) state.clearForeground()
          await state.stop(packageName)
          if (miniappLauncher.isRunning(packageName)) await miniappLauncher.stop(packageName)
        }
      },
      beforeActivate: () => {
        options.beforeActivate?.()
        assertStillInstalled(packageName)
        if (miniappLauncher.isRunning(packageName)) throw new Error(`${packageName} did not stop for its update`)
      },
    })
    if (result.is_error()) throw result.error
    committed = true
  } catch (error) {
    failure = error
  } finally {
    resumeLaunches?.()
    endUpdate?.()
  }

  // Reopen what the user had: the new release after a commit, otherwise the
  // version that is still installed. Nothing restarts into an ended session.
  const cancelled = isCancelled?.() === true
  if (stopped && !cancelled) await restartAfterUpdate(packageName, stopped.reopen)
  if (!committed && accepted && !cancelled) emitRunningUpdateFailed({packageName, displayName, installedVersion})
  if (!committed) throw failure
}

async function restartAfterUpdate(packageName: string, reopen: boolean): Promise<void> {
  try {
    await useAppStatusStore.getState().refresh()
    const app = useAppStatusStore.getState().apps.find((candidate) => candidate.packageName === packageName)
    if (!app) return
    const started = await useAppStatusStore.getState().start(app, {skipNavigation: true})
    if (started && reopen) await useAppStatusStore.getState().setForeground(packageName)
  } catch (error) {
    // A launch error is reported by the runtime; it does not undo a committed release.
    console.warn(`Miniapp ${packageName} could not restart after its update`, error)
  }
}
