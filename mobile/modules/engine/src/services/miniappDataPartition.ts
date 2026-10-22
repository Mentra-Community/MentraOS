/**
 * Where a miniapp's private data and the phone's development selections live.
 *
 * A partition is one account on one Core, and either that account's personal data or one workspace's private data.
 * A package runs in its workspace's partition while that workspace assigned it to the signed-in account, and in the
 * account's personal partition otherwise. Data written before partitions existed belongs to the personal one.
 *
 * - The partition a package's live context uses (a hidden or background one too) is pinned when the context starts
 *   and released when it stops, so its private execution context changes only while it is stopped.
 * - Development selections (the `<pkg>_dev_*` keys and `dev_apps_index` in the default MMKV instance, read by many
 *   modules) are swapped as a set: the outgoing context's set is stashed, the incoming one's restored. A swap that
 *   would change the selection of a package with a live context waits until it stops. `dev-*` snapshot directories are shared
 *   on disk, so each is tagged with the context that installed it and is invisible elsewhere.
 *
 * Partition state lives in its own MMKV instance (`mentra-miniapp-partitions`), which logout does not clear.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"

import {storage} from "../utils/storage/storage"
import {normalizeCoreUrl} from "./fleet/coreUrl"
import {miniappContextRegistry} from "./MiniappRunningRegistry"

/** The account a request speaks for, on its Core. */
export interface MiniappDataSession {
  coreUrl: string
  mentraUserId: string
}

export interface MiniappDataContext extends MiniappDataSession {
  /** The workspace whose private data this is; null for the account's personal data. */
  workspaceId: string | null
}

export interface MiniappDataPartition {
  /** Safe as an MMKV key part and as a file name. One per Core, account and workspace (or personal). */
  id: string
  /** For a personal partition, the account whose data from before partitions migrates into it; otherwise null. */
  personalUserId: string | null
}

export interface MiniappDataPartitionHooks {
  /** The signed-in account on its Core, or null while it is not known. */
  getSession: () => MiniappDataSession | null
  /** The workspace that assigned `packageName` to `session`'s account, or null. */
  assignedWorkspace: (packageName: string, session: MiniappDataSession) => string | null
}

/** Stands in for the Core URL of a deployment without a Core, whose host supplies the identity. */
export const CORE_FREE_DATA_ORIGIN = "deployment"

/**
 * The account data is kept for: the Core session's account when there is one, otherwise the host's deployment-scoped
 * identity. Local storage was keyed by that identity before partitions, so it migrates into its personal partition.
 */
export function miniappDataSessionOf(
  core: {coreUrl: string; mentraUserId: string | null} | null,
  deploymentUserId: string | null,
): MiniappDataSession | null {
  if (core?.mentraUserId) return {coreUrl: core.coreUrl, mentraUserId: core.mentraUserId}
  return deploymentUserId ? {coreUrl: CORE_FREE_DATA_ORIGIN, mentraUserId: deploymentUserId} : null
}

export const MINIAPP_PARTITION_STORE_ID = "mentra-miniapp-partitions"
const DEV_SELECTION_SUFFIXES = [
  "_dev_meta",
  "_dev_url",
  "_dev_port",
  "_dev_mdns",
  "_dev_last_reachable",
  "_dev_selected_snapshot",
] as const
const DEV_APPS_INDEX_KEY = "dev_apps_index"
const ACTIVE_DEV_CONTEXT_KEY = "devsel.active"
const DEV_SWAP_KEY = "devsel.swap"

let partitionStore: MMKV | undefined
let hooks: MiniappDataPartitionHooks | null = null
const pins = new Map<string, MiniappDataContext>()
let unsubscribeContexts: (() => void) | null = null

function store(): MMKV {
  return (partitionStore ??= createMMKV({id: MINIAPP_PARTITION_STORE_ID}))
}

/**
 * A reversible spelling that is safe in an MMKV key and in a file name on a case-insensitive file system: lower-case
 * letters, digits and `-` stay; everything else, `.` and upper-case letters included, is escaped.
 */
