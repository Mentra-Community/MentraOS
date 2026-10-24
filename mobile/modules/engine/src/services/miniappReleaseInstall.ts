import type {FleetAssignmentReason} from "@mentra/cloud-protocol"
import {getConfigValues} from "../runtime/bootstrap"
import {useAppStatusStore} from "../stores/apps"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {installWithRuntimeReload, MiniappRunningError} from "../utils/storeInstallRuntime"
import appRegistry, {
  type InstallBundleOptions,
  type LocalZipInstallOptions,
  type MiniappAssignment,
  type MiniappInstallReason,
} from "./AppRegistry"
import {markMiniappUpdateDeferred} from "./deferredMiniappUpdates"
import {miniappLauncher} from "./MiniappLauncher"
import type {MiniappUrlResolution} from "./miniappUrlResolution"
import {
  canShowRunningUpdatePrompt,
  emitRunningUpdateFailed,
  forgetRunningUpdateDecline,
  requestRunningUpdatePrompt,
} from "./runningUpdatePrompt"

/**
 * A release archive: a URL the installer downloads, or a ZIP its caller already
 * downloaded and verified (a workspace's managed release).
 */
export type MiniappReleaseArchive =
  | string
  | ({localZipPath: string} & Pick<LocalZipInstallOptions, "adoptIdenticalInstalledVersion">)

type ArchiveInstaller = (options: InstallBundleOptions) => Promise<void>

function archiveInstaller(archive: MiniappReleaseArchive): ArchiveInstaller {
  return async (options) => {
    const result =
      typeof archive === "string"
        ? await appRegistry.installFromUrl(archive, options)
        : await appRegistry.installFromLocalZip(archive.localZipPath, {
            ...options,
            ...(archive.adoptIdenticalInstalledVersion !== undefined
              ? {adoptIdenticalInstalledVersion: archive.adoptIdenticalInstalledVersion}
              : {}),
          })
    if (result.is_error()) throw result.error
  }
}

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
  /** With `askIfRunning`: called when the staged release waits for the person's answer to its update prompt. */
  onAsking?: () => void
  /**
   * With `onlyIfStopped`: a package that is not installed may be installed
   * (a managed first install). It is silent: no updating state, no prompt.
   * Launches still wait while its files activate. An installed package
   * updates as usual.
   */
  firstInstall?: boolean
}

/** The session that requested an install ended before the release activated. */
export class MiniappInstallCancelledError extends Error {
  constructor(packageName: string) {
    super(`The update of ${packageName} was cancelled because its session ended`)
    this.name = "MiniappInstallCancelledError"
  }
}

/**
 * Shared release installation for QR, URL and workspace callers. The caller
 * authorizes the source; the archive goes through the one AppRegistry installer, which
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
 * - A managed first install (`firstInstall`) of a package that is not
 *   installed shows nothing and holds launches only while its files change.
 */
export async function installMiniappRelease(
  archive: MiniappReleaseArchive,
  options: ReleaseInstallOptions,
): Promise<void> {
  const {onlyIfStopped, askIfRunning, isCancelled, onAsking, firstInstall, ...requestedOptions} = options
  const packageName = options.expectedPackageName
  const install = archiveInstaller(archive)
  const assertCurrent = () => {
    if (isCancelled?.()) throw new MiniappInstallCancelledError(packageName)
  }
  // An explicit install is the user's choice; an automatic update changes no reason.
  const installReason =
    requestedOptions.installReason ?? (onlyIfStopped ? undefined : explicitInstallReason(requestedOptions))
  const reasonOptions: InstallBundleOptions = installReason ? {...requestedOptions, installReason} : requestedOptions
  // Only the activation hook is wrapped: a `whenStaged` hook moves unpacking
  // out of the serialized install queue, so it is never added here.
  const installOptions: InstallBundleOptions = isCancelled
    ? {
        ...reasonOptions,
        beforeActivate: () => {
          assertCurrent()
          reasonOptions.beforeActivate?.()
        },
      }
    : reasonOptions
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
        await install(installOptions)
      }),
    )
    await useAppStatusStore.getState().refresh()
    return
  }

  const installsFirst = firstInstall === true && appRegistry.getInstalledVersions(packageName).length === 0
  if (!installsFirst) assertStillInstalled(packageName)
  try {
    if (installsFirst) {
      await installFirstWhenIdle(install, installOptions, packageName)
    } else if (askIfRunning && miniappLauncher.isProjectedRunning(packageName)) {
      await installRunningUpdate(install, installOptions, packageName, options.expectedVersion, isCancelled, onAsking)
    } else {
      await installIdleUpdate(install, installOptions, packageName)
    }
  } catch (error) {
    if (error instanceof MiniappRunningError) markMiniappUpdateDeferred(packageName)
    throw error
  }
  // The update the person put off has installed: a later one asks afresh.
  forgetRunningUpdateDecline(packageName)
  await useAppStatusStore.getState().refresh()
}

/** Automatic updates replace an installed miniapp; they never bring back one the user removed. */
function assertStillInstalled(packageName: string): void {
  if (appRegistry.getInstalledVersions(packageName).length === 0) {
    throw new Error(`${packageName} is no longer installed`)
  }
}

function explicitInstallReason(options: InstallBundleOptions): Exclude<MiniappInstallReason, "assignment"> {
  switch (options.releaseIdentity?.source) {
    case "bundled_asset":
      return "bundled"
    case "deployment_manifest":
      return "manifest"
    default:
      return "explicit"
  }
}

