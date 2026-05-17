/**
 * PhoneStreamCoordinator — owns all local-miniapp streaming on the phone.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → coordinator
 *           coordinator → CoreModule (BLE → glasses publisher)
 *           coordinator ↔ v2StreamApi (managed only, Cloudflare provisioning)
 *           coordinator ↔ StreamLifecycleController (keep-alive heartbeat)
 *           coordinator → status listeners → routed back to miniapp(s)
 *
 * Single-stream constraint:
 *   At most ONE stream is active across all miniapps. The exception is that
 *   multiple miniapps can subscribe to a single managed stream that's already
 *   running — Cloudflare muxes one ingest into many viewers, so subscribers
 *   share the same playback URLs. Refcounted; teardown happens when the last
 *   subscriber releases.
 *
 * Status routing:
 *   Glasses publisher status arrives over BLE as `stream_status` events with
 *   a `streamId`. The coordinator's `owns(streamId)` lookup lets MantleManager
 *   route phone-owned status events here (not to cloud). For managed streams,
 *   we additionally poll Cloudflare's live-input status every 5s to surface
 *   what the OTHER end of the pipe sees.
 *
 * Important: this is the ONLY place that mints `streamId`s for phone-owned
 * streams. We use a `phone-` prefix so they're trivially distinguishable from
 * cloud-minted IDs in logs and from cloud-SDK app streams that flow through
 * the legacy path.
 */

import CoreModule from "@mentra/bluetooth-sdk"
import type {StreamStatusEvent, KeepAliveAckEvent} from "@mentra/bluetooth-sdk"

import {StreamLifecycleController, type LifecycleLogger} from "./StreamLifecycleController"
import {
  getManagedStreamStatus,
  provisionManagedStream,
  teardownManagedStream,
  type CloudflareStatus,
  type ProvisionResult,
  type RestreamDestinationInput,
} from "./v2StreamApi"

/**
 * Default cadence + thresholds. Exposed via {@link CoordinatorTimings} so tests
 * can shorten them; production code should never override these.
 */
const DEFAULT_TIMINGS = {
  keepAliveIntervalMs: 15_000,
  ackTimeoutMs: 10_000,
  maxMissedAcks: 3,
  cloudflareStatusPollMs: 5_000,
  // Cloudflare typically needs ~5-10s after first frame before HLS is live.
  hlsReadinessInitialDelayMs: 5_000,
  hlsReadinessPollMs: 2_000,
  hlsReadinessMaxAttempts: 30,
} as const

export type CoordinatorTimings = Partial<typeof DEFAULT_TIMINGS>

// Console-backed minimal logger; replaces pino on the phone.
const consoleLogger: LifecycleLogger = {
  child: (bindings) => ({
    ...consoleLogger,
    debug: (...args) => console.debug("[STREAM]", bindings, ...args),
    warn: (...args) => console.warn("[STREAM]", bindings, ...args),
    error: (...args) => console.error("[STREAM]", bindings, ...args),
  }),
  debug: (...args) => console.debug("[STREAM]", ...args),
  warn: (...args) => console.warn("[STREAM]", ...args),
  error: (...args) => console.error("[STREAM]", ...args),
}

export interface StartUnmanagedOptions {
  streamUrl: string
  video?: unknown
  audio?: unknown
  flash?: boolean
  sound?: boolean
}

export interface StartManagedOptions {
  restreamDestinations?: RestreamDestinationInput[]
}

export interface ManagedStartResult {
  streamId: string
  liveInputId: string
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
}

export type StreamStatusUpdate = {
  streamId: string
  source: "glasses" | "cloudflare" | "coordinator"
  status: string
  data?: Record<string, unknown>
}

export type StatusSubscriber = (packageName: string, update: StreamStatusUpdate) => void

interface UnmanagedEntry {
  kind: "unmanaged"
  streamId: string
  packageName: string
  streamUrl: string
}

interface ManagedEntry {
  kind: "managed"
  streamId: string
  liveInputId: string
  ingestUrl: string
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
  subscribers: Set<string>
  hlsReady: boolean
  hlsReadyResolvers: Array<(result: ManagedStartResult) => void>
  hlsReadyRejecters: Array<(err: Error) => void>
  cloudflareTimer?: ReturnType<typeof setInterval>
  hlsTimer?: ReturnType<typeof setInterval>
  hlsAttempts: number
}

