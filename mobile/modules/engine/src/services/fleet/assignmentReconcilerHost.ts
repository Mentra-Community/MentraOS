/**
 * Runs the app's assignment reconciler over the engine: the release installer, the registry's installation reasons,
 * the running-miniapp registry, the Core session, the Fleet revision signal and the data partitions.
 *
 * The desired-state client is the caller's (`DesiredStateClient`): the engine starts this with it once the client
 * exists. Never throws.
 */
import NetInfo from "@react-native-community/netinfo"
import {AppState} from "react-native"
import semver from "semver"

import {BgTimer} from "../../utils/timers"
import appRegistry from "../AppRegistry"
import {cloudClientService} from "../CloudClientService"
import {setFleetWorkspace} from "../miniappDataPartition"
import {miniappLauncher} from "../MiniappLauncher"
import {
  classifyManagedInstallError,
  installManagedMiniapp,
  stopMiniappForRevocation,
  uninstallManagedMiniapp,
} from "../miniappReleaseInstall"
import {resolveMiniappUrl} from "../miniappUrlResolution"
import {miniappRunningRegistry} from "../MiniappRunningRegistry"
import {onRunningUpdatePromptDue} from "../runningUpdatePrompt"
import {
  createAssignmentReconciler,
  type AssignmentReconciler,
  type DesiredStateClient,
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

/** The newest released (non-development) version on disk: what an assignment is compared with. */
function installedRelease(packageName: string): {version: string; bundleSha256?: string} | null {
  const versions = appRegistry
    .getInstalledVersions(packageName)
    .filter((version) => !version.startsWith("dev-") && semver.valid(version))
    .sort(semver.rcompare)
  const version = versions[0]
  if (!version) return null
  const sha = appRegistry.getReleaseIdentity(packageName, version)?.bundleSha256
  return sha ? {version, bundleSha256: sha} : {version}
}

function onStopped(listener: (packageName: string) => void): () => void {
  let before = new Set(miniappRunningRegistry.getAll())
  return miniappRunningRegistry.subscribe(() => {
    const now = new Set(miniappRunningRegistry.getAll())
    for (const packageName of before) if (!now.has(packageName)) listener(packageName)
    before = now
  })
}

const miniapps: ManagedMiniappPort = {
  resolve: (url) => resolveMiniappUrl(url),
  installedRelease: async (packageName) => installedRelease(packageName),
  hasOtherReason: (packageName) => appRegistry.getInstallReasons(packageName).some((reason) => reason !== "assignment"),
  assignment: (packageName) => appRegistry.getMiniappAssignment(packageName),
  assignedPackages: () => appRegistry.getAssignedPackages(),
  hasDevelopmentSelection: (packageName) => appRegistry.hasDevelopmentSelection(packageName),
  clearDevelopmentSelection: (packageName) => appRegistry.clearDevelopmentSelection(packageName),
  install: (request) => installManagedMiniapp(request),
  classify: classifyManagedInstallError,
  setAssignment: (packageName, assignment) => appRegistry.setMiniappAssignment(packageName, assignment),
  clearAssignment: (packageName) => void appRegistry.clearMiniappAssignment(packageName),
  uninstall: uninstallManagedMiniapp,
  isRunning: (packageName) => miniappRunningRegistry.has(packageName) || miniappLauncher.isRunning(packageName),
  onStopped,
  onUpdateDue: onRunningUpdatePromptDue,
  revokeAccess: stopMiniappForRevocation,
  restoreAccess: (packageName) => appRegistry.restoreMiniappAccess(packageName),
  isAccessRevoked: (packageName) => appRegistry.isMiniappAccessRevoked(packageName),
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
