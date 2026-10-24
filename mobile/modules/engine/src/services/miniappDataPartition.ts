/**
 * Where a miniapp's private data and the phone's development selections live.
 *
 * A partition is one account on one Core, and either that account's personal data or one workspace's private data.
 * A package runs in a workspace's partition only while that workspace is the account's current one (the workspace
 * whose complete desired state was applied last, {@link setFleetWorkspace}) and assigned the package to the account;
 * otherwise it runs in the account's personal partition. Data written before partitions existed belongs to the
 * personal one.
 *
 * - The recorded assignment says which workspace installed the package (its provenance); it grants that workspace's
 *   data only while that workspace is current. Once another workspace's desired state applies, or the account leaves,
 *   no new context of the package sees the old workspace's data, whether or not the new workspace's install worked.
 * - The partition a package's live context uses (a hidden or background one too) is pinned when the context starts
 *   and released when it stops, so its private execution context changes only while it is stopped.
 * - A local or development build (a local-network install, a development server or a development snapshot) may
 *   claim any package name, so its data is kept apart from every other install of that name: it uses its account's
 *   personal partition plus `.local`, never a workspace's, and never the data from before partitions. The router
 *   records which kind of build each context runs when it starts (`miniappBuildKind.ts`).
 * - Development selections (the `<pkg>_dev_*` keys and `dev_apps_index` in the default MMKV instance, read by many
 *   modules) follow the same rule, package by package: when the context changes, each package without a live context
 *   swaps at once (its outgoing selection is stashed with the context it belonged to, the incoming one restored), and
 *   a package with a live context keeps its selection, held for its old context, until it stops. So a stopped package
 *   always shows the current context's selection, and nothing reads or clears another context's. `dev-*` snapshot
 *   directories are shared on disk, so each is tagged with the context that installed it and is invisible elsewhere.
 *
 * Partition state lives in its own MMKV instance (`mentra-miniapp-partitions`), which logout does not clear.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"

import {storage} from "../utils/storage/storage"
import {normalizeCoreUrl} from "./fleet/coreUrl"
import {isLocalBuildContext, resetMiniappBuildsForTests} from "./miniappBuildKind"
import {miniappContextRegistry} from "./MiniappRunningRegistry"

/** The account a request speaks for, on its Core. */
export interface MiniappDataSession {
  coreUrl: string
  mentraUserId: string
}

