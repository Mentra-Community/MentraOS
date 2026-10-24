/**
 * @fileoverview A credential vault: Core credentials in the platform secure store (the iOS Keychain, Android
 * Keystore-backed encrypted storage), with a one-time move out of MMKV.
 *
 * MMKV is a plain file in the app's container. Once any URL can install a miniapp, nothing that grants a Core
 * session may sit in a file a page might read, so each credential owner (cloud-client's refresh tokens, the Mentra
 * App's account session) keeps its credentials in one secure-store item instead.
 *
 * One item per vault, holding every credential as JSON, so the move is one write: the item has every MMKV copy or
 * the move did not happen. The move runs once per process, before the vault's first read or write:
 *
 *  1. Collect the MMKV copies.
 *  2. Write them to the secure store and read the item back. Before the move has ever finished, what the store
 *     already holds is not trusted (the iOS Keychain outlives uninstalling the app), so the copies replace it; this
 *     also wipes a previous installation's credentials on a fresh install. After it finished, MMKV copies only
 *     reappear when an older build ran in between, so they are newer and win over the stored ones.
 *  3. Record that the move finished, in MMKV that logout never clears. Then delete the MMKV copies (and any
 *     credentials of retired sign-in providers), and overwrite what MMKV's append-only file keeps of them (recorded
 *     too, and retried each launch until it succeeds).
 *
 * Any failure keeps the MMKV copies and the process keeps using them, exactly as before; the next launch tries
 * again. A crash at any point is safe: the copies are deleted only after the record is saved, and a later launch
 * merges any copies still left. While MMKV copies exist they are the newest values, so a process that could not
 * finish the move writes to MMKV too.
 *
 * A delete never depends on the secure store: it is recorded in MMKV first (names only), every read leaves the
 * recorded keys out, and each launch retries until the store confirms. A sign-out cannot come back on a later launch.
 *
 * Values are never logged.
 */
import type {KeyValueStore} from "@mentra/cloud-client"

/** One item store in the platform's secure storage. */
export interface SecureItemStore {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  deleteItem(key: string): Promise<void>
}

/** Where a vault records that its move finished, and deletions not yet confirmed. Logout never clears it. */
export interface MoveRecordStore {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  remove(key: string): void
}

/** The credentials an owner kept in MMKV before the move, and the only code that touches them. */
export interface LegacyCredentials {
  /** Every MMKV copy, by key. */
  readAll(): Record<string, string>
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  /** Whether MMKV holds credentials of a retired sign-in provider, which nothing reads. */
  hasRetired(): boolean
  /** Delete every MMKV copy and every retired credential. */
  eraseAll(): void
  /**
   * Overwrite what the file still holds of removed values. Returns false when that could not be done this time.
   * Only called after `eraseAll`.
   */
  scrub(): boolean
}

export type CredentialLocation = "secure-store" | "mmkv"

/** A `KeyValueStore` (what cloud-client persists its refresh token in) backed by one secure-store item. */
export interface CredentialVault extends KeyValueStore {
  /** Delete every credential in the vault, without needing to read the stored item. */
  clear(): Promise<void>
  /** Where this process keeps the vault's credentials, once the move has run. */
  location(): Promise<CredentialLocation>
}

export interface CredentialVaultOptions {
  /** Names the secure-store item and the move record. */
  name: string
  secure: SecureItemStore
  /** Opened on first use. */
  moveRecord: () => MoveRecordStore
  legacy: LegacyCredentials
  log?: (message: string) => void
}

type Entries = Record<string, string>

type VaultState =
  | {location: "secure-store"; entries: Entries | null}
  // `storeTrusted`: the move finished in an earlier launch, so the store holds this installation's credentials
  // for keys MMKV no longer has.
  | {location: "mmkv"; storeTrusted: boolean}

const ITEM_FORMAT = 1
/** A recorded deletion of every credential in the vault. */
const ALL = "*"
/** The move finished; the MMKV file may still hold removed copies. */
const MOVED = "moved-v1"
/** The move finished and the MMKV file was scrubbed. */
const SCRUBBED = "scrubbed-v1"

function noop(): void {}

function errorText(error: unknown): string {
  // Error messages from the secure store and MMKV name keys and status codes, never values.
  return error instanceof Error ? error.message : String(error)
}

