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

import {getConfigValues, isInstalledMiniappAllowed} from "../../runtime/bootstrap"
import {MiniappRunningError} from "../../utils/storeInstallRuntime"
import {BgTimer} from "../../utils/timers"
import appRegistry from "../AppRegistry"
import {cloudClientService} from "../CloudClientService"
import {installMiniapp, InstallMiniappError} from "../installMiniapp"
import {setFleetWorkspace} from "../miniappDataPartition"
import {miniappLauncher} from "../MiniappLauncher"
import {classifyManagedInstallError, stopMiniappForRevocation, uninstallManagedMiniapp} from "../miniappReleaseInstall"
import {miniappPins} from "../miniappPins"
import {resolveMiniappUrl} from "../miniappUrlResolution"
import {miniappUpdateUrl} from "../miniappUrlUpdates"
import {miniappContextRegistry, miniappRunningRegistry} from "../MiniappRunningRegistry"
import {dismissRunningUpdatePrompt, onRunningUpdatePromptDue} from "../runningUpdatePrompt"
import {isSystemMiniappPackage} from "../SystemMiniappPolicy"
import {firstPartyMiniappUrl} from "../systemMiniappTrust"
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

/** The active installed release (not a development build): what an assignment is compared with. */
function installedRelease(packageName: string): {version: string; bundleSha256?: string} | null {
  const version = appRegistry.getActiveReleaseVersion(packageName)
  if (!version) return null
  const sha = appRegistry.getReleaseIdentity(packageName, version)?.bundleSha256
  return sha ? {version, bundleSha256: sha} : {version}
}

/**
 * An installed system miniapp updates from its deployment's own miniapp host (`miniappUrlUpdates.ts`), not from the
 * URL that assigned it. When the two differ, an install from the assignment's URL would be replaced by the updater's
 * at its next check, and that one by the reconciler's, without end: each installs what its URL serves when the bytes
 * differ. The updater's URL decides, so the assignment is satisfied by what is installed.
 */
function updatesFromAnotherUrl(packageName: string, url: string): boolean {
  if (!isSystemMiniappPackage(packageName)) return false
  const version = appRegistry.getActiveReleaseVersion(packageName)
  if (!version) return false
  const from = miniappUpdateUrl(packageName, appRegistry.getReleaseIdentity(packageName, version), {
    isSystemPackage: isSystemMiniappPackage,
    firstPartyUrl: (name) => firstPartyMiniappUrl(getConfigValues(), name),
  })
  return from !== undefined && normalizeMiniappUrl(from)?.url !== (normalizeMiniappUrl(url)?.url ?? url)
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
  // An assignment install never answers `opened`: what the URL serves replaces what is installed.
  return {version: result.version}
}

/** Map an assignment install's failure to its assignment reason. Never error text. */
export function classifyAssignmentInstallError(error: unknown): {kind: ManagedInstallFailure; retryable: boolean} {
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
    // The pin can't be met (the URL changed its list since the reconciler resolved it): nothing installs until it
    // serves the pinned build again or the pin changes.
    case "pin_unlisted":
    case "pin_hash_changed":
      return {kind: error.code, retryable: false}
    // The person installed a development build meanwhile: only they replace it.
    case "development_build":
      return {kind: "development_build", retryable: false}
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

// The runtime holds the miniapps' configuration (managed settings). It loads when the reconciler first writes a
// workspace's values, so this module doesn't load the whole runtime where it is imported, in tests among them.
const miniappConfiguration = () =>
  (require("../LocalMiniappRuntime") as typeof import("../LocalMiniappRuntime")).default.configuration

const miniapps: ManagedMiniappPort = {
  // The resolution reads the package's pin, which the reconciler writes before it resolves.
  resolve: (url) => resolveMiniappUrl(url, undefined, miniappPins.pinFor),
  fleetPinnedPackages: () => miniappPins.fleetPinnedPackages(),
  setFleetPin: (packageName, pin) => miniappPins.setFleetPin(packageName, pin),
  installedRelease: async (packageName) => installedRelease(packageName),
  updatesFromAnotherUrl,
  hasOtherReason: (packageName) => appRegistry.getInstallReasons(packageName).some((reason) => reason !== "assignment"),
  assignment: (packageName) => appRegistry.getMiniappAssignment(packageName),
  assignedPackages: () => appRegistry.getAssignedPackages(),
  isDevelopmentBuild: (packageName) => appRegistry.isDevelopmentBuild(packageName),
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
  setWorkspaceConfiguration: (packageName, values, session) =>
    void miniappConfiguration().setWorkspace(packageName, values, session),
  configuredPackages: () => miniappConfiguration().workspacePackages(),
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
