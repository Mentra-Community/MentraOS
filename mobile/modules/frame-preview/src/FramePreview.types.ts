/** Where preview frames come from. `synthetic` is a diagnostics-only test pattern. */
export type PreviewSourceKind = "call" | "synthetic"

/**
 * How far down the pipeline a frame travels. Only `off` and `render` are available without
 * diagnostics; the others isolate one stage each for measurement.
 */
export type PreviewMode =
  /** Nothing runs. */
  | "off"
  /** Produce the source frame and stop. */
  | "generate_only"
  /** Pack (and downscale) to the wire format and drop it. */
  | "pack_only"
  /** Send it; the page validates and acknowledges without drawing. */
  | "receive_discard"
  /** Send it; the page draws and then acknowledges. */
  | "render"

export type PreviewTransport = "webmessage" | "websocket"

export type PreviewUnavailableReason = "not_bound" | "webview_feature_missing" | "no_webview"

/** Error codes native rejects with (`error.code`). */
export type PreviewNativeErrorCode = "diagnostics_disabled" | "not_bound" | "invalid_argument" | "transport_failed"

export interface PreviewBindOptions {
  /**
   * React tag of the host `View` wrapping the miniapp WebView. Android walks its descendants to
   * find the real `android.webkit.WebView`; iOS ignores it.
   */
  hostViewTag: number
  packageName: string
  /** Stamped on every native `PREVIEW_TRACE` line. */
  traceId: string
}

export interface PreviewBindResult {
  /**
   * Android fallback only: the listener was installed after navigation, so the document must be
   * reloaded once. Counted as `installReloads`; the host installs before navigation so this
   * stays false.
   */
  installReloadRequired: boolean
  unavailableReason?: PreviewUnavailableReason
}

export interface PreviewDocumentOptions {
  docGen: number
  traceId: string
}

export interface PreviewDocumentConfig {
  protocolVersion: 1
  transport: PreviewTransport
  /** iOS loopback WebSocket endpoint (127.0.0.1 only). */
  url?: string
  /** Android: the injected `window[portName]` WebMessage port. */
  portName?: string
  /** Per-document credential the page presents in `hello` before any frame is sent. */
  token: string
  docGen: number
}

export interface PreviewDiagnosticsOptions {
  /** Synthetic grain amplitude. Diagnostics only. */
  noiseAmplitude?: number
  /** Native holds each ack this long: a slow consumer. Diagnostics only. */
  consumerDelayMs?: number
}

export interface PreviewConfigureOptions {
  source: PreviewSourceKind
  mode: PreviewMode
  /**
   * Target box, already quantized to a tier by the host. Native fits the source inside it
   * preserving aspect, never upscales, and reports the produced size as `outWidth`/`outHeight`.
   */
  targetWidth: number
  targetHeight: number
  maxFps: number
  diagnostics?: PreviewDiagnosticsOptions
}

/** Diagnostics-only fault hooks. `ack_delay` takes `ms`. */
export type PreviewFaultKind = "ack_delay" | "ack_drop" | "transport_close" | "pack_throw" | "sink_throw" | "clear"

export interface PreviewFaultOptions {
  kind: PreviewFaultKind
  ms?: number
}

export type PackFailureReason =
  | "zero_size"
  | "stride_too_small"
  | "plane_out_of_bounds"
  | "payload_mismatch"
  | "slot_too_small"
  | "sink_error"
  | "worker_error"

/**
 * One-second snapshot, emitted as `onStatus` and appended to the NDJSON run log. The contract
 * counters are always present; the remaining fields are diagnostic detail and may differ per
 * platform.
 */
export interface PreviewStatusPayload {
  t: "status"
  platform: "ios" | "android"
  runId: string
  running: boolean
  source: PreviewSourceKind
  mode: PreviewMode
  docGen: number

  deliveredFps: number
  /** 0 or 1 by construction. */
  outstanding: number
  skippedBusy: number
  skippedPacing: number
  packMsP95: number
  rttMsP95: number
  deliveryGapMsP50: number
  deliveryGapMsP95: number
  /** Mean time inside the decoder-thread tap. The call's cost, not the preview's. */
  tapOfferMeanUs: number
  tapCadenceMaxMs: number
  /** Cumulative errors caught from the tap sink. Must stay 0. */
  tapSinkExceptions: number
  /** Only reasons that occurred are present. */
  packFailures: Partial<Record<PackFailureReason, number>>
  staleAcks: number
  ackTimeouts: number
  /** Android reload fallbacks. Always 0 on iOS. */
  installReloads: number
  handshakes: number
  tierChanges: number
  outWidth: number
  outHeight: number
  srcWidth: number
  srcHeight: number

  /** Frames the ACS sender accepted per second, counted at its call sites. */
  acsSendFps: number
  /** Frames the decoder offered to the tap in this second. */
  tapFramesOffered: number
  tapFramesWithSink: number
  tapOfferMaxUs: number
  tapCadenceMeanMs: number
  tapTelemetry: boolean
  diagnostics: boolean

  targetFps: number
  targetWidth: number
  targetHeight: number
  pixelFormat: "i420" | "nv12"
  noSource: boolean
  consumerReady: boolean
  thermalState: string
  memoryFootprintMb: number
  [detail: string]: unknown
}

export type PreviewStoppedReason =
  | "ack_timeout"
  | "pack_failed"
  | "transport_failed"
  | "source_detached"
  | "unbound"
  | "diagnostics_disabled"
  | (string & {})

export interface PreviewStoppedEvent {
  reason: PreviewStoppedReason
  docGen: number
}

/** A native `PREVIEW_TRACE` line. The host forwards it to the console so it lands in bug reports. */
export interface PreviewLogEvent {
  level: "info" | "warn"
  message: string
}

// A type alias, not an interface: Expo's `NativeModule<E>` constrains `E` to `EventsMap`, and
// only aliases get the implicit index signature that satisfies it.
export type FramePreviewModuleEvents = {
  onStatus: (status: PreviewStatusPayload) => void
  onStopped: (event: PreviewStoppedEvent) => void
  onLog: (event: PreviewLogEvent) => void
}