export interface MiniappDataContext extends MiniappDataSession {
  /** The workspace whose private data this is; null for the account's personal data. */
  workspaceId: string | null
  /** A local or development build's data, apart from the package's own. Never a workspace's. */
  localBuild?: boolean
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
  /**
   * The workspace whose assignment to `session`'s account installed `packageName` (its provenance), or null. It
   * grants that workspace's data only while it is the account's current workspace.
   */
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
/** `{packageName: contextId}`: packages whose live selection is still an earlier context's, held while they run. */
const DEV_HELD_KEY = "devsel.held"

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

/**
 * The partition id for `context`. Pure: the same context always names the same partition. A local build's is its
 * account's personal partition plus `.local`; no escaped segment contains a `.`, so no other context names it.
 */
export function partitionIdOf(context: MiniappDataContext): string {
  if (context.localBuild) return `${sessionId(context)}.p.local`
  return `${sessionId(context)}.${context.workspaceId ? `w${escapeSegment(context.workspaceId)}` : "p"}`
}

function currentSession(): MiniappDataSession | null {
  const session = hooks?.getSession() ?? null
  if (!session?.coreUrl || !session.mentraUserId?.trim()) return null
  return session
}

function computeContext(packageName: string, session: MiniappDataSession): MiniappDataContext {
  // A local build's name proves nothing, so a workspace's assignment of that name grants it nothing.
  if (isLocalBuildContext(packageName)) {
    return {coreUrl: session.coreUrl, mentraUserId: session.mentraUserId.trim(), workspaceId: null, localBuild: true}
  }
  let workspaceId: string | null = null
  try {
    const assigned = hooks?.assignedWorkspace(packageName, session) ?? null
    // Provenance is not authorization: only the current workspace's assignment grants its data.
    if (assigned !== null && assigned === getFleetWorkspace(session)) workspaceId = assigned
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
  // A context that started again as another kind of build in place (a respawn) is pinned again for the new build.
  const sameBuild = (pinned?.localBuild === true) === isLocalBuildContext(packageName)
  if (pinned && miniappContextRegistry.has(packageName) && sameBuild) {
    return pinned
  }
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
  return {
    id: partitionIdOf(context),
    // Data from before partitions belongs to the installed package, never to a local build of its name.
    personalUserId: context.workspaceId || context.localBuild ? null : context.mentraUserId,
  }
}

// ---- Fleet workspace (the development context) ----------------------------------------------------------------

function workspaceKey(session: MiniappDataSession): string {
  return `fleetws:${sessionId(session)}`
}

/**
 * Record the workspace that manages `session`'s account (null when it is in none): the only workspace whose data its
 * packages can get. The development context follows it, package by package (see the file comment).
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

/** The context whose development selections stopped packages show now, or null before any account was known. */
export function activeDevelopmentContextId(): string | null {
  return store().getString(ACTIVE_DEV_CONTEXT_KEY) ?? targetDevContextId()
}

/** The context `packageName`'s live development selection belongs to: the active one, unless its old one is held. */
function developmentContextOf(packageName: string): string | null {
  return heldSelections()[packageName] ?? activeDevelopmentContextId()
}

/**
 * Whether `packageName`'s live development selection is the current context's. False while a live context of the
 * package holds an earlier context's selection; it becomes current when that context stops. Before any account is
 * known, every selection is current.
 */
export function isDevelopmentSelectionCurrent(packageName: string): boolean {
  syncDevelopmentSelections()
  const target = targetDevContextId()
  return target === null || developmentContextOf(packageName) === target
}

function isDevSelectionKey(key: string): boolean {
  return key === DEV_APPS_INDEX_KEY || DEV_SELECTION_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

function packageOfDevKey(key: string): string | null {
  const suffix = DEV_SELECTION_SUFFIXES.find((candidate) => key.endsWith(candidate))
  return suffix ? key.slice(0, -suffix.length) : null
}

/** A set of development selections, as the live keys hold it: key to stored value. */
type DevSelection = Record<string, unknown>

function liveDevSelection(): DevSelection {
  const out: DevSelection = {}
  for (const key of storage.getAllKeys()) {
    if (!isDevSelectionKey(key)) continue
    const loaded = storage.load<unknown>(key)
    if (loaded.is_ok()) out[key] = loaded.value
  }
  return out
}

function readJson(key: string): Record<string, unknown> {
  const raw = store().getString(key)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stashedDevSelection(contextId: string): DevSelection {
  return readJson(`devsel:${contextId}`)
}

function heldSelections(): Record<string, string> {
  const held: Record<string, string> = {}
  for (const [packageName, contextId] of Object.entries(readJson(DEV_HELD_KEY))) {
    if (typeof contextId === "string") held[packageName] = contextId
  }
  return held
}

/** The packages of `dev_apps_index` in `selection` (stored as JSON text, like `getDevAppIndex` reads it). */
function indexOf(selection: DevSelection): string[] {
  const raw = selection[DEV_APPS_INDEX_KEY]
  try {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function packagesOf(selection: DevSelection): string[] {
  const names = new Set(indexOf(selection))
  for (const key of Object.keys(selection)) {
    const packageName = packageOfDevKey(key)
    if (packageName !== null) names.add(packageName)
  }
  return [...names]
}

/** `into` with `packages`' selections replaced by `from`'s: each package's keys and index entry move together. */
function replacePackages(into: DevSelection, from: DevSelection, packages: readonly string[]): DevSelection {
  const moving = new Set(packages)
  const out: DevSelection = {}
  for (const [key, value] of Object.entries(into)) {
    const packageName = packageOfDevKey(key)
    if (key !== DEV_APPS_INDEX_KEY && (packageName === null || !moving.has(packageName))) out[key] = value
  }
  for (const [key, value] of Object.entries(from)) {
    const packageName = packageOfDevKey(key)
    if (packageName !== null && moving.has(packageName)) out[key] = value
  }
  const fromIndex = new Set(indexOf(from))
  const index = [
    ...indexOf(into).filter((packageName) => !moving.has(packageName)),
    ...packages.filter((packageName) => fromIndex.has(packageName)),
  ]
  if (index.length > 0) out[DEV_APPS_INDEX_KEY] = JSON.stringify(index)
  return out
}

function writeStash(contextId: string, selection: DevSelection): void {
  if (Object.keys(selection).length > 0) store().set(`devsel:${contextId}`, JSON.stringify(selection))
  else store().remove(`devsel:${contextId}`)
}

function writeHeld(held: Record<string, string>): void {
  if (Object.keys(held).length > 0) store().set(DEV_HELD_KEY, JSON.stringify(held))
  else store().remove(DEV_HELD_KEY)
}

interface PendingSwap {
  to: string
  /** The packages whose live selection becomes `to`'s; absent in a marker that moves every package. */
  packages?: string[]
  held?: Record<string, string>
}

/**
 * Restore `to`'s stashed selections of the swap's packages into the live keys. Idempotent, so a crash at any step is
 * finished by running it again: the stash is trimmed only after the marker is gone.
 */
function finishSwap(swap: PendingSwap): void {
  const live = liveDevSelection()
  const incoming = stashedDevSelection(swap.to)
  const packages = swap.packages ?? [...new Set([...packagesOf(live), ...packagesOf(incoming)])]
  const next = replacePackages(live, incoming, packages)
  for (const key of Object.keys(live)) if (!(key in next)) storage.remove(key)
  for (const [key, value] of Object.entries(next)) {
    if (!(key in live) || JSON.stringify(live[key]) !== JSON.stringify(value)) storage.save(key, value)
  }
  store().set(ACTIVE_DEV_CONTEXT_KEY, swap.to)
  writeHeld(swap.held ?? {})
  store().remove(DEV_SWAP_KEY)
  writeStash(swap.to, replacePackages(incoming, {}, packages))
}

/**
 * Make each package's live development selection the current context's, unless a live context of the package holds
 * its earlier one (it swaps once that context stops). Idempotent and cheap when nothing changed. The first context
 * seen adopts the selections already on the phone.
 */
export function syncDevelopmentSelections(): void {
  try {
    const pending = store().getString(DEV_SWAP_KEY)
    if (pending) finishSwap(JSON.parse(pending) as PendingSwap)
    const target = targetDevContextId()
    if (!target) return
    const active = store().getString(ACTIVE_DEV_CONTEXT_KEY)
    if (!active) {
      store().set(ACTIVE_DEV_CONTEXT_KEY, target)
      return
    }
    const held = heldSelections()
    if (active === target && Object.keys(held).length === 0) return
    const live = liveDevSelection()
    const incoming = stashedDevSelection(target)
    const ownerOf = (packageName: string) => held[packageName] ?? active
    const moving: string[] = []
    const nextHeld: Record<string, string> = {}
    for (const packageName of new Set([...packagesOf(live), ...packagesOf(incoming), ...Object.keys(held)])) {
      const owner = ownerOf(packageName)
      if (owner === target) continue
      if (miniappContextRegistry.has(packageName)) nextHeld[packageName] = owner
      else moving.push(packageName)
    }
    if (active === target && moving.length === 0 && JSON.stringify(nextHeld) === JSON.stringify(held)) return
    // Stash each moving package's live selection with the context it belonged to, then restore the target's.
    const byOwner = new Map<string, string[]>()
    for (const packageName of moving)
      byOwner.set(ownerOf(packageName), [...(byOwner.get(ownerOf(packageName)) ?? []), packageName])
    for (const [owner, packages] of byOwner)
      writeStash(owner, replacePackages(stashedDevSelection(owner), live, packages))
    const swap: PendingSwap = {to: target, packages: moving, held: nextHeld}
    store().set(DEV_SWAP_KEY, JSON.stringify(swap))
    finishSwap(swap)
  } catch (error) {
    console.warn("MINIAPP_PARTITION: development selections could not switch context", error)
  }
}

function devOwnerKey(packageName: string, version: string): string {
  return `devowner:${packageName}:${version}`
}

/** Tag a `dev-*` snapshot with the development context that installed it: the package's, held or active. */
export function recordDevSnapshotOwner(packageName: string, version: string): void {
  const owner = developmentContextOf(packageName)
  if (owner) store().set(devOwnerKey(packageName, version), owner)
}

export function forgetDevSnapshotOwner(packageName: string, version: string): void {
  store().remove(devOwnerKey(packageName, version))
}

/** One package's selection in one context's stash: its `_dev_*` keys and its `dev_apps_index` entry. */
export interface StashedDevelopmentSelection {
  contextId: string
  selection: Record<string, unknown>
}

/**
 * The current context's stashed selection of `packageName`: what the package gets once a live context holding an
 * earlier context's selection stops (empty when nothing is held). Null before any account is known. A release
 * install snapshots it in its rollback journal, then empties it with {@link restoreStashedDevelopmentSelection}.
 */
export function stashedDevelopmentSelectionOf(packageName: string): StashedDevelopmentSelection | null {
  syncDevelopmentSelections()
  const target = targetDevContextId()
  if (!target) return null
  return {contextId: target, selection: replacePackages({}, stashedDevSelection(target), [packageName])}
}

/** Make `snapshot.selection` the stashed selection of `packageName` in `snapshot.contextId`. */
export function restoreStashedDevelopmentSelection(packageName: string, snapshot: StashedDevelopmentSelection): void {
  writeStash(
    snapshot.contextId,
    replacePackages(stashedDevSelection(snapshot.contextId), snapshot.selection, [packageName]),
  )
}

/**
 * Whether a `dev-*` snapshot belongs to the development context of the package's live selection. A snapshot from
 * before partitions belongs to the first context that looks at it. Before any account is known, everything is visible.
 */
export function isDevSnapshotVisible(packageName: string, version: string): boolean {
  return isDevSnapshotOwnedBy(packageName, version, developmentContextOf(packageName))
}

/** Whether a `dev-*` snapshot belongs to the current context, whatever a live context of the package holds. */
export function isDevSnapshotOfCurrentContext(packageName: string, version: string): boolean {
  syncDevelopmentSelections()
  return isDevSnapshotOwnedBy(packageName, version, targetDevContextId() ?? activeDevelopmentContextId())
}

function isDevSnapshotOwnedBy(packageName: string, version: string, current: string | null): boolean {
  if (!version.startsWith("dev-")) return true
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
  resetMiniappBuildsForTests()
  unsubscribeContexts?.()
  unsubscribeContexts = null
  partitionStore?.clearAll()
}