/** A managed first install shows nothing: no updating state and no prompt. A launch waits only while it activates. */
function installFirstWhenIdle(
  install: ArchiveInstaller,
  options: InstallBundleOptions,
  packageName: string,
): Promise<void> {
  return miniappLauncher.installWhenIdle(packageName, (reserveActivation) =>
    install({
      ...options,
      beforeActivate: () => {
        options.beforeActivate?.()
        reserveActivation()
      },
    }),
  )
}

function installIdleUpdate(
  install: ArchiveInstaller,
  options: InstallBundleOptions,
  packageName: string,
): Promise<void> {
  return miniappLauncher.installWhenIdle(packageName, (reserveActivation) =>
    useAppStatusStore.getState().runUpdate(packageName, () =>
      install({
        ...options,
        beforeActivate: () => {
          options.beforeActivate?.()
          assertStillInstalled(packageName)
          reserveActivation()
        },
      }),
    ),
  )
}

async function installRunningUpdate(
  install: ArchiveInstaller,
  options: InstallBundleOptions,
  packageName: string,
  version: string,
  isCancelled: (() => boolean) | undefined,
  onAsking: (() => void) | undefined,
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
    await install({
      ...options,
      whenStaged: async () => {
        assertCurrent()
        await options.whenStaged?.()
        // The download, signer, version and compatibility checks have passed
        // and the files are unpacked; nothing is reserved yet. If the user
        // closed the miniapp meanwhile, it updates like an idle one.
        if (miniappLauncher.isRunning(packageName)) {
          if (canShowRunningUpdatePrompt(packageName)) onAsking?.()
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

// ---- Managed (Fleet) installs -----------------------------------------------------------------------------------

/** Why a managed install did not commit: an assignment reason, or it waits (`running`) or was superseded. */
export type ManagedInstallFailure = FleetAssignmentReason | "running" | "cancelled"

/** Map an installer error to a stable reason. Never error text. */
export function classifyManagedInstallError(error: unknown): {kind: ManagedInstallFailure; retryable: boolean} {
  if (error instanceof MiniappRunningError) return {kind: "running", retryable: true}
  if (error instanceof MiniappInstallCancelledError) return {kind: "cancelled", retryable: true}
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOSPC|no space|not enough space|disk is full|storage (is )?full|quota/i.test(message))
    return {kind: "storage_full", retryable: true}
  if (/signature|signer|unsigned bundle|publisher/i.test(message)) return {kind: "signature_invalid", retryable: false}
  if (/is already installed/.test(message)) return {kind: "newer_version_installed", retryable: false}
  if (/Requires Mentra App|Built for SDK|Mentra App version|Miniapp SDK version|not compatible/i.test(message))
    return {kind: "incompatible_host", retryable: false}
  if (/bundle version mismatch|SHA-256 mismatch/i.test(message)) return {kind: "download_failed", retryable: true}
  if (
    /package mismatch|miniapp\.json|UNZIP_FAILED|READ_MANIFEST_FAILED|invalid miniapp version|bundle (exceeds|must be|contains)/i.test(
      message,
    )
  )
    return {kind: "not_a_miniapp", retryable: false}
  return {kind: "download_failed", retryable: true}
}

export interface ManagedMiniappInstall {
  resolution: Extract<MiniappUrlResolution, {ok: true}>
  assignment: MiniappAssignment
  /** True once the account, Core or workspace that asked for it is no longer current. Nothing then commits. */
  isCancelled: () => boolean
  /** Called when the install waits for the person's answer to its update prompt. */
  onAsking?: () => void
}

/**
 * Install or update an assigned miniapp through the one installer. A first install is silent; an update of a
 * running miniapp stages first and asks, and waits for it to stop when the prompt is not shown or is declined.
 * The `assignment` reason commits with the bundle; provenance stays `direct_download` (a URL install).
 */
export async function installManagedMiniapp({
  resolution,
  assignment,
  isCancelled,
  onAsking,
}: ManagedMiniappInstall): Promise<void> {
  const {hostVersion, supportedMiniappSdkRange} = getConfigValues()
  await installMiniappRelease(resolution.bundleUrl, {
    expectedPackageName: resolution.packageName,
    expectedVersion: resolution.version,
    expectedBundleSha256: resolution.bundleSha256,
    releaseIdentity: {source: "direct_download", bundleSha256: resolution.bundleSha256},
    installReason: "assignment",
    assignment,
    onlyIfStopped: true,
    askIfRunning: true,
    firstInstall: true,
    isCancelled,
    onAsking,
    ...(hostVersion && supportedMiniappSdkRange
      ? {compatibilityPolicy: {hostVersion, supportedSdkRange: supportedMiniappSdkRange}}
      : {}),
  })
}

/** Uninstall a withdrawn miniapp. Its data stays in its partition for a later reinstall. */
export async function uninstallManagedMiniapp(packageName: string): Promise<void> {
  const result = await useAppStatusStore.getState().uninstall(packageName)
  if (result.is_error()) throw result.error
}

/**
 * The miniapp's server stopped admitting this account: block its launch and stop its running code now, whatever
 * its reasons. Not deferred like an update. Nothing is uninstalled.
 */
export async function stopMiniappForRevocation(packageName: string): Promise<void> {
  appRegistry.revokeMiniappAccess(packageName)
  const state = useAppStatusStore.getState()
  if (state.foregroundedPackage === packageName) state.clearForeground()
  await state.stop(packageName)
  if (miniappLauncher.isRunning(packageName)) await miniappLauncher.stop(packageName)
  await useAppStatusStore.getState().refresh()
}