function escapeSegment(value: string): string {
  let out = ""
  for (const char of value) {
    if (/^[a-z0-9-]$/.test(char)) {
      out += char
      continue
    }
    const code = char.codePointAt(0)!
    if (code <= 0xff) out += `_${code.toString(16).padStart(2, "0")}`
    else if (code <= 0xffff) out += `~${code.toString(16).padStart(4, "0")}`
    else out += `~~${code.toString(16).padStart(6, "0")}`
  }
  return out
}

function sessionId(session: MiniappDataSession): string {
  return `${escapeSegment(normalizeCoreUrl(session.coreUrl))}.${escapeSegment(session.mentraUserId.trim())}`
}

/** The partition id for `context`. Pure: the same context always names the same partition. */
export function partitionIdOf(context: MiniappDataContext): string {
  return `${sessionId(context)}.${context.workspaceId ? `w${escapeSegment(context.workspaceId)}` : "p"}`
}

function currentSession(): MiniappDataSession | null {
  const session = hooks?.getSession() ?? null
  if (!session?.coreUrl || !session.mentraUserId?.trim()) return null
  return session
}

function computeContext(packageName: string, session: MiniappDataSession): MiniappDataContext {
  let workspaceId: string | null = null
  try {
    workspaceId = hooks?.assignedWorkspace(packageName, session) ?? null
  } catch (error) {
    console.warn(`MINIAPP_PARTITION: could not read the assignment of ${packageName}`, error)
  }
  return {coreUrl: session.coreUrl, mentraUserId: session.mentraUserId.trim(), workspaceId}
}

function syncPins(): void {
  for (const packageName of [...pins.keys()]) {
    if (!miniappContextRegistry.has(packageName)) pins.delete(packageName)
  }
  const session = currentSession()
  if (session) {
    for (const packageName of miniappContextRegistry.getAll()) {
      if (!pins.has(packageName)) pins.set(packageName, computeContext(packageName, session))
    }
  }
  syncDevelopmentSelections()
}

/** Install the session and assignment sources. Safe to call again; the last hooks win. */
export function configureMiniappDataPartitions(next: MiniappDataPartitionHooks): void {
  hooks = next
  unsubscribeContexts ??= miniappContextRegistry.subscribe(syncPins)
  syncPins()
}

/** The data context `packageName` reads and writes now. Throws while no account is known. */
export function miniappDataContext(packageName: string): MiniappDataContext {
  const pinned = pins.get(packageName)
  if (pinned && miniappContextRegistry.has(packageName)) return pinned
  pins.delete(packageName)
  const session = currentSession()
  if (!session) throw new Error("Mentra user identity is unavailable")
  const context = computeContext(packageName, session)
  if (miniappContextRegistry.has(packageName)) pins.set(packageName, context)
  return context
}

/** The partition `packageName`'s SimpleStorage and blobs use now. Throws while no account is known. */
export function resolveMiniappDataPartition(packageName: string): MiniappDataPartition {
  const context = miniappDataContext(packageName)
  return {id: partitionIdOf(context), personalUserId: context.workspaceId ? null : context.mentraUserId}
}

// ---- Fleet workspace (the development context) ----------------------------------------------------------------

function workspaceKey(session: MiniappDataSession): string {
  return `fleetws:${sessionId(session)}`
}

/**
 * Record the workspace that manages `session`'s account (null when it is in none). The development context follows
 * it; a swap that would touch a running package waits until that package stops.
 */
export function setFleetWorkspace(session: MiniappDataSession, workspaceId: string | null): void {
  if (workspaceId) store().set(workspaceKey(session), workspaceId)
  else store().remove(workspaceKey(session))
  syncDevelopmentSelections()
}

/** The workspace last recorded for `session`'s account, or null. */
export function getFleetWorkspace(session: MiniappDataSession): string | null {
  return store().getString(workspaceKey(session)) ?? null
}

function targetDevContextId(): string | null {
  const session = currentSession()
  if (!session) return null
  return partitionIdOf({...session, workspaceId: getFleetWorkspace(session)})
}

