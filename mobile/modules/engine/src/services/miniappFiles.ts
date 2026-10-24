/**
 * Where on the phone a miniapp's requests may touch files.
 *
 * Miniapp code is untrusted. A path it names is used only when it is inside the
 * directory that miniapp may use, both as written and once symlinks are
 * resolved; a file the host writes for it gets a name made safe by
 * {@link safeFileName}, in a new directory of the host's own. The pure rules are
 * in miniappPaths.ts.
 */

import CrustModule from "@mentra/crust"
import {Directory, File, Paths} from "expo-file-system"

import {filePathOfUri, isPathWithin, safeFileName} from "./miniappPaths"

/** Cache directory holding files handed to the share sheet, one new directory per handoff. */
const HANDOFF_DIR_NAME = "mentra_handoff"
/** Long enough for a receiving app to read a handoff after the sheet closes (as BlobStore's shares). */
const HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The canonical path of an existing file or directory, symlinks resolved, or
 * null. Null as well when the host cannot resolve paths, so nothing is allowed.
 */
export function canonicalPath(path: string): string | null {
  const native = CrustModule as unknown as {canonicalFilePath?: (path: string) => string | null} | undefined
  if (typeof native?.canonicalFilePath !== "function") return null
  try {
    const real = native.canonicalFilePath(path)
    return typeof real === "string" && real.startsWith("/") ? real : null
  } catch {
    return null
  }
}

/**
 * The first entry under `dir`, as a path relative to it, whose real path is not its own: a symbolic link, or a link
 * on the way to it. `"."` when `dir` itself can't be resolved, which includes a host that cannot resolve paths, so
 * nothing passes unchecked. Null when every entry is a plain file or directory. A linked directory is never entered.
 */
export function linkedEntry(dir: Directory): string | null {
  // The host's own directory and its listing: a `file:` URI, or an absolute path.
  const hostPath = (uri: string) =>
    filePathOfUri(uri.startsWith("/") ? `file://${uri.split("/").map(encodeURIComponent).join("/")}` : uri)
  const dirPath = hostPath(dir.uri)
  const realDir = dirPath ? canonicalPath(dirPath) : null
  if (!realDir) return "."
  const walk = (current: Directory, relative: string[]): string | null => {
    let items: ReturnType<Directory["list"]>
    try {
      items = current.list()
    } catch {
      return relative.join("/") || "."
    }
    for (const item of items) {
      const parts = [...relative, item.name]
      const itemPath = hostPath(item.uri)
      const real = itemPath ? canonicalPath(itemPath) : null
      if (real !== `${realDir.replace(/\/$/, "")}/${parts.join("/")}`) return parts.join("/")
      if (item instanceof Directory) {
        const found = walk(item, parts)
        if (found !== null) return found
      }
    }
    return null
  }
  return walk(dir, [])
}

/** True when `path` is strictly inside `dir`, both as written and once symlinks are resolved. */
function isInside(dir: string, path: string): boolean {
  if (path === dir || !isPathWithin(dir, path)) return false
  const realDir = canonicalPath(dir)
  const real = canonicalPath(path)
  return !!realDir && !!real && real !== realDir && isPathWithin(realDir, real)
}

/**
 * The existing file `uri` names when it is inside `dir`, both as written and
 * once symlinks are resolved. Null for any other URI or path.
 */
export function fileInside(dir: Directory, uri: unknown): File | null {
  if (typeof uri !== "string") return null
  const dirPath = filePathOfUri(dir.uri)
  const path = filePathOfUri(uri)
  if (!dirPath || !path || !isInside(dirPath, path)) return null
  // Built from the directory, so the File is the checked path, not another reading of the URI.
  const relative = path.slice(dirPath.replace(/\/$/, "").length + 1).split("/")
  const file = new File(dir, ...relative)
  return file.exists ? file : null
}

export interface Handoff {
  file: File
  /** The share sheet is done. The file stays for a day so a receiving app can still read it. */
  release: () => void
}

const activeHandoffs = new Set<string>()

/**
 * Write a file to hand to the share sheet. It is named `name` made safe
 * ({@link safeFileName}, falling back to `fallback`) and goes in a new, empty
 * directory under the cache, so it can't overwrite anything; `write` fills it.
 * The written file's real location is checked to be in that directory, or it is
 * deleted and this throws.
 */
export async function writeHandoffFile(
  name: unknown,
  fallback: string,
  write: (target: File) => void | File | Promise<void | File>,
): Promise<Handoff> {
  pruneHandoffs()
  const root = new Directory(Paths.cache, HANDOFF_DIR_NAME)
  if (!root.exists) root.create({intermediates: true})
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const dir = new Directory(root, id)
  dir.create()
  activeHandoffs.add(id)
  const release = () => {
    activeHandoffs.delete(id)
  }
  try {
    const cachePath = filePathOfUri(Paths.cache.uri)
    const dirPath = filePathOfUri(dir.uri)
    if (!cachePath || !dirPath || !isInside(cachePath, dirPath))
      throw new Error("handoff directory is outside the cache")
    const target = new File(dir, safeFileName(name, fallback))
    const written = (await write(target)) ?? target
    const writtenPath = filePathOfUri(written.uri)
    const realDir = canonicalPath(dirPath)
    const real = writtenPath ? canonicalPath(writtenPath) : null
    if (!realDir || !real || real.slice(0, real.lastIndexOf("/")) !== realDir) {
      throw new Error("handoff file is outside its directory")
    }
    return {file: written, release}
  } catch (error) {
    release()
    try {
      dir.delete()
    } catch {
      /* best effort */
    }
    throw error
  }
}

/** Delete handoffs older than a day that no open share sheet is using. Never throws. */
function pruneHandoffs(now = Date.now()): void {
  try {
    const root = new Directory(Paths.cache, HANDOFF_DIR_NAME)
    if (!root.exists) return
    for (const entry of root.list()) {
      if (activeHandoffs.has(entry.name)) continue
      const created = Number.parseInt(entry.name.split("-", 1)[0], 36)
      if (Number.isFinite(created) && now - created <= HANDOFF_MAX_AGE_MS) continue
      try {
        entry.delete()
      } catch {
        /* keep pruning the rest */
      }
    }
  } catch {
    // Pruning must never stop a share.
  }
}
