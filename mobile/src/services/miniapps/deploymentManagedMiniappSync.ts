import {appRegistry, sha256Hex} from "@mentra/engine-host-internal"
import {Directory, File, Paths} from "expo-file-system"

import {shouldSkipMiniappInstall} from "./miniappVisibility"
import type {ActiveDeployment, DeploymentManagedMiniapp} from "@/services/deployment"
import {deploymentStore} from "@/services/deployment/store"

import {preflightMiniappZip} from "./miniappZipPreflight"

const LOG_TAG = "DeploymentManagedMiniappSync"
const STATE_FILE_NAME = "deployment-managed-miniapps.json"
// Matches Runtime's managed-bundle ceiling. The archive is hashed in memory,
// so refuse oversized downloads before reading them.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

class SupersededSync extends Error {}

interface SyncContext {
  id: number
  signal: AbortSignal
  assertCurrent(): void
}

let nextSyncId = 0
let activeSync: AbortController | undefined
let reconciliation = Promise.resolve()

// Downloads may outlive cancellation in Expo. Stop waiting for them so a new
// workspace can proceed, but keep every registry/state mutation serialized.
async function waitForDownload<T>(download: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new SupersededSync())
    signal.addEventListener("abort", cancel, {once: true})
    if (signal.aborted) cancel()
    download.then(
      (value) => {
        signal.removeEventListener("abort", cancel)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", cancel)
        reject(error)
      },
    )
  })
}

type StorageScope = "consumer" | "workspace"

interface ManagedInstallRecord {
  storageScope?: StorageScope
  packageName: string
  version: string
  sha256: string
}

interface ManagedInstallState {
  schemaVersion: 1
  deploymentId: string
  workspaceOrigin: string
  entries: ManagedInstallRecord[]
}

function stateFile(): File {
  return new File(Paths.document, STATE_FILE_NAME)
}

function readState(): ManagedInstallState | null {
  const file = stateFile()
  if (!file.exists) return null
  try {
    const raw = JSON.parse(file.textSync()) as Partial<ManagedInstallState>
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.deploymentId !== "string" ||
      typeof raw.workspaceOrigin !== "string" ||
      !Array.isArray(raw.entries)
    ) {
      return null
    }
    if (
      raw.entries.some(
        (entry) =>
          !entry ||
          typeof entry.packageName !== "string" ||
          typeof entry.version !== "string" ||
          typeof entry.sha256 !== "string" ||
          (entry.storageScope !== undefined && entry.storageScope !== "consumer" && entry.storageScope !== "workspace"),
      )
    ) {
      return null
    }
    return raw as ManagedInstallState
  } catch (error) {
    console.warn(`${LOG_TAG}: ignoring unreadable ownership state`, error)
    return null
  }
}

function writeState(state: ManagedInstallState | null): void {
  const file = stateFile()
  if (!state) {
    if (file.exists) file.delete()
    return
  }
  file.write(JSON.stringify(state))
}

function recordKey(entry: ManagedInstallRecord): string {
  return `${entry.packageName}\0${entry.version}\0${entry.storageScope ?? "workspace"}`
}

function ownedStorageScope(
  deploymentId: string,
  workspaceOrigin: string,
  entry: ManagedInstallRecord,
): StorageScope | null {
  for (const scope of entry.storageScope ? [entry.storageScope] : (["workspace", "consumer"] as const)) {
    const identity = appRegistry.getReleaseIdentity(entry.packageName, entry.version, scope)
    if (
      identity?.source === "deployment_manifest" &&
      identity.deploymentId === deploymentId &&
      identity.deploymentOrigin === workspaceOrigin &&
      identity.bundleSha256 === entry.sha256.toLowerCase()
    )
      return scope
  }
  return null
}

function hasExactOwnership(deploymentId: string, workspaceOrigin: string, entry: ManagedInstallRecord): boolean {
  return ownedStorageScope(deploymentId, workspaceOrigin, entry) !== null
}

function discoverOwnedEntries(deploymentId: string, workspaceOrigin: string): ManagedInstallRecord[] {
  return appRegistry
    .getDeploymentOwnedReleases()
    .filter(({identity}) => identity.deploymentId === deploymentId && identity.deploymentOrigin === workspaceOrigin)
    .flatMap(({packageName, version, identity, storageScope}) =>
      identity.bundleSha256 ? [{packageName, version, storageScope, sha256: identity.bundleSha256.toLowerCase()}] : [],
    )
}

