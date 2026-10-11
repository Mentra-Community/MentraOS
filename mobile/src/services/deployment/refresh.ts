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
  /** False once Engine was configured from the saved manifest, e.g. by background recovery. */
  canApplyNow: () => boolean
  waitMs?: number
  store?: DeploymentStore
  resolve?: (workspaceOrigin: string) => Promise<DeploymentCandidate>
}

/**
 * Re-read the selected workspace's manifest at launch, so miniapps and features
 * its administrator added reach the phone without signing in again.
 *
 * A manifest that arrives within `waitMs`, before Engine is configured, applies
 * to this launch. A later one is saved for the next launch. A failure keeps the
 * saved manifest.
 */
export async function refreshWorkspaceManifest(
  options: RefreshWorkspaceManifestOptions,
): Promise<WorkspaceManifestRefresh> {
  const store = options.store ?? deploymentStore
  const deployment = store.getActive()
  if (deployment.kind !== "workspace") return "not-workspace"
  const resolve =
    options.resolve ?? ((origin: string) => resolveDeploymentCandidate(origin, {allowInsecureLocalhost: __DEV__}))

  const fetched = Promise.resolve()
    .then(() => resolve(deployment.workspaceOrigin))
    .then(
      (candidate) => ({candidate}),
      (error: unknown) => ({error}),
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), options.waitMs ?? LAUNCH_WAIT_MS)
  })
  const first = await Promise.race([fetched, waited])
  clearTimeout(timer)

  if (first === "timeout") {
    void fetched.then((result) => {
      const outcome = adopt(store, deployment, result, false)
      console.log(`DEPLOYMENT: workspace manifest refresh finished after launch: ${outcome}`)
    })
    return "finishing-in-background"
  }
  return adopt(store, deployment, first, options.canApplyNow())
}

/** Never throws: launch continues with the saved manifest on any failure. */
function adopt(
  store: DeploymentStore,
  deployment: WorkspaceDeployment,
  result: {candidate: DeploymentCandidate} | {error: unknown},
  activate: boolean,
): WorkspaceManifestRefresh {
  try {
    if ("error" in result) throw result.error
    return store.adoptRefreshedManifest(deployment, result.candidate.manifest, {activate})
  } catch (error) {
    console.warn("DEPLOYMENT: workspace manifest refresh failed; using the saved manifest", error)
    return "unavailable"
  }
}