type Entry = UnmanagedEntry | ManagedEntry

export class StreamConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "StreamConflictError"
  }
}

export class PhoneStreamCoordinator {
  private current: Entry | null = null
  private lifecycle: StreamLifecycleController | null = null
  private statusSubscriber: StatusSubscriber | null = null
  private idCounter = 0
  private readonly timings: typeof DEFAULT_TIMINGS

  constructor(timings: CoordinatorTimings = {}) {
    this.timings = {...DEFAULT_TIMINGS, ...timings}
  }

  /**
   * Register the function that routes status updates to miniapps.
   * LocalMiniappRuntime wires this so updates become EVENT envelopes on the
   * `stream_status` stream for every subscribing miniapp.
   */
  setStatusSubscriber(cb: StatusSubscriber): void {
    this.statusSubscriber = cb
  }

  /**
   * True when a phone-owned stream currently uses this streamId. For managed
   * streams, all subscribers share the same streamId so a single equality
   * check covers the multi-subscriber case.
   */
  owns(streamId: string): boolean {
    return this.current !== null && this.current.streamId === streamId
  }

  async startUnmanaged(
    packageName: string,
    opts: StartUnmanagedOptions,
  ): Promise<{streamId: string}> {
    if (!opts.streamUrl || typeof opts.streamUrl !== "string") {
      throw new StreamConflictError("STREAM_URL_REQUIRED", "streamUrl is required")
    }
    if (this.current) {
      throw new StreamConflictError(
        "STREAM_ALREADY_ACTIVE",
        `A ${this.current.kind} stream is already active. Stop it before starting a new one.`,
      )
    }

    const streamId = this.mintId("u")
    const entry: UnmanagedEntry = {
      kind: "unmanaged",
      streamId,
      packageName,
      streamUrl: opts.streamUrl,
    }
    this.current = entry

    try {
      await CoreModule.startStream({
        type: "start_stream",
        streamUrl: opts.streamUrl,
        streamId,
        keepAlive: true,
        keepAliveIntervalSeconds: this.timings.keepAliveIntervalMs / 1000,
        flash: opts.flash ?? true,
        sound: opts.sound ?? true,
        video: opts.video as never,
        audio: opts.audio as never,
      })
    } catch (err) {
      this.current = null
      throw err
    }

    this.startLifecycle(streamId)
    return {streamId}
  }

  async startManaged(
    packageName: string,
    opts: StartManagedOptions,
  ): Promise<ManagedStartResult> {
    if (this.current && this.current.kind === "unmanaged") {
      throw new StreamConflictError(
        "STREAM_ALREADY_ACTIVE",
        "An unmanaged stream is already active. Stop it before starting a managed stream.",
      )
    }

    // Join an existing managed stream if one is already running.
    if (this.current && this.current.kind === "managed") {
      const existing = this.current
      // Restream destinations are immutable after provision — a second caller
      // trying to dictate destinations on an already-live stream is a likely
      // bug or a feature we don't yet support.
      if (opts.restreamDestinations && opts.restreamDestinations.length > 0) {
        throw new StreamConflictError(
          "STREAM_DESTINATIONS_LOCKED",
          "Restream destinations cannot be modified on an already-running managed stream.",
        )
      }
      existing.subscribers.add(packageName)
      if (existing.hlsReady) {
        return {
          streamId: existing.streamId,
          liveInputId: existing.liveInputId,
          hlsUrl: existing.hlsUrl,
          dashUrl: existing.dashUrl,
          webrtcUrl: existing.webrtcUrl,
        }
      }
      // HLS not yet ready — wait for the in-flight readiness poll to land.
      return new Promise<ManagedStartResult>((resolve, reject) => {
        existing.hlsReadyResolvers.push(resolve)
        existing.hlsReadyRejecters.push(reject)
      })
    }

    // Fresh provision.
    const provision = await provisionManagedStream(opts.restreamDestinations)
    const streamId = this.mintId("m")
    const ingestUrl = pickIngestUrl(provision)

    const entry: ManagedEntry = {
      kind: "managed",
      streamId,
      liveInputId: provision.liveInputId,
      ingestUrl,
      hlsUrl: provision.hlsUrl,
      dashUrl: provision.dashUrl,
      webrtcUrl: provision.webrtcUrl,
      subscribers: new Set([packageName]),
      hlsReady: false,
      hlsReadyResolvers: [],
      hlsReadyRejecters: [],
      hlsAttempts: 0,
    }
    this.current = entry

    try {
      await CoreModule.startStream({
        type: "start_stream",
        streamUrl: ingestUrl,
        streamId,
        keepAlive: true,
        keepAliveIntervalSeconds: this.timings.keepAliveIntervalMs / 1000,
        flash: true,
        sound: true,
      })
    } catch (err) {
      this.current = null
      await teardownManagedStream(provision.liveInputId).catch(() => undefined)
      throw err
    }

    this.startLifecycle(streamId)
    this.startCloudflareStatusPoll(entry)
    this.startHlsReadinessPoll(entry)

    return new Promise<ManagedStartResult>((resolve, reject) => {
      entry.hlsReadyResolvers.push(resolve)
      entry.hlsReadyRejecters.push(reject)
    })
  }

