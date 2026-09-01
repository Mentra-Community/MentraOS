import {storage} from "@/utils/storage/storage"

import type {ActiveDeployment, ConsumerDeployment, DeploymentCandidate, WorkspaceDeployment} from "./types"
import {deploymentManifestSchema} from "./schema"

const ACTIVE_DEPLOYMENT_KEY = "mentra.deployment.active.v1"
const CONSUMER_DEPLOYMENT: ConsumerDeployment = Object.freeze({kind: "consumer", source: "embedded"})

type PersistedDeploymentSelection = ConsumerDeployment | WorkspaceDeployment

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
    const result = storage.save(ACTIVE_DEPLOYMENT_KEY, value)
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
  private readonly listeners = new Set<(deployment: ActiveDeployment, resolved: boolean) => void>()

  constructor(private readonly persistence: DeploymentStorage = new MmkvDeploymentStorage()) {
    const restored = restoreDeploymentSelection(persistence.load())
    this.active = restored ?? CONSUMER_DEPLOYMENT
    this.resolved = restored !== null
  }

  getActive(): ActiveDeployment {
    return this.active
  }

  /** False only while a fresh install is waiting for Mentra vs workspace selection. */
  isResolved(): boolean {
    return this.resolved
  }

  /** Whether Mentra-owned telemetry may initialize for the current selection. */
  isTelemetryAllowed(): boolean {
    if (!this.resolved) return false
    return this.active.kind === "consumer" || this.active.manifest.telemetry
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
    this.setActive(deployment)
    return deployment
  }

  returnToMentra(): void {
    this.persistence.save(CONSUMER_DEPLOYMENT)
    this.setActive(CONSUMER_DEPLOYMENT, true)
  }

  /** Return to the neutral selector without opting into consumer telemetry. */
  clearSelection(): void {
    this.persistence.remove()
    this.setActive(CONSUMER_DEPLOYMENT, false)
  }

  subscribe(listener: (deployment: ActiveDeployment, resolved: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setActive(deployment: ActiveDeployment, resolved = true): void {
    this.active = deployment
    this.resolved = resolved
    for (const listener of this.listeners) listener(deployment, resolved)
  }
}

function restoreDeploymentSelection(value: unknown): PersistedDeploymentSelection | null {
  if (!value || typeof value !== "object") return null
  const persisted = value as Partial<PersistedDeploymentSelection>
  if (persisted.kind === "consumer" && persisted.source === "embedded") return CONSUMER_DEPLOYMENT

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
  } catch {
    return null
  }
  return {...(candidate as WorkspaceDeployment), manifest: parsedManifest.data}
}

export const deploymentStore = new DeploymentStore()
