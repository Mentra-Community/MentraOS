import {appRegistry} from "@mentra/engine-host-internal"
import {Directory, File, Paths} from "expo-file-system"

import type {ActiveDeployment, DeploymentManagedMiniapp} from "@/services/deployment"

import {sha256Hex} from "./preinstalledMiniappSync"

const LOG_TAG = "DeploymentManagedMiniappSync"
const STATE_FILE_NAME = "deployment-managed-miniapps.json"

interface ManagedInstallRecord {
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
          typeof entry.sha256 !== "string",
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

async function uninstallOwnedEntries(entries: ManagedInstallRecord[]): Promise<boolean> {
  for (const entry of entries) {
    const result = await appRegistry.uninstall(entry.packageName, entry.version)
    if (result.is_error()) {
      console.warn(`${LOG_TAG}: failed to remove ${entry.packageName}@${entry.version}`, result.error)
      return false
    }
  }
  return true
}

async function downloadVerifiedBundle(entry: DeploymentManagedMiniapp): Promise<string> {
  const downloadDir = new Directory(Paths.cache, "deployment_managed_miniapps")
  if (!downloadDir.exists) downloadDir.create()
  const target = new File(downloadDir, `${entry.packageName}-${entry.version}.zip`)
  if (target.exists) target.delete()

  let output: File
  try {
    output = await File.downloadFileAsync(entry.bundleUrl, target, {idempotent: true})
  } catch (error) {
    throw new Error(`bundle download failed: ${(error as Error)?.message ?? error}`)
  }
  const actualSha256 = await sha256Hex(await output.bytes())
  if (actualSha256 !== entry.sha256.toLowerCase()) {
    try {
      output.delete()
    } catch {
      // Best-effort cache cleanup. The bundle is never passed to AppRegistry.
    }
    throw new Error(`bundle SHA-256 mismatch: expected ${entry.sha256}, got ${actualSha256}`)
  }
  return output.uri
}

async function installEntry(
  deploymentId: string,
  workspaceOrigin: string,
  entry: DeploymentManagedMiniapp,
  previous: ManagedInstallRecord | undefined,
): Promise<boolean> {
  const installedVersions = appRegistry.getInstalledVersions(entry.packageName)
  const desiredIdentity = appRegistry.getReleaseIdentity(entry.packageName, entry.version)
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
    if (installedVersions.includes(entry.version)) return true
  } else if (desiredOwnedByDeployment) {
    // The install completed but ownership state was not persisted (for
    // example, the app stopped between those two operations). Recover it.
    return true
  } else if (installedVersions.length > 0 && !previous) {
    console.warn(`${LOG_TAG}: refusing to adopt existing unowned package ${entry.packageName}`)
    return false
  }

  const desiredWasInstalled = installedVersions.includes(entry.version)
  try {
    const zipPath = await downloadVerifiedBundle(entry)
    const result = await appRegistry.installFromLocalZip(zipPath, {
      expectedPackageName: entry.packageName,
      expectedVersion: entry.version,
      rejectExistingVersion: true,
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
    if (!desiredWasInstalled && appRegistry.getInstalledVersions(entry.packageName).includes(entry.version)) {
      const cleanup = await appRegistry.uninstall(entry.packageName, entry.version)
      if (cleanup.is_error()) console.warn(`${LOG_TAG}: failed to clean partial install`, cleanup.error)
    }
    console.warn(`${LOG_TAG}: failed to install ${entry.packageName}@${entry.version}`, error)
    return false
  }
}

async function syncWorkspace(deployment: Extract<ActiveDeployment, {kind: "workspace"}>): Promise<void> {
  let state = readState()
  if (
    state &&
    (state.deploymentId !== deployment.manifest.deploymentId || state.workspaceOrigin !== deployment.workspaceOrigin)
  ) {
    if (!(await uninstallOwnedEntries(state.entries))) return
    state = null
    writeState(null)
  }

  const currentEntries = new Map((state?.entries ?? []).map((entry) => [entry.packageName, entry]))
  const nextEntries = new Map(currentEntries)
  const desiredNames = new Set(deployment.manifest.miniapps.managed.map((entry) => entry.packageName))

  for (const entry of deployment.manifest.miniapps.managed) {
    const previous = currentEntries.get(entry.packageName)
    if (!(await installEntry(deployment.manifest.deploymentId, deployment.workspaceOrigin, entry, previous))) continue

    const next = {packageName: entry.packageName, version: entry.version, sha256: entry.sha256.toLowerCase()}
    if (
      previous &&
      previous.version !== entry.version &&
      appRegistry.getInstalledVersions(previous.packageName).includes(previous.version)
    ) {
      const uninstall = await appRegistry.uninstall(previous.packageName, previous.version)
      if (uninstall.is_error()) {
        console.warn(`${LOG_TAG}: installed update but could not remove ${previous.packageName}@${previous.version}`)
        // Retain the old ownership record so the next reconciliation retries
        // cleanup. The newly installed version is recovered from its release
        // identity and is never downloaded or adopted as an unrelated app.
        continue
      }
    }
    nextEntries.set(entry.packageName, next)
    writeState({
      schemaVersion: 1,
      deploymentId: deployment.manifest.deploymentId,
      workspaceOrigin: deployment.workspaceOrigin,
      entries: [...nextEntries.values()],
    })
  }

  for (const previous of currentEntries.values()) {
    if (desiredNames.has(previous.packageName)) continue
    const uninstall = await appRegistry.uninstall(previous.packageName, previous.version)
    if (uninstall.is_error()) {
      console.warn(`${LOG_TAG}: failed to remove ${previous.packageName}@${previous.version}`, uninstall.error)
      continue
    }
    nextEntries.delete(previous.packageName)
    writeState({
      schemaVersion: 1,
      deploymentId: deployment.manifest.deploymentId,
      workspaceOrigin: deployment.workspaceOrigin,
      entries: [...nextEntries.values()],
    })
  }

  writeState({
    schemaVersion: 1,
    deploymentId: deployment.manifest.deploymentId,
    workspaceOrigin: deployment.workspaceOrigin,
    entries: [...nextEntries.values()],
  })
}

export const deploymentManagedMiniappSync = {
  async sync(deployment: ActiveDeployment): Promise<void> {
    try {
      if (deployment.kind === "workspace") {
        await syncWorkspace(deployment)
        return
      }

      const state = readState()
      if (!state) return
      if (await uninstallOwnedEntries(state.entries)) writeState(null)
    } catch (error) {
      console.warn(`${LOG_TAG}: reconciliation failed`, error)
    }
  },
}