async function uninstallOwnedEntries(state: ManagedInstallState, context: SyncContext): Promise<boolean> {
  const entries = new Map<string, ManagedInstallRecord>()
  for (const entry of [...state.entries, ...discoverOwnedEntries(state.deploymentId, state.workspaceOrigin)]) {
    entries.set(recordKey(entry), entry)
  }
  for (const entry of entries.values()) {
    context.assertCurrent()
    if (!hasExactOwnership(state.deploymentId, state.workspaceOrigin, entry)) {
      console.warn(`${LOG_TAG}: refusing to remove unowned ${entry.packageName}@${entry.version}`)
      continue
    }
    const result = await appRegistry.uninstall(entry.packageName, entry.version, {
      storageScope: ownedStorageScope(state.deploymentId, state.workspaceOrigin, entry)!,
    })
    if (result.is_error()) {
      console.warn(`${LOG_TAG}: failed to remove ${entry.packageName}@${entry.version}`, result.error)
      return false
    }
  }
  return true
}

function removeCachedBundle(file: File): void {
  try {
    if (file.exists) file.delete()
  } catch {
    // Cache cleanup must never change the outcome of an installation.
  }
}

async function downloadVerifiedBundle(entry: DeploymentManagedMiniapp, context: SyncContext): Promise<string> {
  const downloadDir = new Directory(Paths.cache, "deployment_managed_miniapps")
  if (!downloadDir.exists) downloadDir.create()
  const target = new File(downloadDir, `${context.id}-${entry.packageName}-${entry.version}.zip`)
  if (target.exists) target.delete()

  try {
    const output = await File.downloadFileAsync(entry.bundleUrl, target, {idempotent: true})
    context.assertCurrent()
    const size = output.size
    if (size == null || size > MAX_BUNDLE_BYTES) {
      throw new Error(`bundle exceeds ${MAX_BUNDLE_BYTES} bytes (${size ?? "unknown"})`)
    }
    const bytes = await output.bytes()
    const actualSha256 = await sha256Hex(bytes)
    context.assertCurrent()
    if (actualSha256 !== entry.sha256.toLowerCase()) {
      throw new Error(`bundle SHA-256 mismatch: expected ${entry.sha256}, got ${actualSha256}`)
    }
    preflightMiniappZip(bytes)
    return output.uri
  } catch (error) {
    removeCachedBundle(target)
    throw error
  }
}

async function installEntry(
  deploymentId: string,
  workspaceOrigin: string,
  entry: DeploymentManagedMiniapp,
  previous: ManagedInstallRecord | undefined,
  context: SyncContext,
): Promise<boolean> {
  context.assertCurrent()
  const installedVersions = appRegistry.getInstalledVersions(entry.packageName, "workspace")
  const desiredIdentity = appRegistry.getReleaseIdentity(entry.packageName, entry.version, "workspace")
  const desiredOwnedByDeployment =
    installedVersions.includes(entry.version) &&
    desiredIdentity?.source === "deployment_manifest" &&
    desiredIdentity.deploymentId === deploymentId &&
    desiredIdentity.deploymentOrigin === workspaceOrigin &&
    desiredIdentity.bundleSha256 === entry.sha256.toLowerCase()
  if (previous?.version === entry.version) {
    if (previous.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      console.warn(`${LOG_TAG}: refusing changed digest for immutable ${entry.packageName}@${entry.version}`)
      return false
    }
    if (desiredOwnedByDeployment) {
      appRegistry.setActiveVersion(entry.packageName, entry.version)
      return true
    }
    if (desiredIdentity?.source === "deployment_manifest") {
      console.warn(`${LOG_TAG}: refusing unverified existing ${entry.packageName}@${entry.version}`)
      return false
    }
    // An older logout may have erased provenance while leaving this state and
    // the files intact. Re-download and verify before recovering ownership.
  } else if (desiredOwnedByDeployment) {
    // The install completed but ownership state was not persisted (for
    // example, the app stopped between those two operations). Recover it.
    appRegistry.setActiveVersion(entry.packageName, entry.version)
    return true
  } else if (installedVersions.includes(entry.version) && desiredIdentity?.source === "deployment_manifest") {
    console.warn(`${LOG_TAG}: refusing to replace existing unowned ${entry.packageName}@${entry.version}`)
    return false
  }

  let zipPath: string | undefined
  try {
    zipPath = await waitForDownload(downloadVerifiedBundle(entry, context), context.signal)
    context.assertCurrent()
    if (shouldSkipMiniappInstall(entry.packageName)) return false
    const result = await appRegistry.installFromLocalZip(zipPath, {
      expectedPackageName: entry.packageName,
      expectedVersion: entry.version,
      rejectExistingVersion: true,
      adoptIdenticalInstalledVersion: desiredIdentity?.source !== "deployment_manifest",
      expectedBundleSha256: entry.sha256,
      // downloadVerifiedBundle already matched the SHA-256 the deployment
      // manifest pins, which is this path's authority instead of a publisher
      // signature (customer-built bundles carry no Mentra publisher key).
      releaseIdentity: {
        source: "deployment_manifest",
        deploymentId,
        deploymentOrigin: workspaceOrigin,
        bundleSha256: entry.sha256.toLowerCase(),
      },
    })
    if (result.is_error()) throw result.error
    return true
  } catch (error) {
    if (error instanceof SupersededSync) throw error
    // AppRegistry owns rollback of the directory it creates. A pre-download
    // existence snapshot cannot establish ownership of a later installation.
    console.warn(`${LOG_TAG}: failed to install ${entry.packageName}@${entry.version}`, error)
    return false
  } finally {
    if (zipPath) {
      removeCachedBundle(new File(zipPath))
    }
  }
}

