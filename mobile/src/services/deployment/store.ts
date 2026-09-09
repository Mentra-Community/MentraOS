import {storage} from "@/utils/storage/storage"

import type {ActiveDeployment, DeploymentCandidate, WorkspaceDeployment} from "./types"
import {clearDeploymentDebugOverrides} from "./debugOverrides"
import {createConsumerDeployment} from "./officialManifest"
import {deploymentManifestSchema} from "./schema"
import {validateDeploymentManifest} from "./resolver"

const ACTIVE_DEPLOYMENT_KEY = "mentra.deployment.active.v1"
type PersistedDeploymentSelection = ActiveDeployment

export interface DeploymentStorage {
  load(): unknown | null
  save(value: PersistedDeploymentSelection): void
  remove(): void
}

class MmkvDeploymentStorage implements DeploymentStorage {
  load(): unknown | null {
    const result = storage.load<unknown>(ACTIVE_DEPLOYMENT_KEY)
    return result.is_ok() ? result.value : null
  }

  save(value: PersistedDeploymentSelection): void {
    // Consumer defaults belong to this build, never to a persisted snapshot.
    const result = storage.save(
      ACTIVE_DEPLOYMENT_KEY,
      value.kind === "consumer" ? {kind: "consumer", source: "embedded"} : value,
    )
    if (result.is_error()) throw result.error
  }

  remove(): void {
    const result = storage.remove(ACTIVE_DEPLOYMENT_KEY)
    if (result.is_error()) throw result.error
  }
}

export class DeploymentStore {
  private active: ActiveDeployment
  private resolved: boolean
  private selectingWorkspace = false
  private readonly listeners = new Set<(deployment: ActiveDeployment, resolved: boolean) => void>()

  constructor(private readonly persistence: DeploymentStorage = new MmkvDeploymentStorage()) {
    const restored = restoreDeploymentSelection(persistence.load())
    this.active = restored ?? createConsumerDeployment()
    this.resolved = restored !== null
  }

  getActive(): ActiveDeployment {
    return this.active
  }

  /** False only while a fresh install is waiting for Mentra vs workspace selection. */
  isResolved(): boolean {
    return this.resolved
  }

  /** True while the user is deliberately replacing a consumer selection. */
  isSelectingWorkspace(): boolean {
    return this.selectingWorkspace
  }

  /** Whether Mentra-owned telemetry may initialize for the current selection. */
  isTelemetryAllowed(): boolean {
    if (!this.resolved) return false
    return this.active.manifest.telemetry
  }

  activate(candidate: DeploymentCandidate): WorkspaceDeployment {
    const deployment: WorkspaceDeployment = {
      kind: "workspace",
      source: "manual",
      workspaceOrigin: candidate.workspaceOrigin,
      manifestUrl: candidate.manifestUrl,
      manifest: candidate.manifest,
      activatedAt: new Date().toISOString(),
    }
    this.persistence.save(deployment)
    this.selectingWorkspace = false
    this.setActive(deployment)
    return deployment
  }

  returnToMentra(): void {
    const deployment = createConsumerDeployment()
    this.persistence.save(deployment)
    this.selectingWorkspace = false
    this.setActive(deployment, true)
  }

  /** Upgrade an existing consumer login without treating restoration as a switch. */
  restoreConsumerSessionSelection(): void {
    if (this.active.kind !== "consumer" || this.resolved || this.selectingWorkspace) return
    this.persistence.save(this.active)
    this.setActive(this.active, true, false)
  }

  /** Enter discovery without allowing cached consumer credentials to opt back in. */
  beginWorkspaceSelection(): void {
    this.persistence.remove()
    this.selectingWorkspace = true
    this.setActive(createConsumerDeployment(), false)
  }

  /** Return to the neutral selector without opting into consumer telemetry. */
  clearSelection(): void {
    this.persistence.remove()
    this.selectingWorkspace = false
    this.setActive(createConsumerDeployment(), false)
  }

  subscribe(listener: (deployment: ActiveDeployment, resolved: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setActive(deployment: ActiveDeployment, resolved = true, clearOverrides = true): void {
    if (clearOverrides) clearDeploymentDebugOverrides()
    this.active = deployment
    this.resolved = resolved
    for (const listener of this.listeners) listener(deployment, resolved)
  }
}

function restoreDeploymentSelection(value: unknown): PersistedDeploymentSelection | null {
  if (!value || typeof value !== "object") return null
  const persisted = value as Partial<PersistedDeploymentSelection>
  if (persisted.kind === "consumer" && persisted.source === "embedded") return createConsumerDeployment()

  const candidate = value as Partial<WorkspaceDeployment>
  if (
    candidate.kind !== "workspace" ||
    candidate.source !== "manual" ||
    typeof candidate.workspaceOrigin !== "string" ||
    typeof candidate.manifestUrl !== "string" ||
    typeof candidate.activatedAt !== "string" ||
    !candidate.manifest ||
    candidate.manifest.schemaVersion !== 1
  ) {
    return null
  }
  const parsedManifest = deploymentManifestSchema.safeParse(candidate.manifest)
  if (!parsedManifest.success) return null
  try {
    const workspaceOrigin = new URL(candidate.workspaceOrigin)
    const manifestUrl = new URL(candidate.manifestUrl)
    if (
      workspaceOrigin.origin !== candidate.workspaceOrigin ||
      manifestUrl.origin !== candidate.workspaceOrigin ||
      manifestUrl.pathname !== "/.well-known/mentra-deployment.json"
    ) {
      return null
    }
    validateDeploymentManifest(parsedManifest.data, candidate.workspaceOrigin)
  } catch {
    return null
  }
  return {...(candidate as WorkspaceDeployment), manifest: parsedManifest.data}
}

export const deploymentStore = new DeploymentStore()