function encodeEntries(entries: Entries): string {
  return JSON.stringify({format: ITEM_FORMAT, entries})
}

function isEntries(value: unknown): value is Entries {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === "string")
}

export function createCredentialVault(options: CredentialVaultOptions): CredentialVault {
  const itemKey = `mentra.credentials.${options.name}`
  const recordKey = `${options.name}.secureStore`
  const deletionsKey = `${options.name}.deleted`
  const tag = `CREDENTIALS(${options.name})`
  const log = options.log ?? ((message: string) => console.log(message))

  let state: VaultState | null = null
  let queue: Promise<unknown> = Promise.resolve()

  /** Every operation runs in call order, after the move, so a write is never lost to a concurrent read-modify-write. */
  function serialized<T>(operation: (current: VaultState) => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      state ??= await move()
      return operation(state)
    })
    queue = run.then(noop, noop)
    return run
  }

  function decodeEntries(text: string | null): Entries {
    if (text === null) return {}
    try {
      const parsed = JSON.parse(text) as {format?: unknown; entries?: unknown}
      if (parsed?.format === ITEM_FORMAT && isEntries(parsed.entries)) return {...parsed.entries}
    } catch {
      // Reported below.
    }
    log(`${tag}: the secure-store item is unreadable; treating it as empty`)
    return {}
  }

  /** Deletions the secure store has not confirmed yet. */
  function pendingDeletions(): string[] {
    const text = options.moveRecord().getString(deletionsKey)
    if (!text) return []
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.filter((key): key is string => typeof key === "string")
    } catch {
      // A damaged record still means something was deleted: assume everything was.
    }
    return [ALL]
  }

  function recordDeletion(key: string): void {
    const pending = pendingDeletions()
    if (pending.includes(ALL) || pending.includes(key)) return
    options.moveRecord().set(deletionsKey, JSON.stringify(key === ALL ? [ALL] : [...pending, key]))
  }

  function deletionsConfirmed(): void {
    if (options.moveRecord().getString(deletionsKey) !== undefined) options.moveRecord().remove(deletionsKey)
  }

  function withoutDeleted(entries: Entries, pending: string[] = pendingDeletions()): Entries {
    if (pending.length === 0) return entries
    if (pending.includes(ALL)) return {}
    const kept = {...entries}
    for (const key of pending) delete kept[key]
    return kept
  }

  /** The stored credentials, less recorded deletions. */
  async function readStore(): Promise<Entries> {
    return withoutDeleted(decodeEntries(await options.secure.getItem(itemKey)))
  }

  /** Make the store match the recorded deletions. Until it does, they stay recorded and reads keep leaving them out. */
  async function applyDeletions(): Promise<void> {
    const pending = pendingDeletions()
    if (pending.length === 0) return
    try {
      if (pending.includes(ALL)) {
        await options.secure.deleteItem(itemKey)
      } else {
        const stored = decodeEntries(await options.secure.getItem(itemKey))
        const kept = withoutDeleted(stored, pending)
        if (Object.keys(kept).length !== Object.keys(stored).length) {
          await options.secure.setItem(itemKey, encodeEntries(kept))
        }
      }
      deletionsConfirmed()
    } catch (error) {
      log(`${tag}: a deletion is not in the secure store yet; it stays deleted and is retried (${errorText(error)})`)
    }
  }

  function scrubLegacyFile(): void {
    try {
      if (!options.legacy.scrub()) {
        log(`${tag}: could not overwrite the removed MMKV copies yet; retrying next launch`)
        return
      }
      options.moveRecord().set(recordKey, SCRUBBED)
    } catch (error) {
      log(`${tag}: could not overwrite the removed MMKV copies yet; retrying next launch (${errorText(error)})`)
    }
  }

  /** After the move: delete retired credentials whenever they turn up, then scrub what is pending. */
  function eraseRetired(record: string | undefined): void {
    try {
      if (!options.legacy.hasRetired()) {
        if (record === MOVED) scrubLegacyFile()
        return
      }
      options.moveRecord().set(recordKey, MOVED)
      options.legacy.eraseAll()
      log(`${tag}: deleted retired credentials from MMKV`)
    } catch (error) {
      log(`${tag}: could not delete retired credentials from MMKV (${errorText(error)})`)
      return
    }
    scrubLegacyFile()
  }

  async function move(): Promise<VaultState> {
    let record: string | undefined
    let copies: Entries
    try {
      record = options.moveRecord().getString(recordKey)
      copies = options.legacy.readAll()
    } catch (error) {
      log(`${tag}: could not read MMKV; credentials stay there until the next launch (${errorText(error)})`)
      return {location: "mmkv", storeTrusted: false}
    }
    const moved = record === MOVED || record === SCRUBBED
    const count = Object.keys(copies).length
    if (moved && count === 0) {
      eraseRetired(record)
      await applyDeletions()
      log(`${tag}: credentials are in the secure store`)
      return {location: "secure-store", entries: null}
    }

    let entries: Entries
    try {
      entries = {...(moved ? await readStore() : {}), ...copies}
      const written = encodeEntries(entries)
      await options.secure.setItem(itemKey, written)
      if ((await options.secure.getItem(itemKey)) !== written) throw new Error("the secure store read back other data")
      // The written item leaves out every recorded deletion (or replaces an untrusted item wholesale).
      deletionsConfirmed()
      // Also after a scrub: the copies about to be removed need scrubbing again.
      if (record !== MOVED) {
        const moveRecord = options.moveRecord()
        moveRecord.set(recordKey, MOVED)
        if (moveRecord.getString(recordKey) !== MOVED) throw new Error("the move record was not saved")
      }
    } catch (error) {
      log(`${tag}: move failed; keeping the MMKV copies and retrying next launch (${errorText(error)})`)
      return {location: "mmkv", storeTrusted: moved}
    }

    try {
      options.legacy.eraseAll()
    } catch (error) {
      // The store has everything, but MMKV copies that stay behind would win next launch: keep them current.
      log(`${tag}: moved, but could not delete the MMKV copies; using them until the next launch (${errorText(error)})`)
      return {location: "mmkv", storeTrusted: true}
    }
    scrubLegacyFile()
    log(`${tag}: moved ${count} credential(s) from MMKV to the secure store`)
    return {location: "secure-store", entries}
  }

  async function storedEntries(current: Extract<VaultState, {location: "secure-store"}>): Promise<Entries> {
    current.entries ??= await readStore()
    return current.entries
  }

  async function writeEntries(current: Extract<VaultState, {location: "secure-store"}>, next: Entries): Promise<void> {
    // On failure the item may or may not have changed: read it again next time.
    current.entries = null
    await options.secure.setItem(itemKey, encodeEntries(next))
    current.entries = next
    // `next` came from reads that leave recorded deletions out, so the store now matches them.
    deletionsConfirmed()
  }

  return {
    get(key: string): Promise<string | null> {
      return serialized(async (current) => {
        if (current.location === "secure-store") return (await storedEntries(current))[key] ?? null
        const copy = options.legacy.get(key)
        if (copy !== null || !current.storeTrusted) return copy
        // A read error stays an error: "unavailable", not "signed out".
        return (await readStore())[key] ?? null
      })
    },

    set(key: string, value: string): Promise<void> {
      return serialized(async (current) => {
        if (current.location === "mmkv") {
          options.legacy.set(key, value)
          return
        }
        const entries = await storedEntries(current)
        await writeEntries(current, {...entries, [key]: value})
        // Nothing writes MMKV after the move; should a copy appear anyway, it is older than this value.
        options.legacy.remove(key)
      })
    },

    delete(key: string): Promise<void> {
      return serialized(async (current) => {
        // A sign-out deletes the credential from both places. Also when this launch could not tell whether the move
        // had finished (MMKV unreadable): deleting from a store the move later replaces is harmless.
        options.legacy.remove(key)
        recordDeletion(key)
        if (current.location === "secure-store" && current.entries) {
          const {[key]: _removed, ...rest} = current.entries
          current.entries = rest
        }
        await applyDeletions()
      })
    },

    clear(): Promise<void> {
      return serialized(async (current) => {
        options.legacy.eraseAll()
        recordDeletion(ALL)
        if (current.location === "secure-store") current.entries = {}
        await applyDeletions()
      })
    },

    location(): Promise<CredentialLocation> {
      return serialized(async (current) => current.location)
    },
  }
}
