import {engine} from "@mentra/engine"
import {appRegistry, firstPartyMiniappUrl, getDevAppRecords, InstallMiniappError} from "@mentra/engine-host-internal"

import {resolvedEndpoints} from "@/services/cloudClient"
import type {ActiveDeployment} from "@/services/deployment"
import {defaultMiniappsResponseSchema} from "@/services/deployment/schema"
import {deploymentStore} from "@/services/deployment/store"
import {DEFAULT_MINIAPPS_IDLE, type DefaultMiniappListing, useDefaultMiniappsStore} from "@/stores/defaultMiniapps"
import {endMiniappOpenWait} from "@/stores/miniappOpenWait"
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
 * Home shows each pending default as if it were installed, from its `miniapp.json` (read for all of them at once and
 * kept for the next launch); opening one waits for its install, which `prioritize` moves to the front.
 *
 * Offline, or before Core ever answered, nothing installs, and the update scheduler's triggers (foreground,
 * reconnect, every 15 minutes) try again. Only when the list itself is unknown does Home say so.
 */

const CORE_PATH = "api/client/deployment"
const FETCH_TIMEOUT_MS = 10_000
/** The last list Core served, with the Core it came from. */
const CACHE_KEY = "deployment_default_miniapps:v1"
/** Each pending default's listing, by the URL it installs from. */
const LISTINGS_KEY = "deployment_default_miniapp_listings:v1"

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

/** Where a default installs from: `<firstPartyMiniappsUrl><packageName>/` on the deployment's miniapp host. */
function defaultMiniappUrl(deployment: ActiveDeployment, packageName: string): string | undefined {
  return firstPartyMiniappUrl({firstPartyMiniappsUrl: deployment.manifest.artifacts.firstPartyMiniappsUrl}, packageName)
}

/** Install one default from the deployment's miniapp host. */
export async function installDefaultMiniapp(
  packageName: string,
  isCurrent: () => boolean = () => true,
  deployment: ActiveDeployment = deploymentStore.getActive(),
): Promise<void> {
  const url = defaultMiniappUrl(deployment, packageName)
  if (!url) throw new Error(`${deployment.manifest.deploymentId} names no miniapp host for ${packageName}`)
  await engine.miniapps.install(url, {
    source: "system",
    expectedPackageName: packageName,
    isCancelled: () => !isCurrent(),
  })
}

function loadListings(): Record<string, DefaultMiniappListing> {
  const stored = storage.load<Record<string, DefaultMiniappListing>>(LISTINGS_KEY)
  if (stored.is_error() || typeof stored.value !== "object" || stored.value === null) return {}
  return stored.value
}

function isListing(value: unknown): value is DefaultMiniappListing {
  if (typeof value !== "object" || value === null) return false
  const {name, iconUrl, version} = value as Record<string, unknown>
  return (
    typeof name === "string" &&
    name.length > 0 &&
    typeof version === "string" &&
    (iconUrl === null || typeof iconUrl === "string")
  )
}

/**
 * Show each pending default from its `miniapp.json`: what the last launch read at once, then what every `miniapp.json`
 * says now, read in parallel. One that can't be read keeps what was kept, or shows nothing until it installs.
 */
async function readListings(urls: Map<string, string>, current: () => boolean, pending: () => string[]): Promise<void> {
  const kept = loadListings()
  const fresh: Record<string, DefaultMiniappListing> = {}
  const show = (packageName: string, listing: DefaultMiniappListing) => {
    if (!current() || !pending().includes(packageName) || refused.has(packageName)) return
    useDefaultMiniappsStore.setState((state) => ({listings: {...state.listings, [packageName]: listing}}))
  }
  for (const [packageName, url] of urls) {
    const listing = kept[url]
    if (isListing(listing)) show(packageName, listing)
  }
  await Promise.all(
    [...urls].map(async ([packageName, url]) => {
      try {
        const listing = await engine.miniapps.readListing(url)
        if (listing.packageName !== packageName) return
        const {name, iconUrl, version} = listing
        fresh[url] = {name, iconUrl, version}
        show(packageName, fresh[url])
      } catch (error) {
        console.warn(`DefaultMiniapps: could not read ${url}miniapp.json`, error)
      }
    }),
  )
  if (!current()) return
  // Keep only what is still pending, so the next launch shows it at once.
  const keep: Record<string, DefaultMiniappListing> = {}
  for (const [packageName, url] of urls) {
    const listing = fresh[url] ?? kept[url]
    if (pending().includes(packageName) && isListing(listing)) keep[url] = listing
  }
  storage.save(LISTINGS_KEY, keep)
}

