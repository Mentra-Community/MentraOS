/**
 * Runs the app's assignment reconciler over the engine: `installMiniapp`, the registry's installation reasons, the
 * running-miniapp registry, the Core session, the Fleet revision signal and the data partitions.
 *
 * Each assigned miniapp installs headlessly through `installMiniapp(url, {source: "assignment"})`, like any install
 * from a URL: no install sheet, its URL registered, and a private server's sign-in challenge answered with the
 * package's miniapp token, which Core makes name the assigning workspace. Reading what a URL serves answers the
 * challenge the same way.
 *
 * The desired-state client is the caller's (`DesiredStateClient`): the engine starts this with it once the client
 * exists. Never throws.
 */
import NetInfo from "@react-native-community/netinfo"
import {normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"
import {AppState} from "react-native"

import {isInstalledMiniappAllowed} from "../../runtime/bootstrap"
import {MiniappRunningError} from "../../utils/storeInstallRuntime"
import {BgTimer} from "../../utils/timers"
import appRegistry from "../AppRegistry"
import {cloudClientService} from "../CloudClientService"
import {installMiniapp, InstallMiniappError} from "../installMiniapp"
import {setFleetWorkspace} from "../miniappDataPartition"
import {miniappLauncher} from "../MiniappLauncher"
import {classifyManagedInstallError, stopMiniappForRevocation, uninstallManagedMiniapp} from "../miniappReleaseInstall"
import {resolveMiniappUrl} from "../miniappUrlResolution"
import {miniappContextRegistry, miniappRunningRegistry} from "../MiniappRunningRegistry"
import {dismissRunningUpdatePrompt, onRunningUpdatePromptDue} from "../runningUpdatePrompt"
import {
  createAssignmentReconciler,
  type AssignmentReconciler,
  type DesiredStateClient,
  type ManagedInstallFailure,
  type ManagedMiniappPort,
  type ReconcilerSession,
} from "./assignmentReconciler"
import {emitAssignmentOutcome, onFleetRevision} from "./fleetRevisionSignal"
import {setFleetManagementState} from "./fleetManagementState"
import {getFleetStore} from "./fleetStorage"

function currentSession(): ReconcilerSession | null {
  const session = cloudClientService.getCoreSession()
  return session?.mentraUserId ? {coreUrl: session.coreUrl, mentraUserId: session.mentraUserId} : null
}

/**
 * The active installed release (not a development build): what an assignment is compared with. The installer still
 * refuses a version below any release on disk.
 */
function installedRelease(packageName: string): {version: string; bundleSha256?: string} | null {
  const version = appRegistry.getActiveReleaseVersion(packageName)
  if (!version) return null
  const sha = appRegistry.getReleaseIdentity(packageName, version)?.bundleSha256
  return sha ? {version, bundleSha256: sha} : {version}
}

/**
 * The deployment lets the release run as this assignment's: the release on disk when it has these bytes, otherwise
 * one `installMiniapp` installs from the assignment's URL. The workspace that assigns it is the account's current one.
 */
function allowsRelease(packageName: string, version: string, bundleSha256: string, url: string): boolean {
  const onDisk = appRegistry.getInstalledVersions(packageName).includes(version)
    ? appRegistry.getReleaseIdentity(packageName, version)
    : null
  const sameBytes = onDisk && (!onDisk.bundleSha256 || onDisk.bundleSha256 === bundleSha256)
  const fromUrl = {source: "url", sourceUrl: normalizeMiniappUrl(url)?.url ?? url, bundleSha256}
  return isInstalledMiniappAllowed(packageName, version, sameBytes ? onDisk : fromUrl, {assigned: true})
}

/** `installMiniapp` kept a newer release of the package, installed since the reconciler compared versions. */
class NewerReleaseInstalled extends Error {
  constructor(packageName: string, version: string) {
    super(`${packageName} ${version} is installed already, newer than its assignment's release`)
    this.name = "NewerReleaseInstalled"
  }
}

/**
 * Install an assignment headlessly through `installMiniapp`: no install sheet, and a running miniapp's update waits
 * for it to stop or for the person's answer to its prompt. Rejects when nothing committed.
 */
export async function installAssignment({
  resolution,
  assignment,
  isCancelled,
  onAsking,
}: Parameters<ManagedMiniappPort["install"]>[0]): Promise<{version: string}> {
  const result = await installMiniapp(assignment.url, {
    source: "assignment",
    assignment,
    expectedPackageName: resolution.packageName,
    isCancelled,
    ...(onAsking ? {onAsking} : {}),
  })
  if (result.status === "deferred") throw new MiniappRunningError(result.packageName)
  if (result.status === "opened") throw new NewerReleaseInstalled(result.packageName, result.version)
  return {version: result.version}
}

/** Map an assignment install's failure to its assignment reason. Never error text. */
export function classifyAssignmentInstallError(error: unknown): {kind: ManagedInstallFailure; retryable: boolean} {
  if (error instanceof NewerReleaseInstalled) return {kind: "newer_version_installed", retryable: false}
  if (!(error instanceof InstallMiniappError)) return classifyManagedInstallError(error)
  switch (error.code) {
    case "archived":
      return {kind: "archived", retryable: false}
    // A package name its domain doesn't own is not a miniapp that URL may serve.
    case "not_a_miniapp":
    case "domain_mismatch":
      return {kind: "not_a_miniapp", retryable: false}
    // The server refused the account. Headless installs gate age at first open, so this is never reached for age.
    case "access_denied":
    case "age_restricted":
      return {kind: "access_denied", retryable: false}
    case "needs_newer_app":
      return {kind: "incompatible_host", retryable: false}
    case "signature_invalid":
      return {kind: "signature_invalid", retryable: false}
    case "integrity":
      return {kind: "download_failed", retryable: true}
    case "cancelled":
      return {kind: "cancelled", retryable: true}
    case "network": {
      // A full disk shows only in the installer's message.
      const fromInstaller = classifyManagedInstallError(error)
      return fromInstaller.kind === "storage_full" ? fromInstaller : {kind: "download_failed", retryable: true}
    }
  }
}

const miniapps: ManagedMiniappPort = {
  resolve: (url) => resolveMiniappUrl(url),
  installedRelease: async (packageName) => installedRelease(packageName),
  hasOtherReason: (packageName) => appRegistry.getInstallReasons(packageName).some((reason) => reason !== "assignment"),
  assignment: (packageName) => appRegistry.getMiniappAssignment(packageName),
  assignedPackages: () => appRegistry.getAssignedPackages(),
  hasDevelopmentSelection: (packageName) => appRegistry.hasDevelopmentSelection(packageName),
  clearDevelopmentSelection: (packageName) => appRegistry.clearDevelopmentSelection(packageName),
  allowsRelease,
  install: installAssignment,
  classify: classifyAssignmentInstallError,
  setAssignment: (packageName, assignment) => appRegistry.setMiniappAssignment(packageName, assignment),
  clearAssignment: (packageName) => void appRegistry.clearMiniappAssignment(packageName),
  uninstall: uninstallManagedMiniapp,
  isRunning: (packageName) => miniappRunningRegistry.has(packageName) || miniappLauncher.isRunning(packageName),
  onStopped: (listener) => miniappContextRegistry.onRemoved(listener),
  onUpdateDue: onRunningUpdatePromptDue,
  revokeAccess: stopMiniappForRevocation,
  restoreAccess: (packageName) => appRegistry.restoreMiniappAccess(packageName),
  isAccessRevoked: (packageName) => appRegistry.isMiniappAccessRevoked(packageName),
  dismissUpdatePrompt: dismissRunningUpdatePrompt,
  setWorkspaceContext: (session, workspaceId) => setFleetWorkspace(session, workspaceId),
}

let reconciler: AssignmentReconciler | null = null
let online = true
const cleanups: (() => void)[] = []

/** Start reconciling with the desired-state client. Idempotent. */
export function startAssignmentReconciler(client: DesiredStateClient): void {
  if (reconciler) return
  try {
    reconciler = createAssignmentReconciler({
      client,
      miniapps,
      getSession: currentSession,
      isOnline: () => online && cloudClientService.hasCore(),
      store: getFleetStore(),
      emit: emitAssignmentOutcome,
      onManagementState: setFleetManagementState,
      timers: {
        setTimeout: (callback, ms) => BgTimer.setTimeout(callback, ms),
        clearTimeout: (handle) => BgTimer.clearTimeout(handle as number),
      },
    })
    const r = reconciler
    cleanups.push(onFleetRevision((revision) => r.trigger("revision", revision)))
    cleanups.push(
      cloudClientService.onCoreSessionChanged((change) => {
        if (change.reason === "reconnect") r.trigger("reconnect")
        else r.sessionChanged()
      }),
    )
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") r.trigger("foreground")
    })
    cleanups.push(() => subscription.remove())
    cleanups.push(
      NetInfo.addEventListener((net) => {
        const wasOnline = online
        online = net.isConnected !== false
        if (online && !wasOnline) r.trigger("reconnect")
      }),
    )
    r.trigger("startup")
  } catch (error) {
    console.warn("Fleet assignment reconciler did not start", error)
  }
}

/** The user left their workspace: stop its work now and read desired state at once. */
export function notifyFleetWorkspaceLeft(): void {
  reconciler?.trigger("leave")
}

/** Read desired state now (after a join), without waiting for an ack revision. Never throws. */
export function triggerAssignmentReconcile(): void {
  try {
    reconciler?.trigger("refresh")
  } catch (error) {
    console.warn("Fleet assignment reconcile could not be triggered", error)
  }
}

export function stopAssignmentReconciler(): void {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // A listener that cannot be removed is dropped with the reconciler.
    }
  }
  reconciler?.stop()
  reconciler = null
  setFleetManagementState({status: "unknown"})
}
