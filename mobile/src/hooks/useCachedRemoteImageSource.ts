import {Image} from "expo-image"
import {useEffect, useState} from "react"
import type {ImageSourcePropType} from "react-native"

const inflight = new Map<string, Promise<string | null>>()
const resolvedCache = new Map<string, string>()
const failedCache = new Set<string>()

async function resolveCachedPath(url: string): Promise<string | null> {
  if (failedCache.has(url)) return null
  if (resolvedCache.has(url)) return resolvedCache.get(url)!
  if (inflight.has(url)) return inflight.get(url)!

  const promise = (async () => {
    try {
      let path = await Image.getCachePathAsync(url)
      if (!path) {
        const ok = await Image.prefetch(url, {cachePolicy: "memory-disk"})
        if (!ok) {
          failedCache.add(url)
          return null
        }
        path = await Image.getCachePathAsync(url)
      }
      if (path) {
        const fileUri = path.startsWith("file://") ? path : `file://${path}`
        resolvedCache.set(url, fileUri)
        return fileUri
      }
      // Prefetch succeeded but the image isn't on disk. This is the dev-miniapp
      // case: `mentra dev`'s static server serves the tile icon with
      // `Cache-Control: no-store`, so expo-image downloads it (prefetch → true)
      // but never persists it, leaving getCachePathAsync null forever. Returning
      // null here would (mis)mark the icon as failed and the dev tile would show
      // its placeholder instead of the real logo. The bytes are valid and already
      // warm in expo-image's MEMORY cache from the prefetch above, so fall back to
      // the original URL: <Image> renders it straight from memory. This only
      // happens after a *successful* prefetch, so it never reintroduces the
      // failed/slow-remote decode thrash this hook otherwise guards against.
      resolvedCache.set(url, url)
      return url
    } finally {
      inflight.delete(url)
    }
  })()

  inflight.set(url, promise)
  return promise
}

/**
 * Warm the resolved-path cache for a set of remote URLs ahead of render. After
 * this resolves, `useCachedRemoteImageSource` returns the local file:// path
 * synchronously on first render (cache hit), so the image points straight at
 * the decoded file with no post-mount async swap. Used to gate the all-apps
 * grid reveal until every icon is ready, so they all appear at once.
 *
 * Returns once every URL has settled (resolved or failed). Non-remote / empty
 * URLs are ignored.
 */
export async function warmCachedRemoteImageSources(urls: Array<string | null | undefined>): Promise<void> {
  const remote = urls.filter(
    (u): u is string => typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://")),
  )
  await Promise.allSettled(remote.map((u) => resolveCachedPath(u)))
}

/** True once this remote URL's local path is cached and will resolve synchronously. */
export function isCachedRemoteImageResolved(url: string | null | undefined): boolean {
  return typeof url === "string" && resolvedCache.has(url)
}

export function markRemoteImageSourceFailed(url: string | null | undefined): void {
  if (typeof url !== "string" || url.length === 0) return
  failedCache.add(url)
  resolvedCache.delete(url)
}

export function isRemoteImageSourceFailed(url: string | null | undefined): boolean {
  return typeof url === "string" && failedCache.has(url)
}

export function useCachedRemoteImageSource(
  source: string | number | undefined | null,
  options: {enabled?: boolean} = {},
): ImageSourcePropType {
  const url = typeof source === "string" ? source : null
  const isRemote = url !== null && (url.startsWith("http://") || url.startsWith("https://"))
  const enabled = options.enabled ?? true
  const [resolved, setResolved] = useState<string | null>(() =>
    isRemote && enabled ? resolvedCache.get(url!) ?? null : null,
  )
  const [failed, setFailed] = useState(() => (isRemote ? failedCache.has(url!) : false))

  useEffect(() => {
    if (!isRemote || !enabled) {
      setResolved(null)
      setFailed(false)
      return
    }
    const cached = resolvedCache.get(url!) ?? null
    const cachedFailure = failedCache.has(url!)
    setResolved(cached)
    setFailed(cachedFailure)
    if (cached || cachedFailure) return

    let cancelled = false
    resolveCachedPath(url!).then((path) => {
      if (cancelled) return
      if (path) {
        setResolved(path)
        setFailed(false)
      } else {
        setResolved(null)
        setFailed(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, isRemote, url])

  if (isRemote) {
    // Do not hand remote URLs directly to ExpoImage here. Failed/slow remote
    // images can trigger repeated native decode work on Android's main/render
    // threads. The hook prefetches into disk cache first, then swaps to file://.
    return {uri: enabled && !failed ? resolved ?? "" : ""}
  }
  if (typeof source === "string") return {uri: source}
  if (typeof source === "number") return source
  return {uri: ""}
}
