/**
 * The origin each package's screen loads from, when the Mentra App serves it: an installed bundle's own origin
 * (`miniappOrigin.ts`). The launcher records it as it spawns the package, and the miniapp's view records the screen it
 * loads each time one opens. A live development build's screen loads from its development server, which the app
 * doesn't serve, so it has none.
 *
 * That origin also serves the package's own files (the blobs the host stores for it, such as its photos) under
 * {@link MINIAPP_FILES_PATH}, so the screen can load one with a plain same-origin URL.
 */

/** The path a package's own files are served under on its origin. The WebView's `miniappOrigin` reserves it. */
export const MINIAPP_FILES_PATH = "/.mentra/files/"

const origins = new Map<string, string>()

/** Record the origin `packageName`'s screen loads from, or null when the app doesn't serve it. */
export function recordMiniappScreenOrigin(packageName: string, origin: string | null): void {
  if (origin) origins.set(packageName, origin)
  else origins.delete(packageName)
}

/**
 * The URL `packageName`'s screen loads one of its own files from, by the file's name on disk. Null when the app
 * doesn't serve the screen, or the name isn't a plain file name.
 */
export function miniappFileUrl(packageName: string, fileName: string): string | null {
  const origin = origins.get(packageName)
  if (!origin || !fileName || fileName === "." || fileName === ".." || /[/\\]/.test(fileName)) return null
  return `${origin}${MINIAPP_FILES_PATH}${encodeURIComponent(fileName)}`
}

/** Tests only. */
export function resetMiniappScreenOriginsForTests(): void {
  origins.clear()
}