/** The default the person is waiting for (`prioritize`): it installs next. */
let prioritized: string | null = null
/**
 * The defaults whose install the active deployment refused. Each pass tries them again, as an app update can make one
 * installable, but Home shows none of them meanwhile: a tile that vanishes at its turn would only flicker.
 */
const refused = new Set<string>()
let refusedFor: ActiveDeployment | null = null
/** `reset` (logout) ends every pass started before it. */
let session = 0
/** The latest pass: an earlier pass's listings, still being read, no longer show. */
let latestPass = 0

function takeNext(queue: string[]): string {
  const index = prioritized === null ? -1 : queue.indexOf(prioritized)
  return queue.splice(Math.max(index, 0), 1)[0]!
}

async function syncDefaults(isCurrent: () => boolean): Promise<void> {
  const deployment = deploymentStore.getActive()
  const started = session
  const pass = ++latestPass
  const current = () => isCurrent() && deploymentStore.getActive() === deployment && session === started
  if (refusedFor !== deployment) {
    refused.clear()
    refusedFor = deployment
  }
  const defaults = await defaultsFor(deployment)
  if (!current()) return
  if (defaults === null) {
    useDefaultMiniappsStore.setState({status: "waiting", pending: [], listings: {}, failed: []})
    return
  }
  // A deployment that names no miniapp host installs none: nothing to wait for.
  if (!deployment.manifest.artifacts.firstPartyMiniappsUrl) {
    useDefaultMiniappsStore.setState(IDLE)
    return
  }
  let pending = defaults.filter((packageName) => isMissing(deployment, packageName))
  const urls = new Map<string, string>()
  for (const packageName of pending) {
    const url = defaultMiniappUrl(deployment, packageName)
    if (url) urls.set(packageName, url)
  }
  const publish = (status: "installing" | "waiting" | "idle") => {
    useDefaultMiniappsStore.setState((state) => ({
      status,
      pending,
      listings: Object.fromEntries(
        Object.entries(state.listings).filter(([name]) => pending.includes(name) && !refused.has(name)),
      ),
      failed: [...refused],
    }))
  }
  publish(pending.length ? "installing" : "idle")
  void readListings(
    urls,
    () => current() && latestPass === pass,
    () => pending,
  )
  let offline = false
  const queue = [...pending]
  while (queue.length > 0) {
    if (!current()) return
    const packageName = takeNext(queue)
    try {
      await installDefaultMiniapp(packageName, current, deployment)
      refused.delete(packageName)
    } catch (error) {
      if (!current()) return
      console.warn(`DefaultMiniapps: could not install ${packageName}`, error)
      // A refusal (a domain, the deployment's policy, an incompatible release) is not something to wait for.
      if (!(error instanceof InstallMiniappError) || error.code === "network") {
        offline = true
        continue
      }
      refused.add(packageName)
    }
    // An install that finished after a logout or a deployment change reports nothing.
    if (!current()) return
    if (prioritized === packageName) prioritized = null
    pending = pending.filter((name) => name !== packageName)
    publish("installing")
  }
  if (!current()) return
  publish(pending.length && offline ? "waiting" : "idle")
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

  /**
   * The person is waiting for this default (they opened it before it installed): the pass in progress installs it
   * next, and one more pass follows, for a download that failed or waits for a connection.
   */
  prioritize(packageName: string): void {
    prioritized = packageName
    defaultMiniapps.sync().catch((error) => console.warn("DefaultMiniapps: sync failed", error))
  },

  /** Forget the status shown, as at logout: the pass in progress stops, and a miniapp's wait to open ends. */
  reset(): void {
    session++
    prioritized = null
    refused.clear()
    refusedFor = null
    useDefaultMiniappsStore.setState(IDLE)
    endMiniappOpenWait()
  },
}
