import {storage} from "@/utils/storage/storage"

import type {ActiveDeployment, DeploymentCandidate, WorkspaceDeployment} from "./types"
import {deploymentManifestSchema} from "./schema"

const ACTIVE_DEPLOYMENT_KEY = "mentra.deployment.active.v1"
const CONSUMER_DEPLOYMENT: ActiveDeployment = Object.freeze({kind: "consumer", source: "embedded"})

export interface DeploymentStorage {
  load(): unknown | null
  save(value: WorkspaceDeployment): void
  remove(): void
}

class MmkvDeploymentStorage implements DeploymentStorage {
  load(): unknown | null {
    const result = storage.load<unknown>(ACTIVE_DEPLOYMENT_KEY)
    return result.is_ok() ? result.value : null
  }

  save(value: WorkspaceDeployment): void {
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
  private readonly listeners = new Set<(deployment: ActiveDeployment) => void>()

  constructor(private readonly persistence: DeploymentStorage = new MmkvDeploymentStorage()) {
    this.active = restoreWorkspaceDeployment(persistence.load()) ?? CONSUMER_DEPLOYMENT
  }

  getActive(): ActiveDeployment {
    return this.active
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
    this.persistence.remove()
    this.setActive(CONSUMER_DEPLOYMENT)
  }

  subscribe(listener: (deployment: ActiveDeployment) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setActive(deployment: ActiveDeployment): void {
    this.active = deployment
    for (const listener of this.listeners) listener(deployment)
  }
}

function restoreWorkspaceDeployment(value: unknown): WorkspaceDeployment | null {
  if (!value || typeof value !== "object") return null
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