/** The context whose development selections are in effect now, or null before any account was known. */
export function activeDevelopmentContextId(): string | null {
  return store().getString(ACTIVE_DEV_CONTEXT_KEY) ?? targetDevContextId()
}

function isDevSelectionKey(key: string): boolean {
  return key === DEV_APPS_INDEX_KEY || DEV_SELECTION_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

function packageOfDevKey(key: string): string | null {
  const suffix = DEV_SELECTION_SUFFIXES.find((candidate) => key.endsWith(candidate))
  return suffix ? key.slice(0, -suffix.length) : null
}

function liveDevSelection(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of storage.getAllKeys()) {
    if (!isDevSelectionKey(key)) continue
    const loaded = storage.load<unknown>(key)
    if (loaded.is_ok()) out[key] = loaded.value
  }
  return out
}

function stashedDevSelection(contextId: string): Record<string, unknown> {
  const raw = store().getString(`devsel:${contextId}`)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Restore `to`'s stash into the live keys. Idempotent, so a crash at any step is finished by running it again. */
function finishSwap(to: string): void {
  const incoming = stashedDevSelection(to)
  for (const key of storage.getAllKeys()) if (isDevSelectionKey(key)) storage.remove(key)
  for (const [key, value] of Object.entries(incoming)) storage.save(key, value)
  store().set(ACTIVE_DEV_CONTEXT_KEY, to)
  store().remove(DEV_SWAP_KEY)
  store().remove(`devsel:${to}`)
}

/**
 * Make the live development selections the current context's. Idempotent and cheap when nothing changed. The first
 * context seen adopts the selections already on the phone.
 */
export function syncDevelopmentSelections(): void {
  try {
    const pending = store().getString(DEV_SWAP_KEY)
    if (pending) finishSwap((JSON.parse(pending) as {to: string}).to)
    const target = targetDevContextId()
    if (!target) return
    const active = store().getString(ACTIVE_DEV_CONTEXT_KEY)
    if (!active) {
      store().set(ACTIVE_DEV_CONTEXT_KEY, target)
      return
    }
    if (active === target) return
    const outgoing = liveDevSelection()
    const affected = [...Object.keys(outgoing), ...Object.keys(stashedDevSelection(target))]
      .map(packageOfDevKey)
      .filter((packageName): packageName is string => packageName !== null)
    if (affected.some((packageName) => miniappContextRegistry.has(packageName))) return
    store().set(`devsel:${active}`, JSON.stringify(outgoing))
    store().set(DEV_SWAP_KEY, JSON.stringify({from: active, to: target}))
    finishSwap(target)
  } catch (error) {
    console.warn("MINIAPP_PARTITION: development selections could not switch context", error)
  }
}

function devOwnerKey(packageName: string, version: string): string {
  return `devowner:${packageName}:${version}`
}

/** Tag a `dev-*` snapshot with the development context that installed it. */
export function recordDevSnapshotOwner(packageName: string, version: string): void {
  const owner = activeDevelopmentContextId()
  if (owner) store().set(devOwnerKey(packageName, version), owner)
}

export function forgetDevSnapshotOwner(packageName: string, version: string): void {
  store().remove(devOwnerKey(packageName, version))
}

/**
 * Whether a `dev-*` snapshot belongs to the development context in effect. A snapshot from before partitions belongs
 * to the first context that looks at it. Before any account is known, everything is visible.
 */
export function isDevSnapshotVisible(packageName: string, version: string): boolean {
  if (!version.startsWith("dev-")) return true
  const current = activeDevelopmentContextId()
  if (!current) return true
  const owner = store().getString(devOwnerKey(packageName, version))
  if (!owner) {
    store().set(devOwnerKey(packageName, version), current)
    return true
  }
  return owner === current
}

/** Tests only. */
export function resetMiniappDataPartitionsForTests(): void {
  hooks = null
  pins.clear()
  unsubscribeContexts?.()
  unsubscribeContexts = null
  partitionStore?.clearAll()
}
