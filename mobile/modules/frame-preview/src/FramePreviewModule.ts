import {NativeModule, requireNativeModule} from "expo"

import type {
  FramePreviewModuleEvents,
  PreviewBindOptions,
  PreviewBindResult,
  PreviewConfigureOptions,
  PreviewDocumentConfig,
  PreviewDocumentOptions,
  PreviewFaultOptions,
} from "./FramePreview.types"

declare class FramePreviewNativeModule extends NativeModule<FramePreviewModuleEvents> {
  /** Attach to the miniapp WebView. On Android this installs the listener; call before navigation. */
  bind(options: PreviewBindOptions): Promise<PreviewBindResult>
  /**
   * Mint a credential for one document and arm the transport for it. Idempotent per `docGen`: a
   * page that asks twice gets the same answer rather than invalidating its own credit. Rejects
   * with `not_bound` before `bind`.
   */
  prepareDocument(options: PreviewDocumentOptions): Promise<PreviewDocumentConfig>
  /**
   * Rejects with `diagnostics_disabled` when the source, mode or diagnostics options need
   * diagnostics and they are off. A tier change never restarts production or the transport.
   */
  configure(options: PreviewConfigureOptions): Promise<void>
  start(): Promise<void>
  /** Halt production. The authenticated transport survives, so `start` needs no new handshake. */
  stop(reason: string): Promise<void>
  /** Destroy the transport as well. The page must handshake again afterwards. */
  unbind(reason: string): Promise<void>
  resetStats(): Promise<void>
  /** Absolute path of the current NDJSON run log, or null when the run log is off. */
  runLogPath(): Promise<string | null>
  /** Debug builds default to true, release builds to false. */
  setDiagnosticsEnabled(enabled: boolean): Promise<void>
  /** Collect tap cadence, offer cost and the ACS send rate even with no preview attached. */
  setTapTelemetry(enabled: boolean): Promise<void>
  /** NDJSON run log and the 1 Hz status trace line. Debug default true, release default false. */
  setRunLogEnabled(enabled: boolean): Promise<void>
  /** Arm a fault hook. Rejects with `diagnostics_disabled` when diagnostics are off. */
  injectFault(options: PreviewFaultOptions): Promise<void>
}

export default requireNativeModule<FramePreviewNativeModule>("MentraFramePreview")
