/**
 * @fileoverview A lock that one command at a time holds across processes.
 *
 * The lock is a directory holding a `holder` file with its holder's random id.
 * It is made complete under another name and renamed into place, which fails
 * while a lock exists (a directory is never renamed onto a non-empty one), so
 * there is never a lock without its holder. The holder touches its file every
 * `heartbeatMs`; a lock whose file was not touched for `staleMs` belongs to a
 * command that died or hung, and is taken over.
 *
 * Taking a lock away, over or on release, renames it to a tombstone named after
 * the holder that was inspected (`<lock>.gone-<holder>`). That rename can happen
 * once per holder: the tombstone then exists and is not empty, so a command that
 * inspected a holder whose lock is already gone fails, instead of moving the lock
 * that replaced it. A taken-over lock's tombstone is kept for `tombstoneMs`, much
 * longer than the two consecutive calls between inspecting and renaming; a
 * released one is removed at once, since its holder was alive and nobody could
 * have judged it stale. Acquiring clears old tombstones and abandoned attempts.
 */

import {randomUUID} from "node:crypto"
import {
  closeSync,
  fstatSync,
  futimesSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import {basename, dirname, join} from "node:path"

export interface FileLockOptions {
  /** A lock untouched for this long belongs to a command that died, and is taken over. */
  staleMs: number
  /** How long to wait for another command's lock before giving up with `busyMessage`. */
  waitMs: number
  busyMessage: string
  /** How often the holder touches its lock. Default: a quarter of `staleMs`. */
  heartbeatMs?: number
  /** How long a taken-over lock's tombstone is kept. Default: ten minutes. */
  tombstoneMs?: number
}

/** A lock as one inspection found it. */
export interface InspectedLock {
  holder: string
  /** When its holder last touched it (ms since the epoch). */
  touchedAt: number
}

const HOLDER_FILE = "holder"
const POLL_MS = 100
const DEFAULT_TOMBSTONE_MS = 10 * 60_000
/** What renaming onto an existing lock fails with, by platform. */
const LOCK_IN_THE_WAY = new Set(["ENOTEMPTY", "EEXIST", "EPERM", "EACCES", "EBUSY"])

/** Run `work` holding the lock at `path`, waiting for (or taking over) another command's. */
export async function withFileLock<T>(path: string, options: FileLockOptions, work: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700})
  clearLeftovers(path, options.tombstoneMs ?? DEFAULT_TOMBSTONE_MS)
  const deadline = Date.now() + options.waitMs
  let holder: string | null
  for (;;) {
    holder = tryAcquire(path)
    if (holder) break
    const seen = inspectLock(path)
    if (seen && Date.now() - seen.touchedAt > options.staleMs && takeOverStaleLock(path, seen)) continue
    if (Date.now() > deadline) throw new Error(options.busyMessage)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }

  // Touch our own holder file (by descriptor, so never another command's) while the work runs.
  const fd = openSync(join(path, HOLDER_FILE), "r+")
  const heartbeat = setInterval(
    () => {
      const now = new Date()
      try {
        futimesSync(fd, now, now)
      } catch {
        // Nothing to keep fresh: the next touch or the release sorts it out.
      }
    },
    options.heartbeatMs ?? Math.max(1, Math.floor(options.staleMs / 4)),
  )
  heartbeat.unref()
  try {
    return await work()
  } finally {
    clearInterval(heartbeat)
    closeSync(fd)
    release(path, holder)
  }
}

/** The lock at `path` as it is now, or null when there is none. */
export function inspectLock(path: string): InspectedLock | null {
  let fd: number
  try {
    fd = openSync(join(path, HOLDER_FILE), "r")
  } catch (error) {
    if (!isMissing(error)) throw error
    // No lock, or a directory without a holder (not made by this module): judge it by the directory.
    try {
      const dir = statSync(path)
      return {holder: `dir-${dir.ino}-${Math.round(dir.birthtimeMs)}`, touchedAt: dir.mtimeMs}
    } catch (inner) {
      if (isMissing(inner)) return null
      throw inner
    }
  }
  try {
    // One descriptor: the holder and the time come from the same file.
    return {holder: readFileSync(fd, "utf8"), touchedAt: fstatSync(fd).mtimeMs}
  } finally {
    closeSync(fd)
  }
}

/**
 * Move the lock `seen` found at `path` to its tombstone, if it is still there. True when it was;
 * false when it was already gone, whatever has replaced it since.
 */
export function takeOverStaleLock(path: string, seen: InspectedLock): boolean {
  const tombstone = tombstoneOf(path, seen.holder)
  try {
    renameSync(path, tombstone)
  } catch {
    // Gone already (no lock, or this holder's tombstone exists): nothing of ours to move.
    return false
  }
  // Date the tombstone from now, for `tombstoneMs`; a holder-less directory gets a holder so a
  // later rename onto its tombstone fails too.
  try {
    writeFileSync(join(tombstone, HOLDER_FILE), seen.holder, {flag: "wx"})
  } catch {
    // It has its holder already.
  }
  const now = new Date()
  utimesSync(tombstone, now, now)
  return true
}

/** Create the lock with a new holder; null while another command holds it. */
function tryAcquire(path: string): string | null {
  const holder = randomUUID()
  const prepared = `${path}.new-${holder}`
  mkdirSync(prepared, {mode: 0o700})
  writeFileSync(join(prepared, HOLDER_FILE), holder)
  try {
    renameSync(prepared, path)
    return holder
  } catch (error) {
    rmSync(prepared, {recursive: true, force: true})
    // A lock in the way (Windows says EPERM): try again, even if it has been released meanwhile.
    if (LOCK_IN_THE_WAY.has((error as {code?: string})?.code ?? "")) return null
    throw error
  }
}

/** Remove our lock, if it is still ours: after a takeover it belongs to the command that took it. */
function release(path: string, holder: string): void {
  const tombstone = tombstoneOf(path, holder)
  try {
    renameSync(path, tombstone)
  } catch {
    return
  }
  if (readHolder(tombstone) === holder) {
    rmSync(tombstone, {recursive: true, force: true})
    return
  }
  // Ours was taken over so long ago that its tombstone is gone, and this moved its successor: put it back.
  try {
    renameSync(tombstone, path)
  } catch {
    // Yet another command holds the lock now; the moved one is cleared with the other leftovers.
  }
}

/** Remove tombstones and abandoned attempts older than `tombstoneMs`. */
function clearLeftovers(path: string, tombstoneMs: number): void {
  const prefix = `${basename(path)}.`
  const parent = dirname(path)
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(`${prefix}gone-`) && !name.startsWith(`${prefix}new-`)) continue
    const entry = join(parent, name)
    try {
      const stat = statSync(entry)
      // A rename updates ctime, and a takeover also stamps mtime: either says when it became a tombstone.
      if (Date.now() - Math.max(stat.ctimeMs, stat.mtimeMs) > tombstoneMs) {
        rmSync(entry, {recursive: true, force: true})
      }
    } catch {
      // Removed meanwhile.
    }
  }
}

function tombstoneOf(path: string, holder: string): string {
  return `${path}.gone-${holder.replace(/[^A-Za-z0-9-]/g, "_")}`
}

function readHolder(dir: string): string | null {
  try {
    return readFileSync(join(dir, HOLDER_FILE), "utf8")
  } catch {
    return null
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as {code?: string})?.code
  return code === "ENOENT" || code === "ENOTDIR"
}
