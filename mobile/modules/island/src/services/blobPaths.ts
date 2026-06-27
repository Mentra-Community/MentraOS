/**
 * Pure path helper for BlobStore. No React Native / Expo imports, so it's
 * unit-testable in isolation (see blobPaths.test.ts).
 */

/** Filesystem-safe path segment. Strips traversal + unsafe chars; never empty. */
export function sanitizeSegment(s: string): string {
  const cleaned = (s || "").replace(/[^A-Za-z0-9._-]/g, "_")
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_"
  return cleaned.slice(0, 120)
}
