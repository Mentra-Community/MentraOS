export interface GalleryLoadOptions {
  refreshAfterCurrent?: boolean
}

export interface GalleryLoadCoordinator {
  run(load: () => Promise<void>, options?: GalleryLoadOptions): Promise<void>
}

/**
 * Coalesce duplicate lifecycle loads while preserving refreshes requested after
 * storage mutations such as sync completion or deletion.
 */
export function createGalleryLoadCoordinator(): GalleryLoadCoordinator {
  let inFlight: Promise<void> | null = null
  let queuedLoad: (() => Promise<void>) | null = null

  return {
    run(load, {refreshAfterCurrent = true} = {}) {
      if (inFlight) {
        // Lifecycle calls may share the current request, but only a storage
        // mutation is allowed to replace the queued refresh callback.
        if (refreshAfterCurrent) queuedLoad = load
        return inFlight
      }

      const request = (async () => {
        let nextLoad: (() => Promise<void>) | null = load
        while (nextLoad) {
          await nextLoad()
          nextLoad = queuedLoad
          queuedLoad = null
        }
      })()

      inFlight = request
      const clearRequest = () => {
        if (inFlight === request) inFlight = null
      }
      void request.then(clearRequest, clearRequest)
      return request
    },
  }
}
