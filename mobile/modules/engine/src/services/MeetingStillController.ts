/**
 * One full-size photo on the outgoing Teams tile during a Direct-link call, without touching the
 * glasses stream.
 *
 *   card on the tile -> register the still -> take_photo over BLE (upload to the phone's local
 *   `/photo/<id>`) -> still on the tile -> caller's duration -> live
 *
 * The glasses keep publishing WHIP the whole time: they lend their camera to the shot and send
 * substitute frames, which the outgoing hold drops. Nothing here stops or starts the publisher,
 * the hotspot, the scoped network, or the meeting.
 */

export type MeetingStillFailure =
  /** This host, native build, or transport cannot do it. The caller should use its fallback. */
  | "unsupported"
  /** The meeting is not live, or ended during the photo. */
  | "not_live"
  /** Another still is already in progress. */
  | "busy"
  /** The glasses refused or failed the shot. */
  | "glasses_rejected"
  /** The glasses did not upload the still in time. */
  | "upload_timeout"
  /** The card or the still never reached the Teams sender. */
  | "hold_failed"
  /** Leave, End, or a new join cancelled it. */
  | "cancelled"

export class MeetingStillError extends Error {
  constructor(
    readonly reason: MeetingStillFailure,
    message: string,
  ) {
    super(message)
    this.name = "MeetingStillError"
  }
}

export interface MeetingStillTimings {
  /** Press to the card being handed to the sender. */
  cardMs: number
  /** Card to the still being handed to the sender: capture, upload, decode. */
  stillMs: number
  /** How long the still was held before live frames returned. */
  heldMs: number
  totalMs: number
}

export interface MeetingStillResult {
  ok: true
  requestId: string
  bytes: number
  shownAt: number
  timings: MeetingStillTimings
}

export interface MeetingStillDeps {
  /** Card or live on the outgoing tile. Resolves once a card frame is handed to the sender. */
  holdOutgoing(kind: "card" | "live"): Promise<void>
  /** Register [requestId] with the local ingest listener. Resolves with the glasses' upload URL. */
  prepareStill(requestId: string): Promise<{uploadUrl: string}>
  /** Wait for the upload and put it on the tile. Rejects with a native `code` on timeout/cancel. */
  awaitStill(requestId: string, timeoutMs: number): Promise<{bytes: number; shownAt: number}>
  /** Forget a pending still. Idempotent. */
  cancelStill(requestId: string): Promise<void>
  /** Ask the glasses to shoot and upload. Resolves on their terminal success, rejects on failure. */
  requestGlassesPhoto(args: {requestId: string; uploadUrl: string}): Promise<unknown>
  /** The glasses' own `photo_status` narration for [requestId]. Optional; only feeds progress. */
  onGlassesPhotoStatus?(requestId: string, listener: (status: string) => void): () => void
  now?: () => number
  mintRequestId?: () => string
  uploadTimeoutMs?: number
}

/** `card` on the tile, glasses `uploading` the capture, still `shown` on the tile. */
export type MeetingStillPhase = "card" | "uploading" | "shown"

/** Capture plus a 1-3 MB upload over the hotspot is a few seconds; this bounds a lost upload. */
export const STILL_UPLOAD_TIMEOUT_MS = 30_000
/** Longest a caller may hold the still on the tile. */
export const STILL_MAX_DURATION_MS = 30_000

let stillSeq = 0

function mintStillRequestId(): string {
  stillSeq = (stillSeq + 1) % 0xffff
  const random = Math.floor(Math.random() * 0xffffff).toString(16)
  return `st${Date.now().toString(16)}${stillSeq.toString(16)}${random}`
}

function nativeCode(error: unknown): string | undefined {
  const code = (error as {code?: unknown} | null)?.code
  return typeof code === "string" ? code : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MeetingStillError("cancelled", "The photo was cancelled"))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new MeetingStillError("cancelled", "The photo was cancelled"))
    }
    signal.addEventListener("abort", onAbort, {once: true})
  })
}

export class MeetingStillController {
  private active: {requestId: string; abort: AbortController} | null = null

  constructor(private readonly deps: MeetingStillDeps) {}

  busy(): boolean {
    return this.active !== null
  }