  async stop(packageName: string, streamId?: string): Promise<void> {
    if (!this.current) return

    // If a streamId was passed but doesn't match, ignore — silent no-op
    // matches the cloud's tolerant behavior.
    if (streamId && this.current.streamId !== streamId) return

    if (this.current.kind === "managed") {
      const entry = this.current
      entry.subscribers.delete(packageName)
      if (entry.subscribers.size > 0) {
        // Other miniapps still subscribed; keep the stream alive.
        return
      }
    } else if (this.current.packageName !== packageName) {
      // Unmanaged stream: only the owner can stop it.
      return
    }

    await this.teardown("explicit_stop")
  }

  /**
   * Called by MantleManager when a `stream_status` event arrives from glasses
   * and the registry says it's phone-owned.
   */
  handleGlassesStatus(event: StreamStatusEvent): void {
    if (!this.current) return
    if (event.streamId && event.streamId !== this.current.streamId) return

    this.lifecycle?.recordActivity()
    this.fanout({
      streamId: this.current.streamId,
      source: "glasses",
      status: event.status,
      data: event as unknown as Record<string, unknown>,
    })

    // Glasses-reported terminal states unwind the coordinator.
    const isError = event.kind === "error"
    const isStopped = event.kind === "lifecycle" && event.status === "stopped"
    if (isError || isStopped) {
      void this.teardown(isError ? "glasses_error" : "glasses_stopped")
    }
  }

