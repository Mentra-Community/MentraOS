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
  let refreshRequested = false
  let latestLoad: (() => Promise<void>) | null = null

  return {
    run(load, {refreshAfterCurrent = true} = {}) {
      latestLoad = load
      if (inFlight) {
        if (refreshAfterCurrent) refreshRequested = true
        return inFlight
      }

      const request = (async () => {
        do {
          refreshRequested = false
          await latestLoad?.()
        } while (refreshRequested)
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
