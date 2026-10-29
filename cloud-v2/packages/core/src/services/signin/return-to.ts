/**
 * @fileoverview Where a portal sends a person after sign-in.
 *
 * `return_to` is accepted only as a same-origin relative path. Anything that a
 * browser could read as another origin (`//evil`, `/\evil`, a scheme, an
 * encoded slash or backslash), a dot segment (`..`, also percent-encoded),
 * or a control character falls back to `/`.
 */

const MAX_RETURN_TO_LENGTH = 2048
const PLACEHOLDER_ORIGIN = "https://return-to.invalid"

export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > MAX_RETURN_TO_LENGTH) return "/"
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/"
  // Backslashes and control characters (including CR/LF) are never part of a safe path.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/"
  const path = raw.split(/[?#]/, 1)[0]!
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(path)
  } catch {
    return "/"
  }
  if (decodedPath.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decodedPath)) return "/"
  if (decodedPath.split("/").some(segment => segment === "." || segment === "..")) return "/"
  let resolved: URL
  try {
    resolved = new URL(raw, PLACEHOLDER_ORIGIN)
  } catch {
    return "/"
  }
  if (resolved.origin !== PLACEHOLDER_ORIGIN) return "/"
  return raw
}
