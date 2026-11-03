/**
 * Pure rules for the URLs, paths and file names miniapp code hands the host.
 *
 * Miniapp code is untrusted: it may name the network, its own files, and
 * nothing else on the phone. No React Native or Expo imports, so these are
 * unit-testable alone (see miniappPaths.test.ts); miniappFiles.ts applies them
 * to the file system.
 */

/** A URL parser skips leading C0 controls and spaces before the scheme. */
// eslint-disable-next-line no-control-regex
const SCHEME = /^[\u0000- ]*([A-Za-z][A-Za-z0-9+.-]*):/

/** The URL's scheme, lowercased and without its colon, or null when it has none. */
export function urlScheme(url: unknown): string | null {
  if (typeof url !== "string") return null
  const match = SCHEME.exec(url)
  return match ? match[1].toLowerCase() : null
}

/**
 * True for http: and https: URLs, the only ones miniapp code may have the host
 * fetch or download. Every other scheme either reads the phone's own files
 * (file:, content:) or is not a network address.
 */
export function isNetworkUrl(url: unknown): url is string {
  const scheme = urlScheme(url)
  return scheme === "http" || scheme === "https"
}

/**
 * The absolute path a local `file:` URI names, percent-decoded and with `.` and
 * `..` resolved the way the file system will. Null for anything else: another
 * scheme, a remote host, a relative path, a bad escape or a NUL.
 */
export function filePathOfUri(uri: string): string | null {
  const match = /^file:\/\/(?:localhost)?(\/[^?#]*)(?:[?#].*)?$/i.exec(uri)
  if (!match) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return null
  }
  if (decoded.includes("\u0000")) return null
  return normalizeAbsolutePath(decoded)
}

/** `path` with empty, `.` and `..` segments resolved; `..` stops at the root. */
function normalizeAbsolutePath(path: string): string {
  const out: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") out.pop()
    else out.push(segment)
  }
  return `/${out.join("/")}`
}

/** True when absolute, normalized `path` is `dir` itself or inside it. */
export function isPathWithin(dir: string, path: string): boolean {
  const root = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir
  if (path.split("/").some((segment) => segment === "..")) return false
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`)
}

/**
 * True when `uri` names something strictly inside directory `dirUri`, as
 * written. Both are the host's own `file:` URIs or absolute paths (a miniapp's
 * URL goes through {@link filePathOfUri}, which takes no bare path). A symlink
 * is not resolved here (miniappFiles.ts does).
 */
export function isFileUriInside(dirUri: string, uri: string): boolean {
  const hostPath = (value: string) =>
    filePathOfUri(value.startsWith("/") ? `file://${value.split("/").map(encodeURIComponent).join("/")}` : value)
  const dir = hostPath(dirUri)
  const path = hostPath(uri)
  return !!dir && !!path && path !== dir && isPathWithin(dir, path)
}

/**
 * Path separators, characters other file systems refuse, control characters and
 * the bidirectional overrides that disguise an extension in a share sheet.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[/\\<>:"|?*\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g
/** Under every common file system's 255-byte name limit, with room for a suffix. */
const MAX_NAME_CHARS = 120
const MAX_NAME_BYTES = 200

/**
 * One safe file name from a name a miniapp supplied, for a file the host writes
 * in a directory it chose. Separators and unsafe characters become `_`, so the
 * result is a single path component: never empty, `.` or `..`, and within name
 * length limits with its extension kept. Falls back to `fallback`, made safe the
 * same way.
 */
export function safeFileName(name: unknown, fallback: string): string {
  const clean = (value: string) => value.replace(UNSAFE_NAME_CHARS, "_").trim()
  let safe = typeof name === "string" ? clean(name) : ""
  if (safe === "" || safe === "." || safe === "..") safe = clean(fallback)
  if (safe === "" || safe === "." || safe === "..") safe = "_"
  return boundFileName(safe)
}

/** Shorten the part before the extension until the name fits both limits. */
export function boundFileName(name: string): string {
  const fits = (value: string) =>
    value.length <= MAX_NAME_CHARS && new TextEncoder().encode(value).length <= MAX_NAME_BYTES
  if (fits(name)) return name
  const dot = name.lastIndexOf(".")
  const hasExt = dot > 0 && name.length - dot <= 16
  const suffix = hasExt ? name.slice(dot) : ""
  const base = Array.from(hasExt ? name.slice(0, dot) : name)
  while (base.length > 1 && !fits(base.join("") + suffix)) base.pop()
  const bounded = base.join("") + suffix
  return fits(bounded) ? bounded : Array.from(name).slice(0, 1).join("")
}