  /** Called by MantleManager when a phone-owned keep_alive_ack arrives. */
  handleKeepAliveAck(event: KeepAliveAckEvent): void {
    if (!event.ackId) return
    this.lifecycle?.handleAck(event.ackId)
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private mintId(prefix: "u" | "m"): string {
    this.idCounter += 1
    return `phone-${prefix}-${Date.now().toString(36)}-${this.idCounter}`
  }

  private startLifecycle(streamId: string): void {
    this.lifecycle?.dispose()
    const ctrl = new StreamLifecycleController(
      {
        logger: consoleLogger,
        streamId,
        keepAliveIntervalMs: this.timings.keepAliveIntervalMs,
        ackTimeoutMs: this.timings.ackTimeoutMs,
        maxMissedAcks: this.timings.maxMissedAcks,
      },
      {
        sendKeepAlive: async (ackId) => {
          await CoreModule.keepStreamAlive({
            type: "keep_stream_alive",
            streamId,
            ackId,
          })
        },
        onTimeout: async () => {
          this.fanout({
            streamId,
            source: "coordinator",
            status: "error",
            data: {reason: "keep_alive_timeout"},
          })
          await this.teardown("keep_alive_timeout")
        },
      },
    )
    ctrl.setActive(true)
    this.lifecycle = ctrl
  }

  private startCloudflareStatusPoll(entry: ManagedEntry): void {
    const poll = async () => {
      if (this.current !== entry) return
      try {
        const status: CloudflareStatus = await getManagedStreamStatus(entry.liveInputId)
        this.fanout({
          streamId: entry.streamId,
          source: "cloudflare",
          status: status.isConnected ? "connected" : "disconnected",
          data: status as unknown as Record<string, unknown>,
        })
      } catch (err) {
        console.warn("[STREAM] cloudflare status poll failed:", err)
      }
    }
    entry.cloudflareTimer = setInterval(poll, this.timings.cloudflareStatusPollMs)
    // Don't fire immediately — Cloudflare wouldn't have first-frame yet.
  }

  private startHlsReadinessPoll(entry: ManagedEntry): void {
    // Skip the first few seconds — Cloudflare doesn't have first-frame yet,
    // and the HEAD requests would all 404 and burn battery.
    const tick = async () => {
      if (this.current !== entry) return
      entry.hlsAttempts += 1
      try {
        const res = await fetch(entry.hlsUrl, {method: "HEAD"})
        if (res.ok) {
          entry.hlsReady = true
          if (entry.hlsTimer) {
            clearInterval(entry.hlsTimer)
            entry.hlsTimer = undefined
          }
          const result: ManagedStartResult = {
            streamId: entry.streamId,
            liveInputId: entry.liveInputId,
            hlsUrl: entry.hlsUrl,
            dashUrl: entry.dashUrl,
            webrtcUrl: entry.webrtcUrl,
          }
          for (const r of entry.hlsReadyResolvers) r(result)
          entry.hlsReadyResolvers = []
          entry.hlsReadyRejecters = []
          this.fanout({
            streamId: entry.streamId,
            source: "coordinator",
            status: "hls_ready",
            data: result as unknown as Record<string, unknown>,
          })
          return
        }
      } catch {
        // 404 / network blip is expected while Cloudflare warms up.
      }
      if (entry.hlsAttempts >= this.timings.hlsReadinessMaxAttempts) {
        if (entry.hlsTimer) {
          clearInterval(entry.hlsTimer)
          entry.hlsTimer = undefined
        }
        const err = new Error(
          `HLS playback URL did not become ready after ${this.timings.hlsReadinessMaxAttempts} attempts`,
        )
        for (const reject of entry.hlsReadyRejecters) reject(err)
        entry.hlsReadyResolvers = []
        entry.hlsReadyRejecters = []
        this.fanout({
          streamId: entry.streamId,
          source: "coordinator",
          status: "error",
          data: {reason: "hls_not_ready"},
        })
        void this.teardown("hls_not_ready")
      }
    }
    setTimeout(() => {
      // Guard: stream may have been torn down during the initial delay.
      if (this.current !== entry) return
      entry.hlsTimer = setInterval(tick, this.timings.hlsReadinessPollMs)
    }, this.timings.hlsReadinessInitialDelayMs)
  }

  private fanout(update: StreamStatusUpdate): void {
    if (!this.current || !this.statusSubscriber) return
    const targets =
      this.current.kind === "managed"
        ? Array.from(this.current.subscribers)
        : [this.current.packageName]
    for (const pkg of targets) {
      try {
        this.statusSubscriber(pkg, update)
      } catch (err) {
        console.warn("[STREAM] statusSubscriber threw:", err)
      }
    }
  }

  private async teardown(reason: string): Promise<void> {
    const entry = this.current
    if (!entry) return
    this.current = null
    this.lifecycle?.dispose()
    this.lifecycle = null

    if (entry.kind === "managed") {
      if (entry.cloudflareTimer) clearInterval(entry.cloudflareTimer)
      if (entry.hlsTimer) clearInterval(entry.hlsTimer)
      // Reject any still-pending HLS readiness waiters.
      const pendingErr = new Error(`Stream torn down: ${reason}`)
      for (const reject of entry.hlsReadyRejecters) reject(pendingErr)
      entry.hlsReadyResolvers = []
      entry.hlsReadyRejecters = []
      teardownManagedStream(entry.liveInputId).catch((err) => {
        console.warn("[STREAM] teardownManagedStream failed:", err)
      })
    }

    try {
      await CoreModule.stopStream()
    } catch (err) {
      console.warn("[STREAM] CoreModule.stopStream failed:", err)
    }
  }
}

function pickIngestUrl(p: ProvisionResult): string {
  // Glasses' StreamCommandHandler detects protocol from URL prefix.
  // Priority: WHIP > SRT > RTMP. Cloudflare populates all three normally;
  // throw if none resolved so the caller's Promise rejects with a clear
  // message rather than the glasses' "unknown protocol" error.
  const url = p.webrtcPublishUrl || p.srtUrl || p.rtmpUrl
  if (!url) {
    throw new Error("Cloudflare provision returned no usable ingest URL")
  }
  return url
}

// Singleton — coordinator's single-stream constraint is process-wide.
export const phoneStreamCoordinator = new PhoneStreamCoordinator()
