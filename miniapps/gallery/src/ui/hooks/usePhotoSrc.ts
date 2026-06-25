import {useEffect, useState} from "react"

import type {PhotoItem} from "../../shared/types"

/**
 * Resolve a photo's display source. A freshly captured photo carries its
 * still-alive cloud `url` (instant). Otherwise we ask background for the stored
 * bytes via the `gal:bytes` RPC and render the returned data URL. Resolved data
 * URLs are memoized so the grid doesn't re-fetch on every render.
 */
const cache = new Map<string, string>()

export function usePhotoSrc(item: PhotoItem): string | null {
  const [src, setSrc] = useState<string | null>(() => item.url ?? cache.get(item.id) ?? null)

  useEffect(() => {
    let alive = true
    if (item.url) {
      setSrc(item.url)
      return
    }
    const cached = cache.get(item.id)
    if (cached) {
      setSrc(cached)
      return
    }
    setSrc(null)
    void (async () => {
      try {
        const res = await mentra.request("gal:bytes", {id: item.id}, {timeout: 20_000})
        if (res?.dataUrl) cache.set(item.id, res.dataUrl)
        if (alive) setSrc(res?.dataUrl ?? null)
      } catch {
        if (alive) setSrc(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [item.id, item.url])

  return src
}
