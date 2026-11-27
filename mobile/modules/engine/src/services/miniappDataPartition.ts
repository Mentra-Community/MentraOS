/**
 * Where a miniapp's private data lives.
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
 *   records which kind of build each context runs when it starts (`miniappBuildKind.ts`). The build itself is the
 *   phone's, like any install: every account sees it, and each keeps its own data for it.
 *
 * Partition state lives in its own MMKV instance (`mentra-miniapp-partitions`), which logout does not clear.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"

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

const LAST_SESSION_KEY = "session.last"
let lastSessionRecorded: string | undefined

function currentSession(): MiniappDataSession | null {
  const session = hooks?.getSession() ?? null
  if (!session?.coreUrl || !session.mentraUserId?.trim()) return null
  recordLastSession(session)
  return session
}

/** Remember the account whose data is in use, so deleting it can find its partitions after its session is gone. */
function recordLastSession(session: MiniappDataSession): void {
  const value = JSON.stringify({coreUrl: session.coreUrl, mentraUserId: session.mentraUserId.trim()})
  if (value === lastSessionRecorded) return
  store().set(LAST_SESSION_KEY, value)
  lastSessionRecorded = value
}

/**
 * The account whose miniapp data was in use last, signed in or not: the account a deletion that follows its sign-out
 * erases. Null before any account was known.
 */
export function lastMiniappDataSession(): MiniappDataSession | null {
  currentSession()
  const raw = store().getString(LAST_SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<MiniappDataSession>
    return typeof parsed.coreUrl === "string" && typeof parsed.mentraUserId === "string"
      ? {coreUrl: parsed.coreUrl, mentraUserId: parsed.mentraUserId}
      : null
  } catch {
    return null
  }
}

/**
 * Forget what this store records for `session`'s account, once its data is deleted with it: its current workspace,
 * and the record of it as the last account.
 */
export function forgetMiniappDataAccount(session: MiniappDataSession): void {
  store().remove(workspaceKey(session))
  const last = store().getString(LAST_SESSION_KEY)
  if (last) {
    try {
      const parsed = JSON.parse(last) as MiniappDataSession
      if (sessionId(parsed) === sessionId(session)) {
        store().remove(LAST_SESSION_KEY)
        lastSessionRecorded = undefined
      }
    } catch {
      store().remove(LAST_SESSION_KEY)
      lastSessionRecorded = undefined
    }
  }
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

/**
 * The account's current workspace assigned `packageName` through Fleet: its recorded assignment is this account's, on
 * this Core, from the workspace now current. False while no account is known. A running context's pinned partition
 * does not change it.
 */
export function isAssignedByCurrentWorkspace(packageName: string): boolean {
  const session = currentSession()
  return session !== null && computeContext(packageName, session).workspaceId !== null
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

// ---- Fleet workspace ---------------------------------------------------------------------------------------------

function workspaceKey(session: MiniappDataSession): string {
  return `fleetws:${sessionId(session)}`
}

/**
 * Record the workspace that manages `session`'s account (null when it is in none): the only workspace whose data its
 * packages can get.
 */
export function setFleetWorkspace(session: MiniappDataSession, workspaceId: string | null): void {
  if (workspaceId) store().set(workspaceKey(session), workspaceId)
  else store().remove(workspaceKey(session))
}

/** The workspace last recorded for `session`'s account, or null. */
export function getFleetWorkspace(session: MiniappDataSession): string | null {
  return store().getString(workspaceKey(session)) ?? null
}

/**
 * Once, for the migration of development records (`AppRegistry.ts`): the development selections an earlier Mentra App
 * kept here for each account and workspace other than the live one (each a map of `<pkg>_dev_*` key to value), and
 * nothing more of them. Every record of them goes: selections, which context was live, and the per-context tags of
 * development builds. A development build is the phone's now, like any install.
 */
export function takeLegacyDevelopmentSelections(): Array<Record<string, unknown>> {
  const selections: Array<Record<string, unknown>> = []
  for (const key of store().getAllKeys()) {
    if (key.startsWith("devsel:")) {
      try {
        const parsed = JSON.parse(store().getString(key) ?? "") as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          selections.push(parsed as Record<string, unknown>)
        }
      } catch {
        // Unreadable: nothing in it to keep.
      }
    }
    if (key.startsWith("devsel") || key.startsWith("devowner:")) store().remove(key)
  }
  return selections
}

/** Tests only. */
export function resetMiniappDataPartitionsForTests(): void {
  hooks = null
  pins.clear()
  resetMiniappBuildsForTests()
  unsubscribeContexts?.()
  unsubscribeContexts = null
  lastSessionRecorded = undefined
  partitionStore?.clearAll()
}
