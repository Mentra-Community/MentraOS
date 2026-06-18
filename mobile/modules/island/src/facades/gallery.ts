/**
 * gallery facade — `toolkit.gallery`: the OEM-facing gallery-sync surface. Island's
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
  return {
    ...selectSyncProgress(s),
    isSyncing: selectIssyncing(s),
    glassesGallery: selectGlassesGalleryStatus(s),
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
}
