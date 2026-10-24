/**
 * The host's copy of every miniapp screen's `localStorage`, so it lasts like a normal app's.
 *
 * Each miniapp's screen loads from its package's own origin. On iOS, WebKit's tracking prevention deletes an
 * origin's script-written storage when the origin had no user interaction in its last seven days of WebView use, and
 * WKWebView has no public setting to stop it. So the host keeps a copy of each screen's `localStorage`, and the
 * Mentra App's keeper script (`webStorageMigration.ts`) restores it before the miniapp's own scripts run and reports
 * the page's changes back here.
 *
 * - **Where it lives.** In the miniapp's data partition (`miniappDataPartition.ts`), beside its SDK storage, in the
 *   default MMKV instance: one account on one Core, personal or one workspace's, and a local or development build's
 *   own `.local` space. So it follows SDK storage's rules: one package never sees another's copy, a local build never
 *   sees the installed package's, logout's `clearAll()` of the default instance clears it, and an uninstall keeps it
 *   in its partition for a later reinstall, as it keeps the package's SDK storage and blobs.
 * - **The cap.** At most {@link MINIAPP_WEB_STORAGE_CAP_BYTES} per package, counted as browsers count their
 *   `localStorage` quota: two bytes per UTF-16 code unit of every key and value. A write that doesn't fit isn't kept
 *   (the key drops out of the copy, so the copy never restores an older value of it); the page itself is unaffected.
 * - **Which copy an origin holds.** An origin's WebKit storage is one per package, whatever account or workspace is
 *   using it, so the host records which copy each origin was last filled from (its own MMKV instance, which logout
 *   leaves alone), and marks it unknown while a screen that hasn't confirmed its load may have changed it. Only an
 *   origin the host has never opened is adopted as it is. When an origin holds the current copy, a load restores the keys it lost and takes the values it
 *   has that the copy lacks (the origin's value wins: a lost report, or a write the keeper didn't see). When it holds
 *   another copy (another account's, another workspace's, or one cleared by logout since), the load replaces the
 *   origin's storage with the current copy, so no account's page ever starts with another's data.
 *
 * Only `localStorage` is kept. `sessionStorage` lasts for one WebView, as in a browser tab; IndexedDB, Cache Storage
 * and cookies are not kept, and on iOS WebKit may delete them.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"

import {storage} from "../utils/storage/storage"

/** The most a package's copy holds: 5 MB, as UTF-16 (two bytes per code unit of each key and value). */
export const MINIAPP_WEB_STORAGE_CAP_BYTES = 5 * 1024 * 1024
/** Where the host records which copy each origin holds. Logout's `clearAll()` of the default instance spares it. */
export const MINIAPP_WEB_STORAGE_STORE_ID = "mentra-miniapp-web-storage"

const COPY_ROOT = "mentraos_miniappwebstorage/"
/** An origin record that matches no copy: the origin's storage is replaced at its next load. */
const UNKNOWN_COPY = "unknown"

/** Bytes a key and its value take toward the cap. */
export function webStorageEntryBytes(key: string, value: string): number {
  return 2 * (key.length + value.length)
}

/** One change the page made, in order. */
export type MiniappWebStorageOp = ["set", string, string] | ["remove", string] | ["clear"]

/**
 * One screen's link to its package's copy, from {@link openMiniappWebStorage}. Its changes go to the copy it was
 * opened on, and are dropped once that copy is gone (cleared by logout).
 */
export interface MiniappWebStorageSession {
  packageName: string
  /** The screen's origin, which only this package's screens use. */
  origin: string
  partitionId: string
  copyId: string
  /**
   * `merge`: the origin holds this copy (or storage the host never saw), so its load restores the keys it lacks and
   * the origin's values win. `replace`: the origin holds another copy, so its load clears it and writes this one.
   */
  mode: "merge" | "replace"
  /** Keys whose removal the copy remembers, so {@link fillMiniappWebStorage} never brings them back. */
  rememberRemoved: readonly string[]
}

interface CopyMeta {
  id: string
  /** The origin this copy was last loaded into, or null before any. */
  origin: string | null
  /** Keys of {@link MiniappWebStorageSession.rememberRemoved} the page removed. */
  removed: string[]
}

interface CachedEntries {
  id: string
  /** A Map, so any key (`__proto__` included) is just a key. */
  entries: Map<string, string>
  bytes: number
}

let recordStore: MMKV | undefined
const entriesCache = new Map<string, CachedEntries>()
const overCapLogged = new Set<string>()

function records(): MMKV {
  return (recordStore ??= createMMKV({id: MINIAPP_WEB_STORAGE_STORE_ID}))
}

function originRecordKey(origin: string): string {
  return `origin:${origin}`
}

