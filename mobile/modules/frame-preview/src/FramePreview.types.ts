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
  /**
   * Synthetic grain, ±this many levels around each colour bar. 0 gives flat bars.
   *
   * Raw YUV is the same size whatever it contains, so this cannot change the bandwidth. It is a
   * control: flat bars compress and noise does not, so a run at 0 and a run at 40 that report
   * the same send timings prove nothing in the path is quietly compressing.
   */
  noiseAmplitude: number
}

/**
 * One-second snapshot. Native stages are timed with the native monotonic clock only.
 *
 * The same object is emitted to the page and appended to the run's NDJSON file, so the screen
 * and the file can never disagree about what a second looked like. A few keys are deliberately
 * platform-specific rather than reported as zero: iOS cannot count sink exceptions and Android
 * has no enqueue/completion split, and a lying zero in a comparison table is worse than a gap.
 */
export interface FramePreviewStatus {
  t: "status"
  platform: "ios" | "android"
  /** Identifies the run this second belongs to; matches the NDJSON file name. */
  runId: string
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
  /** Sub-reason of `skippedBusy`: refused on the decoder thread, before the pack worker. */
  preDispatchDrops: number
  /** Sub-reason of `skippedBusy`: both send buffers were still held by the transport. */
  slotStarved: number
  delivered: number
  sourceFps: number
  deliveredFps: number
  bytesPerSecond: number
  /** Synthetic source only: the cost of inventing a picture, never charged to the pipeline. */
  generateMsP50: number
  generateMsP95: number
  generateMsMax: number
  packMsP50: number
  packMsP95: number
  packMsP99: number
  packMsMax: number
  /** iOS only: the enqueue returns before Network framework has copied the buffer. */
  sendEnqueueMsP50?: number
  sendEnqueueMsP95?: number
  /** The honest send cost: transport finished with our buffer (iOS) / `postMessage` (Android). */
  sendCompleteMsP50: number
  sendCompleteMsP95: number
  sendCompleteMsMax: number
  /** Android only: how long the send runnable waited behind the app's own UI-thread work. */
  mainQueueWaitMsP95?: number
  mainQueueWaitMsMax?: number
  /** Admission to the first instruction of the pack worker: handoff cost, not the work. */
  admitToPackMsP95: number
  admitToPackMsMax: number
  /** Cadence between delivered frames. A steady 14.8 fps and a lumpy one score the same on fps. */
  deliveryGapMsP50: number
  deliveryGapMsP95: number
  deliveryGapMsMax: number
  /** Start of run to first delivered frame, and to its acknowledgement. */
  firstDeliveredMs: number
  firstAckMs: number
  rttMsP50: number
  rttMsP95: number
  rttMsP99: number
  rttMsMax: number
  /** Frames the decoder offered, counted whether or not preview was attached. */
  tapFramesOffered: number
  tapFramesWithSink: number
  /** Time spent inside the tap on the decoder thread. This one is the call's cost, not ours. */
  tapOfferMeanUs: number
  tapOfferMaxUs: number
  /** Decoder cadence. Compare preview off against preview on to see if the call degraded. */
  tapCadenceMeanMs: number
  tapCadenceMaxMs: number
  /** Android only: a preview bug that threw on the decoder thread. Must stay zero. */
  tapSinkExceptions?: number
  thermalState: string
  memoryFootprintMb: number
  /** 0 or 1 by construction. A sustained 1 with no deliveries means the consumer stopped. */
  outstanding: number
  ackTimeouts: number
  staleAcks: number
  /** iOS only: Android's decoded path is I420 by construction. */
  unsupportedFormat?: number
  packFailures: number
  transportErrors: number
  consumerReady: boolean
  /** True when the selected source has produced nothing recently. Never substitute synthetic. */
  noSource: boolean
  generation: number
  consumerDelayMs: number
  /** Synthetic grain in effect. Recorded so a noisy run and a flat one are distinguishable. */
  noiseAmplitude: number
}

// A type alias, not an interface: Expo's `NativeModule<E>` constrains `E` to `EventsMap`, and
// only aliases get the implicit index signature that satisfies it.
export type FramePreviewModuleEvents = {
  onStatus: (status: FramePreviewStatus) => void
  onStopped: (event: {reason: string}) => void
}
