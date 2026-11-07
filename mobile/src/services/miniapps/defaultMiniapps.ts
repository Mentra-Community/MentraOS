import {engine} from "@mentra/engine"
import {appRegistry, firstPartyMiniappUrl, getDevAppRecords, InstallMiniappError} from "@mentra/engine-host-internal"

import {resolvedEndpoints} from "@/services/cloudClient"
import type {ActiveDeployment} from "@/services/deployment"
import {defaultMiniappsResponseSchema} from "@/services/deployment/schema"
import {deploymentStore} from "@/services/deployment/store"
import {DEFAULT_MINIAPPS_IDLE, useDefaultMiniappsStore} from "@/stores/defaultMiniapps"
import {storage} from "@/utils/storage"

import {shouldSkipMiniappInstall} from "./miniappVisibility"

/**
 * The deployment's default miniapps: the one way a phone gets its miniapps.
 *
 * A workspace's manifest lists them (`miniapps.defaults`); Mentra's own deployments get the list from their Core
 * (`GET /api/client/deployment`), kept for when Core can't be reached. Each one that is missing installs in the
 * background from `<firstPartyMiniappsUrl><packageName>/`, the deployment's miniapp host, through the same installer
 * as any miniapp URL, and then updates from there (miniappUpdateScheduler). Nothing is removed: a package the list
 * drops stays. A workspace's pinned releases (`miniapps.managed`) install through deploymentManagedMiniappSync.
 *
 * Offline, or before Core ever answered, nothing installs; Home says so, and the update scheduler's triggers
 * (foreground, reconnect, every 15 minutes) try again.
 */

const CORE_PATH = "api/client/deployment"
const FETCH_TIMEOUT_MS = 10_000
/** The last list Core served, with the Core it came from. */
const CACHE_KEY = "deployment_default_miniapps:v1"

const IDLE = DEFAULT_MINIAPPS_IDLE

async function fetchCoreDefaults(coreUrl: string): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(new URL(CORE_PATH, coreUrl.endsWith("/") ? coreUrl : coreUrl + "/").href, {
      headers: {accept: "application/json"},
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Core answered ${response.status}`)
    return defaultMiniappsResponseSchema.parse(await response.json()).miniapps.defaults
  } finally {
    clearTimeout(timer)
  }
}

/** The deployment's list, or null when it can't be known yet. */
async function defaultsFor(deployment: ActiveDeployment): Promise<string[] | null> {
  if (deployment.kind === "workspace") return deployment.manifest.miniapps.defaults
  const coreUrl = resolvedEndpoints().core
  try {
    const defaults = await fetchCoreDefaults(coreUrl)
    storage.save(CACHE_KEY, {coreUrl, defaults})
    return defaults
  } catch (error) {
    console.warn(`DefaultMiniapps: could not read the default miniapps from ${coreUrl}`, error)
    const cached = storage.load<{coreUrl?: unknown; defaults?: unknown}>(CACHE_KEY)
    if (cached.is_error() || cached.value.coreUrl !== coreUrl) return null
    const parsed = defaultMiniappsResponseSchema.shape.miniapps.safeParse({defaults: cached.value.defaults})
    return parsed.success ? parsed.data.defaults : null
  }
}

/** Whether this default still has to be installed on this phone. */
function isMissing(deployment: ActiveDeployment, packageName: string): boolean {
  // A workspace pin owns the package.
  if (deployment.manifest.miniapps.managed.some((entry) => entry.packageName === packageName)) return false
  const approved = deployment.manifest.systemMiniapps.approvedPackageNamesOverride
  if (approved !== null && !approved.includes(packageName)) return false
  if (shouldSkipMiniappInstall(packageName)) return false
  // Any release stays: the updater keeps it current, and never replaces a newer one.
  if (appRegistry.getInstalledVersions(packageName).length > 0) return false
  // A QR-selected development build stays the user's choice.
  return !getDevAppRecords().some((app) => app.packageName === packageName)
}

/** Install one default from the deployment's miniapp host. */
export async function installDefaultMiniapp(
  packageName: string,
  isCurrent: () => boolean = () => true,
  deployment: ActiveDeployment = deploymentStore.getActive(),
): Promise<void> {
  const url = firstPartyMiniappUrl(
    {firstPartyMiniappsUrl: deployment.manifest.artifacts.firstPartyMiniappsUrl},
    packageName,
  )
  if (!url) throw new Error(`${deployment.manifest.deploymentId} names no miniapp host for ${packageName}`)
  await engine.miniapps.install(url, {
    source: "system",
    expectedPackageName: packageName,
    isCancelled: () => !isCurrent(),
  })
}

async function syncDefaults(isCurrent: () => boolean): Promise<void> {
  const deployment = deploymentStore.getActive()
  const current = () => isCurrent() && deploymentStore.getActive() === deployment
  const defaults = await defaultsFor(deployment)
  if (!current()) return
  if (defaults === null) {
    useDefaultMiniappsStore.setState({status: "waiting", pending: []})
    return
  }
  // A deployment that names no miniapp host installs none: nothing to wait for.
  if (!deployment.manifest.artifacts.firstPartyMiniappsUrl) {
    useDefaultMiniappsStore.setState(IDLE)
    return
  }
  let pending = defaults.filter((packageName) => isMissing(deployment, packageName))
  useDefaultMiniappsStore.setState(pending.length ? {status: "installing", pending} : IDLE)
  let offline = false
  for (const packageName of [...pending]) {
    if (!current()) return
    try {
      await installDefaultMiniapp(packageName, current, deployment)
    } catch (error) {
      if (!current()) return
      console.warn(`DefaultMiniapps: could not install ${packageName}`, error)
      // A refusal (a domain, the deployment's policy, an incompatible release) is not something to wait for.
      if (!(error instanceof InstallMiniappError) || error.code === "network") {
        offline = true
        continue
      }
    }
    pending = pending.filter((name) => name !== packageName)
    useDefaultMiniappsStore.setState({status: "installing", pending})
  }
  if (!current()) return
  useDefaultMiniappsStore.setState(pending.length && offline ? {status: "waiting", pending} : IDLE)
}

let running: Promise<void> | null = null
let next: Promise<void> | null = null

export const defaultMiniapps = {
  /**
   * Install the active deployment's missing defaults. A call while one runs runs once more after it; calls meanwhile
   * share that one. Stops once `isCurrent` turns false or the deployment changes.
   */
  sync(isCurrent: () => boolean = () => true): Promise<void> {
    if (!running) {
      const run = syncDefaults(isCurrent).finally(() => {
        if (running === run) running = null
      })
      running = run
      return run
    }
    next ??= running
      .catch(() => {})
      .then(() => {
        next = null
        return defaultMiniapps.sync(isCurrent)
      })
    return next
  },

  /** Forget the status shown, as at logout. */
  reset(): void {
    useDefaultMiniappsStore.setState(IDLE)
  },
}
