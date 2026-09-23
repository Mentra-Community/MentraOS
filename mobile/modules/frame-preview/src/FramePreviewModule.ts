import {NativeModule, requireNativeModule} from "expo"

import type {
  FramePreviewBindOptions,
  FramePreviewBindResult,
  FramePreviewConfigureOptions,
  FramePreviewDocumentConfig,
  FramePreviewModuleEvents,
} from "./FramePreview.types"

declare class FramePreviewNativeModule extends NativeModule<FramePreviewModuleEvents> {
  bind(options: FramePreviewBindOptions): Promise<FramePreviewBindResult>
  /**
   * Mint a credential for one document and (re)arm the transport for it. Idempotent per
   * `docGen`: the host calls it on every handshake request, and a page that asks twice gets the
   * same answer rather than invalidating its own credit.
   */
  prepareDocument(options: {docGen: number}): Promise<FramePreviewDocumentConfig>
  configure(options: FramePreviewConfigureOptions): Promise<void>
  start(): Promise<void>
  /** Halt production. The authenticated transport survives, so `start` needs no new handshake. */
  stop(reason?: string): Promise<void>
  resetStats(): Promise<void>
  /**
   * Absolute path of the current run's NDJSON file, or null before the first `start`. Surfaced
   * so the panel can tell you where to look instead of making you guess at a container path.
   */
  runLogPath(): Promise<string | null>
  /** Destroy the transport as well. The page must handshake again afterwards. */
  unbind(): Promise<void>
}

export default requireNativeModule<FramePreviewNativeModule>("MentraFramePreview")
