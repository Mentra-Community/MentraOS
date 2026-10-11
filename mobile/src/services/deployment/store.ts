import {storage} from "@/utils/storage/storage"

import type {ActiveDeployment, DeploymentCandidate, DeploymentManifest, WorkspaceDeployment} from "./types"
import {withClearedDeploymentDebugOverrides} from "./debugOverrides"
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
  /** The workspace manifest last saved; a running session may run on part of it until the next start. */
  private savedManifest: DeploymentManifest | null
  private readonly listeners = new Set<(deployment: ActiveDeployment, resolved: boolean) => void>()

  constructor(private readonly persistence: DeploymentStorage = new MmkvDeploymentStorage()) {
    const restored = restoreDeploymentSelection(persistence.load())
    this.active = restored ?? createConsumerDeployment()
    this.resolved = restored !== null
    this.savedManifest = restored?.kind === "workspace" ? restored.manifest : null
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

  async activate(candidate: DeploymentCandidate): Promise<WorkspaceDeployment> {
    const deployment: WorkspaceDeployment = {
      kind: "workspace",
      source: "manual",
      workspaceOrigin: candidate.workspaceOrigin,
      manifestUrl: candidate.manifestUrl,
      manifest: candidate.manifest,
      activatedAt: new Date().toISOString(),
    }
    await withClearedDeploymentDebugOverrides(() => this.persistence.save(deployment))
    this.selectingWorkspace = false
    this.savedManifest = deployment.manifest
    this.setActive(deployment)
    return deployment
  }

  async returnToMentra(): Promise<void> {
    // Login buttons also reconfirm an existing consumer after token expiry.
    // Only an actual deployment switch should discard its debug configuration.
    const deployment = createConsumerDeployment()
    if (this.active.kind === "workspace" || this.selectingWorkspace) {
      await withClearedDeploymentDebugOverrides(() => this.persistence.save(deployment))
    } else {
      this.persistence.save(deployment)
    }
    this.selectingWorkspace = false
    this.savedManifest = null
    this.setActive(deployment, true)
  }

  /** Upgrade an existing consumer login without treating restoration as a switch. */
  restoreConsumerSessionSelection(): void {
    if (this.active.kind !== "consumer" || this.resolved || this.selectingWorkspace) return
    this.persistence.save(this.active)
    this.setActive(this.active, true)
  }

  /** Enter discovery without allowing cached consumer credentials to opt back in. */
  async beginWorkspaceSelection(): Promise<void> {
    await withClearedDeploymentDebugOverrides(() => this.persistence.remove())
    this.selectingWorkspace = true
    this.savedManifest = null
    this.setActive(createConsumerDeployment(), false)
  }

  /** Return to the neutral selector without opting into consumer telemetry. */
  async clearSelection(): Promise<void> {
    await withClearedDeploymentDebugOverrides(() => this.persistence.remove())
    this.selectingWorkspace = false
    this.savedManifest = null
    this.setActive(createConsumerDeployment(), false)
  }

  /**
   * Adopt the workspace's current manifest for the selection it was fetched for.
   *
   * Only a manifest with the same deployment, Core, Runtime and sign-in
   * configuration is adopted; those identify the stored session, which carries
   * over. It is saved whole. Before Engine starts it becomes the active
   * deployment; a running session takes only its miniapp catalog and
   * presentation, and the rest applies when Engine next starts.
   */
  adoptRefreshedManifest(
    expected: WorkspaceDeployment,
    manifest: DeploymentManifest,
    {running}: {running: boolean},
  ): RefreshedManifestOutcome {
    if (this.active !== expected) return "superseded"
    if (sameJson(this.savedManifest ?? expected.manifest, manifest)) return "unchanged"
    if (!keepsWorkspaceSession(expected.manifest, manifest)) return "sign-in-changed"
    this.persistence.save({...expected, manifest})
    this.savedManifest = manifest
    const next = running ? withLiveChanges(expected.manifest, manifest) : manifest
    if (sameJson(next, expected.manifest)) return "saved-for-next-start"
    this.setActive({...expected, manifest: next})
    return "updated"
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

export type RefreshedManifestOutcome =
  | "updated"
  | "saved-for-next-start"
  | "unchanged"
  | "sign-in-changed"
  | "superseded"

/** The stored Entra account and Cloud session belong to these fields. */
function keepsWorkspaceSession(current: DeploymentManifest, next: DeploymentManifest): boolean {
  return (
    current.deploymentId === next.deploymentId &&
    current.services.coreUrl === next.services.coreUrl &&
    current.services.runtimeUrl === next.services.runtimeUrl &&
    sameJson(withScopeSets(current.auth), withScopeSets(next.auth))
  )
}

/** Scopes are requested as a set, so their order is not part of the sign-in. */
function withScopeSets(auth: DeploymentManifest["auth"]): DeploymentManifest["auth"] {
  if (auth.mode !== "microsoft-entra") return auth
  return {...auth, sessionScopes: [...auth.sessionScopes].sort(), teamsScopes: [...auth.teamsScopes].sort()}
}

/**
 * What a running session adopts from a refreshed manifest: its miniapp catalog,
 * which installs as miniapps can be replaced, and its presentation. Feature
 * switches, OTA, telemetry, glasses and system-miniapp policy were set up when
 * Engine started, so they stay until it starts again.
 */
function withLiveChanges(running: DeploymentManifest, next: DeploymentManifest): DeploymentManifest {
  const {branding: _branding, ...rest} = running
  return {
    ...rest,
    ...(next.branding ? {branding: next.branding} : {}),
    displayName: next.displayName,
    links: next.links,
    content: next.content,
    miniapps: next.miniapps,
  }
}

/** Structural equality for schema-parsed manifest values, independent of key order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const leftKeys = Object.keys(left)
  const rightRecord = right as Record<string, unknown>
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameJson((left as Record<string, unknown>)[key], rightRecord[key]),
    )
  )
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