function metaKey(partitionId: string, packageName: string): string {
  return `${COPY_ROOT}${partitionId}/${packageName}`
}

function entriesKey(partitionId: string, packageName: string): string {
  return `${metaKey(partitionId, packageName)}/entries`
}

function newCopyId(): string {
  const bytes = new Uint8Array(16)
  const source = (globalThis as {crypto?: {getRandomValues?: (array: Uint8Array) => Uint8Array}}).crypto
  if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function loadMeta(partitionId: string, packageName: string): CopyMeta | null {
  const stored = storage.load<unknown>(metaKey(partitionId, packageName))
  if (!stored.is_ok() || !stored.value || typeof stored.value !== "object") return null
  const value = stored.value as Record<string, unknown>
  if (typeof value.id !== "string" || !value.id) return null
  return {
    id: value.id,
    origin: typeof value.origin === "string" ? value.origin : null,
    removed: Array.isArray(value.removed) ? value.removed.filter((key): key is string => typeof key === "string") : [],
  }
}

function saveMeta(partitionId: string, packageName: string, meta: CopyMeta): void {
  storage.save(metaKey(partitionId, packageName), meta)
}

function bytesOf(entries: Map<string, string>): number {
  let bytes = 0
  for (const [key, value] of entries) bytes += webStorageEntryBytes(key, value)
  return bytes
}

/** The copy's entries, or null when `session`'s copy is gone. */
function loadCopy(session: MiniappWebStorageSession): {meta: CopyMeta; cached: CachedEntries} | null {
  const meta = loadMeta(session.partitionId, session.packageName)
  if (!meta || meta.id !== session.copyId) return null
  const key = entriesKey(session.partitionId, session.packageName)
  const hit = entriesCache.get(key)
  if (hit && hit.id === meta.id) return {meta, cached: hit}
  const entries = new Map<string, string>()
  const stored = storage.load<unknown>(key)
  if (stored.is_ok() && stored.value && typeof stored.value === "object") {
    for (const [name, value] of Object.entries(stored.value as Record<string, unknown>)) {
      if (typeof value === "string") entries.set(name, value)
    }
  }
  const cached = {id: meta.id, entries, bytes: bytesOf(entries)}
  entriesCache.set(key, cached)
  return {meta, cached}
}

function saveEntries(session: MiniappWebStorageSession, cached: CachedEntries): void {
  const key = entriesKey(session.partitionId, session.packageName)
  // Object.fromEntries defines own properties, so JSON keeps a `__proto__` key like any other.
  if (cached.entries.size > 0) storage.save(key, Object.fromEntries(cached.entries))
  else storage.remove(key)
  entriesCache.set(key, cached)
}

/** Sets `key` in the copy if it fits under the cap; otherwise drops it from the copy. Returns whether it is kept. */
function putEntry(cached: CachedEntries, key: string, value: string): boolean {
  const previous = cached.entries.get(key)
  const without = cached.bytes - (previous === undefined ? 0 : webStorageEntryBytes(key, previous))
  const next = without + webStorageEntryBytes(key, value)
  if (next > MINIAPP_WEB_STORAGE_CAP_BYTES) {
    cached.entries.delete(key)
    cached.bytes = without
    return false
  }
  cached.entries.set(key, value)
  cached.bytes = next
  return true
}

function dropEntry(cached: CachedEntries, key: string): void {
  const previous = cached.entries.get(key)
  if (previous === undefined) return
  cached.bytes -= webStorageEntryBytes(key, previous)
  cached.entries.delete(key)
}

function logNotKept(packageName: string, keys: string[]): void {
  if (keys.length === 0 || overCapLogged.has(packageName)) return
  overCapLogged.add(packageName)
  console.warn(
    `MiniappWebStorage: ${packageName}'s localStorage is over the ${MINIAPP_WEB_STORAGE_CAP_BYTES / (1024 * 1024)} MB ` +
      `the host keeps; ${keys.length} key(s) aren't kept, so they may not survive on iOS`,
  )
}

/**
 * Opens `packageName`'s copy in `partitionId` for a screen loading from `origin`, creating an empty copy the first
 * time, and says whether the origin's storage is merged with it or replaced by it.
 */
export function openMiniappWebStorage(input: {
  packageName: string
  origin: string
  partitionId: string
  rememberRemoved?: readonly string[]
}): MiniappWebStorageSession {
  const {packageName, origin, partitionId} = input
  let meta = loadMeta(partitionId, packageName)
  if (!meta) {
    meta = {id: newCopyId(), origin: null, removed: []}
    saveMeta(partitionId, packageName, meta)
  }
  const holds = records().getString(originRecordKey(origin))
  const inSync = meta.origin === origin && holds === meta.id
  const merge = inSync || (meta.origin === null && holds === undefined)
  // Until this screen's keeper reports it ran, the origin may hold this copy or what it held before: a later open
  // (after a logout, say) replaces it rather than adopting it.
  if (!inSync) records().set(originRecordKey(origin), UNKNOWN_COPY)
  return {
    packageName,
    origin,
    partitionId,
    copyId: meta.id,
    mode: merge ? "merge" : "replace",
    rememberRemoved: input.rememberRemoved ?? [],
  }
}

/** What `session`'s copy holds now; empty once the copy is gone. */
export function miniappWebStorageEntries(session: MiniappWebStorageSession): Record<string, string> {
  const copy = loadCopy(session)
  return copy ? Object.fromEntries(copy.cached.entries) : {}
}

/** Keys of the session's {@link MiniappWebStorageSession.rememberRemoved} that the page removed. */
export function removedMiniappWebStorageKeys(session: MiniappWebStorageSession): string[] {
  return loadCopy(session)?.meta.removed ?? []
}

/** The screen's keeper ran: its origin now holds `session`'s copy, so later loads merge. */
export function markMiniappWebStorageLoaded(session: MiniappWebStorageSession): void {
  const copy = loadCopy(session)
  if (!copy) return
  if (copy.meta.origin !== session.origin) {
    saveMeta(session.partitionId, session.packageName, {...copy.meta, origin: session.origin})
  }
  records().set(originRecordKey(session.origin), session.copyId)
}

/**
 * A screen of `origin` ran without the host's copy (no account was known), so the host can't tell what its storage
 * holds now: its next load replaces it with the copy.
 */
export function markMiniappWebStorageOriginUnknown(origin: string): void {
  records().set(originRecordKey(origin), UNKNOWN_COPY)
}

/**
 * Applies the page's changes, in order, to `session`'s copy. Returns the keys a write left out of the copy because
 * they didn't fit under the cap. Does nothing once the copy is gone.
 */
export function applyMiniappWebStorageOps(
  session: MiniappWebStorageSession,
  ops: readonly MiniappWebStorageOp[],
): {notKept: string[]} {
  const copy = loadCopy(session)
  if (!copy || ops.length === 0) return {notKept: []}
  const cached: CachedEntries = {...copy.cached, entries: new Map(copy.cached.entries)}
  const remembered = new Set(session.rememberRemoved)
  const removed = new Set(copy.meta.removed)
  const notKept = new Set<string>()
  for (const op of ops) {
    if (op[0] === "clear") {
      cached.entries = new Map()
      cached.bytes = 0
      for (const key of remembered) removed.add(key)
      notKept.clear()
    } else if (op[0] === "remove") {
      dropEntry(cached, op[1])
      if (remembered.has(op[1])) removed.add(op[1])
      notKept.delete(op[1])
    } else {
      removed.delete(op[1])
      if (putEntry(cached, op[1], op[2])) notKept.delete(op[1])
      else notKept.add(op[1])
    }
  }
  saveEntries(session, cached)
  const removedList = [...removed]
  if (removedList.length !== copy.meta.removed.length || removedList.some((key) => !copy.meta.removed.includes(key))) {
    saveMeta(session.partitionId, session.packageName, {...copy.meta, removed: removedList})
  }
  logNotKept(session.packageName, [...notKept])
  return {notKept: [...notKept]}
}

/**
 * Adds `entries` the copy knows nothing about: keys it neither holds nor remembers as removed. For moving data the
 * package kept elsewhere before (it never replaces what the page wrote since). `removed` are keys that store
 * remembers as removed, which the copy then remembers too.
 */
export function fillMiniappWebStorage(
  session: MiniappWebStorageSession,
  entries: Record<string, string>,
  removed: readonly string[] = [],
): void {
  const copy = loadCopy(session)
  if (!copy) return
  const cached: CachedEntries = {...copy.cached, entries: new Map(copy.cached.entries)}
  const remembered = new Set(copy.meta.removed)
  const notKept: string[] = []
  let changed = false
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== "string" || remembered.has(key) || cached.entries.has(key)) continue
    if (putEntry(cached, key, value)) changed = true
    else notKept.push(key)
  }
  if (changed) saveEntries(session, cached)
  const newlyRemoved = removed.filter(
    (key) => session.rememberRemoved.includes(key) && !remembered.has(key) && !cached.entries.has(key),
  )
  if (newlyRemoved.length > 0) {
    saveMeta(session.partitionId, session.packageName, {...copy.meta, removed: [...copy.meta.removed, ...newlyRemoved]})
  }
  logNotKept(session.packageName, notKept)
}

/** Tests only. */
export function resetMiniappWebStorageForTests(): void {
  entriesCache.clear()
  overCapLogged.clear()
  recordStore?.clearAll()
}
