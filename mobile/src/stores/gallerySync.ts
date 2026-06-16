// Moved into @mentra/island. This shim re-exports it so existing `@/stores/gallerySync`
// importers stay unchanged — the Mentra-app escape hatch (also toolkit.stores.gallerySync).
export {
  useGallerySyncStore,
  selectSyncProgress,
  selectIssyncing,
  selectGlassesGalleryStatus,
} from "@mentra/island"
export type {PhotoInfo, SyncState, HotspotInfo, SyncQueue, GallerySyncInfo} from "@mentra/island"
