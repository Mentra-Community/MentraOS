/**
 * gallery facade — `engine.gallery`: the OEM-facing gallery-sync surface. Engine's
 * gallerySyncService orchestrates the sync (hotspot → wifi → HTTP fetch → process →
 * store); this facade exposes the projected status + the structured notices the host
 * renders its own UI from, plus the sync/cancel actions. No host-injected UI — the host
 * owns all alerts/navigation/i18n (it renders them off `onNotice`).
 */
import {
  useGallerySyncStore,
  selectSyncProgress,
  selectIssyncing,
  selectGlassesGalleryStatus,
} from "../stores/gallerySync"
import {gallerySyncService} from "../services/asg/gallerySyncService"
import {onGalleryNotice, type GalleryNotice} from "../services/asg/galleryNotices"

function projectStatus() {
  const s = useGallerySyncStore.getState()
  const progress = selectSyncProgress(s)
  return {
    ...progress,
    processingFiles: Array.from(progress.processingFiles),
    processedFiles: s.processedFiles,
    isSyncing: selectIssyncing(s),
    isStarting: s.syncStarting,
    glassesGallery: selectGlassesGalleryStatus(s),
    // Copy: the snapshot must not hand callers a mutable reference into the store
    // (each queue item is copied too — callers must not mutate them in place).
    queue: s.queue.map((item) => ({...item})),
    queueLength: s.queue.length,
    queueIndex: s.queueIndex,
  }
}

export type GallerySyncStatus = ReturnType<typeof projectStatus>

export const gallery = {
  /** Snapshot of the current sync state + progress. */
  status: (): GallerySyncStatus => projectStatus(),
  /** Subscribe to sync-state changes; returns an unsubscribe. Deduped on the projected
   * status (the gallerySync store mutates many unrelated fields during a sync), so the
   * host only re-renders when the projection actually changes — matches the other
   * read-model facades. */
  onStatus: (cb: (status: GallerySyncStatus) => void): (() => void) => {
    let last = JSON.stringify(projectStatus())
    return useGallerySyncStore.subscribe(() => {
      const status = projectStatus()
      const serialized = JSON.stringify(status)
      if (serialized === last) return
      last = serialized
      cb(status)
    })
  },
  /** Subscribe to user-actionable notices (host renders alerts / settings deep-links). */
  onNotice: (cb: (notice: GalleryNotice) => void): (() => void) => onGalleryNotice(cb),

  /** Start a gallery sync (the host gates connectivity/permissions first). */
  sync: (): Promise<void> => gallerySyncService.startSync(),
  /** Cancel an in-progress sync. */
  cancel: (): Promise<void> => gallerySyncService.cancelSync(),
  /** Ask glasses to refresh their gallery summary counts. */
  refreshStatus: (): Promise<void> => gallerySyncService.queryGlassesGalleryStatus(),
  /** Remove local files from the current gallery queue after host-owned deletion UI completes. */
  removeFilesFromQueue: (fileNames: string[]): void => useGallerySyncStore.getState().removeFilesFromQueue(fileNames),
  /** Clear the current gallery sync queue after host-owned bulk deletion completes. */
  clearQueue: (): void => useGallerySyncStore.getState().clearQueue(),
  /** Clear the cached glasses gallery summary when product UI observes disconnect. */
  clearGlassesGalleryStatus: (): void => useGallerySyncStore.getState().clearGlassesGalleryStatus(),
}
