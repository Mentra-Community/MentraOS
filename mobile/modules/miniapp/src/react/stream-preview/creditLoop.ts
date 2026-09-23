/**
 * Consumer side of the one-frame credit scheme.
 *
 * The native sender holds exactly one frame in flight and will not send the next until this side
 * acknowledges the last, so there is no queue anywhere and a slow consumer shows up as a lower
 * frame rate rather than as growing latency. This module is the half that makes that true: parse,
 * draw, ack — and never hold a reference to a frame after its ack.
 *
 * Durations here would be `performance.now()` and describe JavaScript only; the header's
 * `timestampNs` / `sentAtNs` are a native monotonic clock with a different epoch. End-to-end
 * latency is measured natively (it sees both the send and the ack on one clock).
 */

import {parsePreviewFrame, type ParsedFrame, type PreviewParseErrorReason} from "./protocol"

export interface CreditLoopFrameSummary {
  gen: number
  seq: number
  width: number
  height: number
  pixelFormat: string
  rotationQuarters: number
}

export interface CreditLoopStats {
  framesReceived: number
  drawsSubmitted: number
  acksSent: number
  parseErrors: number
  parseErrorsByReason: Partial<Record<PreviewParseErrorReason, number>>
  /**
   * Frames that arrived while another was still being processed. Native guarantees one at a time,
   * so any value above zero means the credit scheme is broken.
   */
  overlapped: number
  /** Frames the sender skipped, counted from gaps in the header sequence. */
  sequenceGaps: number
  skippedBySender: number
  lastError: string | null
  lastFrame: CreditLoopFrameSummary | null
}

export interface CreditLoopOptions {
  sendAck: (gen: number, seq: number) => void
  /**
   * Submit the frame. Returns the submit duration in ms, or null when there is no renderer (the
   * component is unmounted or its GL context is lost). The frame is acked either way.
   */
  draw?: (frame: ParsedFrame) => number | null
  /** Called once per rejected frame, before anything else happens to it. */
  onParseError?: (reason: PreviewParseErrorReason, detail?: string) => void
}

export class CreditLoop {
  private readonly errorsByReason = new Map<PreviewParseErrorReason, number>()
  private idleWaiters: Array<() => void> = []
  private inFlightCount = 0
  private framesReceived = 0
  private drawsSubmitted = 0
  private acksSent = 0
  private parseErrors = 0
  private overlapped = 0
  private sequenceGaps = 0
  private skippedBySender = 0
  private lastSeq: number | null = null
  private lastGen: number | null = null
  private lastError: string | null = null
  private lastFrame: CreditLoopFrameSummary | null = null
  private draw: CreditLoopOptions["draw"]

  constructor(private readonly options: CreditLoopOptions) {
    this.draw = options.draw
  }

  /** Swap the renderer without touching the credit state. Null means frames are acked undrawn. */
  setDraw(draw: CreditLoopOptions["draw"] | null): void {
    this.draw = draw ?? undefined
  }

  /** Frames currently being processed. The credit scheme means this is 0 or 1. */
  get inFlight(): number {
    return this.inFlightCount
  }

  /** Entry point for the transport. Deliberately not awaited: the transport must not block. */
  handleBinary(buffer: ArrayBuffer): void {
    if (this.inFlightCount > 0) this.overlapped += 1
    this.inFlightCount += 1
    void this.process(buffer).finally(() => {
      this.inFlightCount -= 1
      if (this.inFlightCount === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const resolve of waiters) resolve()
      }
    })
  }

  /** Resolves once nothing is being processed. */
  idle(): Promise<void> {
    if (this.inFlightCount === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  recordError(reason: string): void {
    this.lastError = reason
  }

  snapshot(): CreditLoopStats {
    const parseErrorsByReason: Partial<Record<PreviewParseErrorReason, number>> = {}
    for (const [reason, count] of this.errorsByReason) parseErrorsByReason[reason] = count
    return {
      framesReceived: this.framesReceived,
      drawsSubmitted: this.drawsSubmitted,
      acksSent: this.acksSent,
      parseErrors: this.parseErrors,
      parseErrorsByReason,
      overlapped: this.overlapped,
      sequenceGaps: this.sequenceGaps,
      skippedBySender: this.skippedBySender,
      lastError: this.lastError,
      lastFrame: this.lastFrame,
    }
  }

  reset(): void {
    this.framesReceived = 0
    this.drawsSubmitted = 0
    this.acksSent = 0
    this.parseErrors = 0
    this.overlapped = 0
    this.sequenceGaps = 0
    this.skippedBySender = 0
    this.lastSeq = null
    this.lastGen = null
    this.lastError = null
    this.lastFrame = null
    this.errorsByReason.clear()
  }

  private async process(buffer: ArrayBuffer): Promise<void> {
    this.framesReceived += 1
    const parsed = parsePreviewFrame(buffer)
    if (!parsed.ok) {
      // No ack: a frame this side could not read is not a frame it consumed, and acking it would
      // hide the fault behind a healthy-looking rate.
      this.parseErrors += 1
      this.errorsByReason.set(parsed.reason, (this.errorsByReason.get(parsed.reason) ?? 0) + 1)
      this.lastError = parsed.detail ? `${parsed.reason} (${parsed.detail})` : parsed.reason
      this.options.onParseError?.(parsed.reason, parsed.detail)
      return
    }
    this.trackSequence(parsed)
    this.lastFrame = {
      gen: parsed.sessionGen,
      seq: parsed.frameSeq,
      width: parsed.width,
      height: parsed.height,
      pixelFormat: parsed.pixelFormat,
      rotationQuarters: parsed.rotationQuarters,
    }
    if (this.draw) {
      const submitMs = this.draw(parsed)
      if (submitMs === null) this.lastError = "draw_failed"
      else this.drawsSubmitted += 1
    }
    // Ack last, after the draw has been submitted, so the credit the sender gets back means "this
    // side is done with that frame" rather than "this side received some bytes". A dead canvas
    // still acks: withholding credit would stall the sender on top of it.
    this.options.sendAck(parsed.sessionGen, parsed.frameSeq)
    this.acksSent += 1
  }

  private trackSequence(parsed: ParsedFrame): void {
    if (this.lastGen !== parsed.sessionGen) {
      this.lastGen = parsed.sessionGen
      this.lastSeq = parsed.frameSeq
      return
    }
    if (this.lastSeq !== null) {
      const delta = parsed.frameSeq - this.lastSeq
      if (delta > 1) {
        this.sequenceGaps += 1
        this.skippedBySender += delta - 1
      }
    }
    this.lastSeq = parsed.frameSeq
  }
}
