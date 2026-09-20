/** Where preview frames come from. */
export type FramePreviewSource = "synthetic" | "call"

/**
 * How far down the pipeline a frame travels. Each step is a separate mode so the cost of one
 * stage can be read off as the difference between two runs rather than guessed at.
 */
export type FramePreviewMode =
  /** Nothing runs. */
  | "off"
  /** Produce the source frame and stop. Baseline for the synthetic generator's own cost. */
  | "generate_only"
  /** Pack to the wire format and drop it. Isolates the stride copy. */
  | "pack_only"
  /** Send it; the page validates and acknowledges without drawing. */
  | "receive_discard"
  /** Send it; the page draws and then acknowledges. */
  | "render"

export type FramePreviewTransport = "websocket" | "webmessage"

export interface FramePreviewBindOptions {
  /**
   * React tag of the host `View` wrapping the miniapp WebView. Android walks its descendants to
   * find the real `android.webkit.WebView`; iOS ignores it because the socket is not attached to
   * a view.
   */
  hostViewTag: number
  packageName: string
}

export interface FramePreviewBindResult {
  supported: boolean
  transport: FramePreviewTransport
  /** Present when `supported` is false: which capability the device is missing. */
  unavailableReason?: string
  listenerInstalled: boolean
  /**
   * Android only. A `WebMessageListener` registered after a document has loaded does not appear
   * in that document, so the host reloads exactly once when this is true.
   */
  installReloadRequired: boolean
}

export interface FramePreviewDocumentConfig {
  transport: FramePreviewTransport
  /** iOS loopback WebSocket endpoint. Absent on Android, which uses the injected port object. */
  url?: string
  /** Single-use-per-document credential the page must present before any frame is sent. */
  token: string
  docGen: number
  sessionGen: number
  supported: boolean
  unavailableReason?: string
}

export interface FramePreviewConfigureOptions {
  source: FramePreviewSource
  mode: FramePreviewMode
  targetFps: number
  width: number
  height: number
  /** Test-only slow consumer. Lowers delivered fps; must never build a backlog. */
  consumerDelayMs: number
}

/** One-second snapshot. Native stages are timed with the native monotonic clock only. */
export interface FramePreviewStatus {
  t: "status"
  platform: "ios" | "android"
  running: boolean
  source: FramePreviewSource
  mode: FramePreviewMode
  targetFps: number
  width: number
  height: number
  pixelFormat: "i420" | "nv12"
  sourceFrames: number
  admitted: number
  skippedPacing: number
  skippedBusy: number
  delivered: number
  sourceFps: number
  deliveredFps: number
  bytesPerSecond: number
  packMsP50: number
  packMsP95: number
  sendMsP50: number
  sendMsP95: number
  rttMsP50: number
  rttMsP95: number
  /** 0 or 1 by construction. A sustained 1 with no deliveries means the consumer stopped. */
  outstanding: number
  ackTimeouts: number
  staleAcks: number
  unsupportedFormat: number
  transportErrors: number
  consumerReady: boolean
  /** True when the selected source has produced nothing recently. Never substitute synthetic. */
  noSource: boolean
  generation: number
  consumerDelayMs: number
}

// A type alias, not an interface: Expo's `NativeModule<E>` constrains `E` to `EventsMap`, and
// only aliases get the implicit index signature that satisfies it.
export type FramePreviewModuleEvents = {
  onStatus: (status: FramePreviewStatus) => void
  onStopped: (event: {reason: string}) => void
}
