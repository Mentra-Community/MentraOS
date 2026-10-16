import {resolveDeploymentCandidate} from "./resolver"
import {deploymentStore, type DeploymentStore, type RefreshedManifestOutcome} from "./store"
import type {DeploymentCandidate, WorkspaceDeployment} from "./types"

/** Launch waits this long for the manifest before starting with the saved copy. */
const LAUNCH_WAIT_MS = 3_000

export type WorkspaceManifestRefresh =
  | RefreshedManifestOutcome
  | "not-workspace"
  | "unavailable"
  | "finishing-in-background"

export interface RefreshWorkspaceManifestOptions {
  /** True once Engine has started from the saved manifest (a warm relaunch, background recovery, a late fetch). */
  isRunning: () => boolean
  /**
   * Reconciles a running session with the active deployment's miniapp catalog:
   * after an update, and again for an unchanged manifest, in case an earlier
   * reconciliation (a failed download, say) did not finish.
   */
  reconcile: () => Promise<void> | void
  waitMs?: number
  store?: DeploymentStore
  resolve?: (workspaceOrigin: string) => Promise<DeploymentCandidate>
}

/**
 * Re-read the selected workspace's manifest at launch, so miniapps and features
 * its administrator added reach the phone without signing in again.
 *
 * Launch waits up to `waitMs` so Engine can start from the new manifest. When
 * Engine is already running, its miniapp catalog applies now (an open miniapp
 * asks before it updates) and the rest at Engine's next start. A failure keeps
 * the saved manifest.
 */
export async function refreshWorkspaceManifest(
  options: RefreshWorkspaceManifestOptions,
): Promise<WorkspaceManifestRefresh> {
  const store = options.store ?? deploymentStore
  const deployment = store.getActive()
  if (deployment.kind !== "workspace") return "not-workspace"
  const revision = store.currentRevision()
  const resolve =
    options.resolve ?? ((origin: string) => resolveDeploymentCandidate(origin, {allowInsecureLocalhost: __DEV__}))

  const applied = Promise.resolve()
    .then(() => resolve(deployment.workspaceOrigin))
    .then(
      (candidate) => adopt(store, deployment, revision, candidate, options),
      (error: unknown) => {
        console.warn("DEPLOYMENT: workspace manifest refresh failed; using the saved manifest", error)
        return "unavailable" as const
      },
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<"finishing-in-background">((done) => {
    timer = setTimeout(() => done("finishing-in-background"), options.waitMs ?? LAUNCH_WAIT_MS)
  })
  const outcome = await Promise.race([applied, waited])
  clearTimeout(timer)
  if (outcome === "finishing-in-background") {
    void applied.then((late) => console.log(`DEPLOYMENT: workspace manifest refresh finished after launch: ${late}`))
  }
  return outcome
}

/** Never throws: launch continues with the saved manifest on any failure. */
async function adopt(
  store: DeploymentStore,
  deployment: WorkspaceDeployment,
  revision: number,
  candidate: DeploymentCandidate,
  {isRunning, reconcile}: Pick<RefreshWorkspaceManifestOptions, "isRunning" | "reconcile">,
): Promise<WorkspaceManifestRefresh> {
  let outcome: RefreshedManifestOutcome
  try {
    outcome = store.adoptRefreshedManifest(deployment, candidate.manifest, {running: isRunning(), revision})
  } catch (error) {
    console.warn("DEPLOYMENT: workspace manifest refresh failed; using the saved manifest", error)
    return "unavailable"
  }
  if (outcome === "updated" || outcome === "unchanged" || outcome === "saved-for-next-start") {
    try {
      await reconcile()
    } catch (error) {
      // The manifest is saved; the next launch reconciles from it.
      console.warn("DEPLOYMENT: running session could not reconcile its miniapps", error)
    }
  }
  return outcome
}