async function syncWorkspace(
  deployment: Extract<ActiveDeployment, {kind: "workspace"}>,
  context: SyncContext,
): Promise<void> {
  let state = readState()
  if (
    state &&
    (state.deploymentId !== deployment.manifest.deploymentId || state.workspaceOrigin !== deployment.workspaceOrigin)
  ) {
    if (!(await uninstallOwnedEntries(state, context))) return
    context.assertCurrent()
    state = null
    writeState(null)
  }

  const recoveredEntries = discoverOwnedEntries(deployment.manifest.deploymentId, deployment.workspaceOrigin)
  const currentEntries = new Map<string, ManagedInstallRecord>()
  for (const entry of [...(state?.entries ?? []), ...recoveredEntries]) currentEntries.set(recordKey(entry), entry)
  const nextEntries = new Map(currentEntries)
  const desiredNames = new Set(
    deployment.manifest.miniapps.managed
      .filter((entry) => !shouldSkipMiniappInstall(entry.packageName))
      .map((entry) => entry.packageName),
  )

  for (const entry of deployment.manifest.miniapps.managed) {
    context.assertCurrent()
    if (shouldSkipMiniappInstall(entry.packageName)) {
      console.log(`${LOG_TAG}: skipping platform-hidden ${entry.packageName}@${entry.version}`)
      continue
    }
    const previous = [...currentEntries.values()].find(
      (candidate) => candidate.packageName === entry.packageName && candidate.version === entry.version,
    )
    if (!(await installEntry(deployment.manifest.deploymentId, deployment.workspaceOrigin, entry, previous, context)))
      continue

    const next: ManagedInstallRecord = {
      packageName: entry.packageName,
      version: entry.version,
      sha256: entry.sha256.toLowerCase(),
      storageScope: "workspace",
    }
    nextEntries.set(recordKey(next), next)
    // Persist the new ownership before cleaning older versions. If cleanup
    // fails or the app stops, both owned releases remain discoverable.
    writeState({
      schemaVersion: 1,
      deploymentId: deployment.manifest.deploymentId,
      workspaceOrigin: deployment.workspaceOrigin,
      entries: [...nextEntries.values()],
    })
    // An unzip already committing when cancelled must finish before the next
    // reconciliation. Record its ownership so that reconciliation can remove
    // it; no newer workspace can have written state while we hold the queue.
    context.assertCurrent()
    for (const old of [...nextEntries.values()]) {
      context.assertCurrent()
      if (
        old.packageName !== entry.packageName ||
        (old.version === entry.version && (old.storageScope ?? "workspace") === "workspace")
      )
        continue
      if (!hasExactOwnership(deployment.manifest.deploymentId, deployment.workspaceOrigin, old)) {
        nextEntries.delete(recordKey(old))
        continue
      }
      const uninstall = await appRegistry.uninstall(old.packageName, old.version, {
        storageScope: ownedStorageScope(deployment.manifest.deploymentId, deployment.workspaceOrigin, old)!,
      })
      if (uninstall.is_error()) {
        console.warn(`${LOG_TAG}: installed update but could not remove ${old.packageName}@${old.version}`)
        continue
      }
      nextEntries.delete(recordKey(old))
    }
    context.assertCurrent()
    writeState({
      schemaVersion: 1,
      deploymentId: deployment.manifest.deploymentId,
      workspaceOrigin: deployment.workspaceOrigin,
      entries: [...nextEntries.values()],
    })
  }

  for (const previous of [...nextEntries.values()]) {
    context.assertCurrent()
    if (desiredNames.has(previous.packageName)) continue
    if (!hasExactOwnership(deployment.manifest.deploymentId, deployment.workspaceOrigin, previous)) {
      nextEntries.delete(recordKey(previous))
      continue
    }
    const uninstall = await appRegistry.uninstall(previous.packageName, previous.version, {
      storageScope: ownedStorageScope(deployment.manifest.deploymentId, deployment.workspaceOrigin, previous)!,
    })
    if (uninstall.is_error()) {
      console.warn(`${LOG_TAG}: failed to remove ${previous.packageName}@${previous.version}`, uninstall.error)
      continue
    }
    nextEntries.delete(recordKey(previous))
    context.assertCurrent()
    writeState({
      schemaVersion: 1,
      deploymentId: deployment.manifest.deploymentId,
      workspaceOrigin: deployment.workspaceOrigin,
      entries: [...nextEntries.values()],
    })
  }

  context.assertCurrent()
  writeState({
    schemaVersion: 1,
    deploymentId: deployment.manifest.deploymentId,
    workspaceOrigin: deployment.workspaceOrigin,
    entries: [...nextEntries.values()],
  })
}