  /**
   * Run the whole sequence. Resolves after the still has been held for [durationMs] and live
   * frames are back. Rejects with [MeetingStillError]; the tile is back on live either way,
   * except after [cancel], whose caller owns the tile.
   */
  async capture(options: {
    durationMs: number
    onProgress?: (phase: MeetingStillPhase) => void
  }): Promise<MeetingStillResult> {
    if (this.active) throw new MeetingStillError("busy", "A photo is already being shared")
    const now = this.deps.now ?? Date.now
    const requestId = (this.deps.mintRequestId ?? mintStillRequestId)()
    const abort = new AbortController()
    this.active = {requestId, abort}
    const startedAt = now()
    let holding = false
    let unsubscribeStatus: (() => void) | undefined
    const reported = new Set<MeetingStillPhase>()
    const report = (phase: MeetingStillPhase) => {
      if (reported.has(phase) || abort.signal.aborted) return
      reported.add(phase)
      try {
        options.onProgress?.(phase)
      } catch {
        // Progress is narration; a broken listener must not fail the photo.
      }
    }
    const checkpoint = () => {
      if (abort.signal.aborted) throw new MeetingStillError("cancelled", "The photo was cancelled")
    }
    try {
      try {
        await this.deps.holdOutgoing("card")
      } catch (error) {
        throw new MeetingStillError("hold_failed", `The photo card was not sent: ${describe(error)}`)
      }
      holding = true
      const cardAt = now()
      checkpoint()
      report("card")

      let uploadUrl: string
      try {
        uploadUrl = (await this.deps.prepareStill(requestId)).uploadUrl
      } catch (error) {
        throw new MeetingStillError("unsupported", `The Direct link cannot receive a photo: ${describe(error)}`)
      }
      checkpoint()

      // Registered before the glasses are asked, so the upload can never beat its own waiter.
      const received = this.deps.awaitStill(requestId, this.deps.uploadTimeoutMs ?? STILL_UPLOAD_TIMEOUT_MS)
      received.catch(() => undefined)
      try {
        unsubscribeStatus = this.deps.onGlassesPhotoStatus?.(requestId, (status) => {
          if (status === "uploading") report("uploading")
        })
      } catch {
        // Narration only; the upload itself still reports "uploading" and "shown".
      }
      const glasses = this.deps.requestGlassesPhoto({requestId, uploadUrl})
      glasses.catch(() => undefined)
      // Success is the upload itself; the glasses' own success lands after it. Only a glasses
      // failure can end the wait early.
      const glassesFailed = glasses.then(
        () => new Promise<never>(() => undefined),
        (error: unknown) => {
          throw new MeetingStillError("glasses_rejected", `The glasses could not take the photo: ${describe(error)}`)
        },
      )
      glassesFailed.catch(() => undefined)
      const cancelled = new Promise<never>((_, reject) => {
        abort.signal.addEventListener(
          "abort",
          () => reject(new MeetingStillError("cancelled", "The photo was cancelled")),
          {once: true},
        )
      })
      cancelled.catch(() => undefined)

      let shown: {bytes: number; shownAt: number}
      try {
        shown = await Promise.race([received, glassesFailed, cancelled])
      } catch (error) {
        if (error instanceof MeetingStillError) throw error
        const code = nativeCode(error)
        if (abort.signal.aborted || code === "STILL_CANCELLED") {
          throw new MeetingStillError("cancelled", "The photo was cancelled")
        }
        if (code === "STILL_TIMEOUT") {
          throw new MeetingStillError("upload_timeout", "The glasses did not upload the photo in time")
        }
        if (code === "HOLD_FAILED") throw new MeetingStillError("hold_failed", describe(error))
        if (code === "NO_MEETING") throw new MeetingStillError("not_live", describe(error))
        throw new MeetingStillError("glasses_rejected", describe(error))
      }
      const stillAt = now()
      checkpoint()
      // The glasses' BLE narration can trail their own upload; the phone has the photo now.
      report("uploading")
      report("shown")

      await abortableSleep(Math.max(0, options.durationMs), abort.signal)
      const doneAt = now()
      return {
        ok: true,
        requestId,
        bytes: shown.bytes,
        shownAt: shown.shownAt,
        timings: {
          cardMs: cardAt - startedAt,
          stillMs: stillAt - cardAt,
          heldMs: doneAt - stillAt,
          totalMs: doneAt - startedAt,
        },
      }
    } catch (error) {
      if (abort.signal.aborted) throw new MeetingStillError("cancelled", "The photo was cancelled")
      throw error
    } finally {
      try {
        unsubscribeStatus?.()
      } catch {
        // A listener that cannot be removed only costs a stale narration callback.
      }
      if (this.active?.requestId === requestId) this.active = null
      await this.deps.cancelStill(requestId).catch(() => undefined)
      // After a cancel the call is ending and its teardown owns the tile.
      if (holding && !abort.signal.aborted) await this.deps.holdOutgoing("live").catch(() => undefined)
    }
  }

  /** Leave, End, or a new join. Does not touch the tile; the caller is already clearing it. */
  cancel(): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.abort.abort()
    void this.deps.cancelStill(active.requestId).catch(() => undefined)
  }
}
