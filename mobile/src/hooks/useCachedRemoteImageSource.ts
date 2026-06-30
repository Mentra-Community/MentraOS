import {Image} from "expo-image"
import {useEffect, useState} from "react"
import type {ImageSourcePropType} from "react-native"

const inflight = new Map<string, Promise<string | null>>()
const resolvedCache = new Map<string, string>()

async function resolveCachedPath(url: string): Promise<string | null> {
  if (resolvedCache.has(url)) return resolvedCache.get(url)!
  if (inflight.has(url)) return inflight.get(url)!

  const promise = (async () => {
    try {
      let path = await Image.getCachePathAsync(url)
      if (!path) {
        const ok = await Image.prefetch(url, {cachePolicy: "memory-disk"})
        if (!ok) return null
        path = await Image.getCachePathAsync(url)
      }
      if (path) {
        const fileUri = path.startsWith("file://") ? path : `file://${path}`
        resolvedCache.set(url, fileUri)
        return fileUri
      }
      return null
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

export function useCachedRemoteImageSource(source: string | number | undefined | null): ImageSourcePropType {
  const url = typeof source === "string" ? source : null
  const isRemote = url !== null && (url.startsWith("http://") || url.startsWith("https://"))
  const [resolved, setResolved] = useState<string | null>(() =>
    isRemote ? resolvedCache.get(url!) ?? null : null,
  )

  useEffect(() => {
    if (!isRemote) {
      setResolved(null)
      return
    }
    const cached = resolvedCache.get(url!) ?? null
    setResolved(cached)
    if (cached) return

    let cancelled = false
    resolveCachedPath(url!).then((path) => {
      if (!cancelled && path) setResolved(path)
    })
    return () => {
      cancelled = true
    }
  }, [isRemote, url])

  if (isRemote) return {uri: resolved ?? url!}
  if (typeof source === "string") return {uri: source}
  if (typeof source === "number") return source
  return {uri: ""}
}
