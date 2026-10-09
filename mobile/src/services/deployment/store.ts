import {storage} from "@/utils/storage/storage"

import type {
  ActiveDeployment,
  ConsumerDeployment,
  DeploymentCandidate,
  DeploymentManifest,
  OrganizationDeployment,
} from "./types"
import {withClearedDeploymentDebugOverrides} from "./debugOverrides"
import {PERSISTED_DEPLOYMENT_KIND, PERSISTED_ORIGIN_FIELD} from "./legacyPersistedNames"
import {createConsumerDeployment} from "./officialManifest"
import {deploymentManifestSchema} from "./schema"
import {validateDeploymentManifest} from "./resolver"

const ACTIVE_DEPLOYMENT_KEY = "mentra.deployment.active.v1"

/** Shape of a selected organization on disk. Builds that already shipped wrote these names. */
interface PersistedOrganizationDeployment {
  kind: typeof PERSISTED_DEPLOYMENT_KIND
  source: "manual"
  [PERSISTED_ORIGIN_FIELD]: string
  manifestUrl: string
  manifest: DeploymentManifest
  activatedAt: string
}

export type PersistedDeploymentSelection = ConsumerDeployment | PersistedOrganizationDeployment

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
  private selectingOrganization = false
  private readonly listeners = new Set<(deployment: ActiveDeployment, resolved: boolean) => void>()

  constructor(private readonly persistence: DeploymentStorage = new MmkvDeploymentStorage()) {
    const restored = restoreDeploymentSelection(persistence.load())
    this.active = restored ?? createConsumerDeployment()
    this.resolved = restored !== null
  }

  getActive(): ActiveDeployment {
    return this.active
  }

  /** False only while a fresh install is waiting for Mentra vs organization selection. */
  isResolved(): boolean {
    return this.resolved
  }

  /** True while the user is deliberately replacing a consumer selection. */
  isSelectingOrganization(): boolean {
    return this.selectingOrganization
  }

  /** Whether Mentra-owned telemetry may initialize for the current selection. */
  isTelemetryAllowed(): boolean {
    if (!this.resolved) return false
    return this.active.manifest.telemetry
  }

  async activate(candidate: DeploymentCandidate): Promise<OrganizationDeployment> {
    const deployment: OrganizationDeployment = {
      kind: "organization",
      source: "manual",
      organizationOrigin: candidate.organizationOrigin,
      manifestUrl: candidate.manifestUrl,
      manifest: candidate.manifest,
      activatedAt: new Date().toISOString(),
    }
    await withClearedDeploymentDebugOverrides(() => this.persistence.save(toPersistedSelection(deployment)))
    this.selectingOrganization = false
    this.setActive(deployment)
    return deployment
  }

  async returnToMentra(): Promise<void> {
    // Login buttons also reconfirm an existing consumer after token expiry.
    // Only an actual deployment switch should discard its debug configuration.
    const deployment = createConsumerDeployment()
    if (this.active.kind === "organization" || this.selectingOrganization) {
      await withClearedDeploymentDebugOverrides(() => this.persistence.save(deployment))
    } else {
      this.persistence.save(deployment)
    }
    this.selectingOrganization = false
    this.setActive(deployment, true)
  }

  /** Upgrade an existing consumer login without treating restoration as a switch. */
  restoreConsumerSessionSelection(): void {
    if (this.active.kind !== "consumer" || this.resolved || this.selectingOrganization) return
    this.persistence.save(this.active)
    this.setActive(this.active, true)
  }

  /** Enter discovery without allowing cached consumer credentials to opt back in. */
  async beginOrganizationSelection(): Promise<void> {
    await withClearedDeploymentDebugOverrides(() => this.persistence.remove())
    this.selectingOrganization = true
    this.setActive(createConsumerDeployment(), false)
  }

  /** Return to the neutral selector without opting into consumer telemetry. */
  async clearSelection(): Promise<void> {
    await withClearedDeploymentDebugOverrides(() => this.persistence.remove())
    this.selectingOrganization = false
    this.setActive(createConsumerDeployment(), false)
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

function toPersistedSelection(deployment: ActiveDeployment): PersistedDeploymentSelection {
  if (deployment.kind === "consumer") return deployment
  return {
    kind: PERSISTED_DEPLOYMENT_KIND,
    source: deployment.source,
    [PERSISTED_ORIGIN_FIELD]: deployment.organizationOrigin,
    manifestUrl: deployment.manifestUrl,
    manifest: deployment.manifest,
    activatedAt: deployment.activatedAt,
  }
}

function restoreDeploymentSelection(value: unknown): ActiveDeployment | null {
  if (!value || typeof value !== "object") return null
  const persisted = value as Partial<ConsumerDeployment>
  if (persisted.kind === "consumer" && persisted.source === "embedded") return createConsumerDeployment()

  const candidate = value as Partial<PersistedOrganizationDeployment>
  const origin = candidate[PERSISTED_ORIGIN_FIELD]
  if (
    candidate.kind !== PERSISTED_DEPLOYMENT_KIND ||
    candidate.source !== "manual" ||
    typeof origin !== "string" ||
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
    const organizationOrigin = new URL(origin)
    const manifestUrl = new URL(candidate.manifestUrl)
    if (
      organizationOrigin.origin !== origin ||
      manifestUrl.origin !== origin ||
      manifestUrl.pathname !== "/.well-known/mentra-deployment.json"
    ) {
      return null
    }
    validateDeploymentManifest(parsedManifest.data, origin)
  } catch {
    return null
  }
  return {
    kind: "organization",
    source: "manual",
    organizationOrigin: origin,
    manifestUrl: candidate.manifestUrl,
    manifest: parsedManifest.data,
    activatedAt: candidate.activatedAt,
  }
}

export const deploymentStore = new DeploymentStore()