export const deploymentManagedMiniappSync = {
  cancel(): Promise<void> {
    activeSync?.abort()
    return reconciliation
  },

  sync(deployment: ActiveDeployment): Promise<void> {
    if (deploymentStore.getActive() !== deployment) return Promise.resolve()
    activeSync?.abort()
    const controller = new AbortController()
    activeSync = controller
    const context: SyncContext = {
      id: ++nextSyncId,
      signal: controller.signal,
      assertCurrent: () => {
        if (controller.signal.aborted || deploymentStore.getActive() !== deployment) throw new SupersededSync()
      },
    }
    const unsubscribe = deploymentStore.subscribe(() => {
      if (deploymentStore.getActive() !== deployment) controller.abort()
    })
    reconciliation = reconciliation.then(async () => {
      try {
        context.assertCurrent()
        if (deployment.kind === "workspace") {
          await syncWorkspace(deployment, context)
          return
        }

        const state = readState()
        if (state) {
          if (await uninstallOwnedEntries(state, context)) {
            context.assertCurrent()
            writeState(null)
          }
          return
        }
        // Recover installs created before the ownership state file was flushed.
        const orphanedStates = new Map<string, ManagedInstallState>()
        for (const {packageName, version, identity, storageScope} of appRegistry.getDeploymentOwnedReleases()) {
          const {deploymentId, deploymentOrigin, bundleSha256} = identity
          if (!deploymentId || !deploymentOrigin || !bundleSha256) {
            console.warn(`${LOG_TAG}: refusing to remove orphan ${packageName}@${version} without complete ownership`)
            continue
          }
          const key = JSON.stringify([deploymentId, deploymentOrigin])
          const recovered = orphanedStates.get(key) ?? {
            schemaVersion: 1,
            deploymentId,
            workspaceOrigin: deploymentOrigin,
            entries: [],
          }
          recovered.entries.push({packageName, version, sha256: bundleSha256, storageScope})
          orphanedStates.set(key, recovered)
        }
        for (const recovered of orphanedStates.values()) {
          context.assertCurrent()
          await uninstallOwnedEntries(recovered, context)
        }
      } catch (error) {
        if (!(error instanceof SupersededSync)) console.warn(`${LOG_TAG}: reconciliation failed`, error)
      } finally {
        unsubscribe()
        if (activeSync === controller) activeSync = undefined
      }
    })
    return reconciliation
  },
}
