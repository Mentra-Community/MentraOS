/**
 * Every miniapp's data of one account, as a whole: what signing out keeps and deleting the account erases.
 *
 * A miniapp's private data lives in its account's data partitions (`miniappDataPartition.ts`): its SDK storage
 * (`LocalMiniappStorage.ts`), its saved files and their records (`BlobStore.ts`) and its screen's `localStorage` copy
 * (`miniappWebStorage.ts`). A partition belongs to one account on one Core, so another account never reads it, and
 * signing out leaves it in place: signing back in finds it exactly as it was. Only deleting the account erases it,
 * with {@link deleteMiniappDataOfAccount}.
 */
import {Directory, Paths} from "expo-file-system"

import {storage} from "../utils/storage/storage"
import {sanitizeSegment} from "./blobPaths"
import {
  forgetMiniappDataAccount,
  isDevelopmentSelectionKey,
  lastMiniappDataSession,
  partitionIdOf,
  type MiniappDataSession,
} from "./miniappDataPartition"

/** The key roots of the default MMKV instance that hold partitioned miniapp data: `<root><partitionId>/…`. */
const PARTITIONED_KEY_ROOTS = ["mentraos_miniappdata/", "mentraos_blobmeta/", "mentraos_miniappwebstorage/"] as const
/** Keys from before partitions, scoped by user id alone, and the markers of their move into a partition. */
const LEGACY_KEY_ROOTS = ["mentraos_localstorage_", "mentraos_blobmeta_"] as const
const MIGRATED_KEY_ROOTS = ["mentraos_miniappdata_migrated/", "mentraos_blobmeta_migrated/"] as const
const BLOB_ROOT_DIR_NAME = "mentra_blobs"

/** The installed version a package runs: a pointer into the installs on disk, which are the phone's. */
const ACTIVE_VERSION_SUFFIX = "_active_version"

/**
 * Whether signing out leaves a miniapp key of the default MMKV instance where it is, because it already belongs to
 * one account or to the phone, never to whoever is signed in:
 *
 * - data in an account's partitions, or kept for one account by its user id (from before partitions, and the
 *   markers of its move);
 * - development selections, which `miniappDataPartition.ts` swaps per account and workspace when the account changes;
 * - the installed version each package runs, as the installs themselves stay on the phone.
 */
export function isMiniappKeyKeptAtSignOut(key: string): boolean {
  return (
    PARTITIONED_KEY_ROOTS.some((root) => key.startsWith(root)) ||
    LEGACY_KEY_ROOTS.some((root) => key.startsWith(root)) ||
    MIGRATED_KEY_ROOTS.some((root) => key.startsWith(root)) ||
    isDevelopmentSelectionKey(key) ||
    key.endsWith(ACTIVE_VERSION_SUFFIX)
  )
}

/**
 * The prefix every partition id of `session`'s account starts with: personal, each workspace's, and local builds'.
 * No escaped segment of a partition id contains a `.`, so no other account's partition id starts with it.
 */
function accountPartitionPrefix(session: MiniappDataSession): string {
  const personal = partitionIdOf({...session, workspaceId: null})
  return personal.slice(0, -"p".length)
}

/**
 * Erase every miniapp's data of `session`'s account on this phone: every partition's SDK storage, saved files and
 * their records, and screen `localStorage` copies; its data from before partitions; and what the partition store
 * records for it. For deleting the account; signing out keeps all of it. Without `session`, the account whose data
 * was last used. Best effort: a part that cannot be deleted is logged and the rest still goes.
 */
export function deleteMiniappDataOfAccount(session: MiniappDataSession | null = lastMiniappDataSession()): void {
  if (!session?.mentraUserId?.trim()) return
  const prefix = accountPartitionPrefix(session)
  const userId = session.mentraUserId.trim()
  const legacyPrefixes = [`mentraos_localstorage_${userId}_`, `mentraos_blobmeta_${sanitizeSegment(userId)}_`]
  const markerPrefixes = MIGRATED_KEY_ROOTS.map((root) => `${root}${userId}/`)

  const removed = storage.getAllKeys().filter((key) => {
    for (const root of PARTITIONED_KEY_ROOTS) if (key.startsWith(root + prefix)) return true
    return legacyPrefixes.some((p) => key.startsWith(p)) || markerPrefixes.some((p) => key.startsWith(p))
  })
  if (removed.length > 0) {
    const res = storage.removeMultiple(removed)
    if (res.is_error()) console.error("MINIAPP_ACCOUNT_DATA: could not delete the account's miniapp data", res.error)
  }

  try {
    const root = new Directory(Paths.document, BLOB_ROOT_DIR_NAME)
    if (root.exists) {
      for (const entry of root.list()) {
        if (!(entry instanceof Directory)) continue
        if (entry.name.startsWith(prefix) || entry.name === sanitizeSegment(userId)) entry.delete()
      }
    }
  } catch (error) {
    console.error("MINIAPP_ACCOUNT_DATA: could not delete the account's miniapp files", error)
  }

  forgetMiniappDataAccount(session)
}
