/**
 * Typed channel registry — the single source of truth for every name that
 * flows between this miniapp's background JSContext and its UI WebView. Both
 * halves import this file; the bundler inlines it (no runtime I/O).
 */

import type {MentraTyped, Rpc} from "@mentra/miniapp/ui"

import type {CaptureStatus, GallerySettings, GallerySnapshot, PhotoItem, Usage} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────
  "gal:snapshot": GallerySnapshot
  "gal:status": CaptureStatus
  "gal:photos": {photos: PhotoItem[]; usage: Usage}

  // ── UI → background broadcasts ─────────────────────────────────────────
  "gal:request-snapshot": Record<string, never>
  "gal:capture": Record<string, never>
  "gal:delete": {ids: string[]}
  "gal:share": {id: string}
  "gal:favorite": {id: string; favorite: boolean}
  "gal:set-settings": Partial<GallerySettings>
  "gal:clear": Record<string, never>

  // ── UI → background RPC ────────────────────────────────────────────────
  /** Read a stored photo's bytes for durable display (base64 data: URL). */
  "gal:bytes": Rpc<{id: string}, {dataUrl: string | null}>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
