/**
 * PhoneStreamCoordinator — owns all local-miniapp streaming on the phone.
 *
 * Architecture:
 *   miniapp → SDK → LocalMiniappRuntime → coordinator
 *           coordinator → BluetoothSdk (BLE → glasses publisher)
 *           coordinator ↔ cloudStreamApi (managed only, cloud-v2 runtime provisioning)
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
 *
 * BLE link loss is a SUSPENDED state, not a failure:
 *   The glasses publisher keeps pushing over Wi-Fi when the phone's Bluetooth
 *   link drops; only our keep-alives stop reaching it. While the store says
 *   the glasses are disconnected we pause the heartbeat (so we don't count
 *   misses we caused ourselves), fan out `suspended`, and give the link
 *   `glassesGraceMs` to come back. On reconnect we resume, heartbeat at once,
 *   and fan out `resumed` with the SAME streamId — no re-provision. The grace
 *   ends early when Cloudflare reports the publisher gone for two probes in
 *   a row (glasses powered off, not a BLE hiccup). If the grace expires the
 *   stream is torn down with reason `glasses_disconnected`, and the BLE stop
 *   the glasses never received is sent on the next reconnect.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {
  KeepAliveAckEvent,
  StreamResolvedConfig,
  StreamStartRequest,
  StreamStatusEvent,
} from "@mentra/bluetooth-sdk/internal"
import {isGlassesConnected} from "./GlassesReadiness"
import {useGlassesStore} from "../stores/glasses"

import {StreamLifecycleController, type LifecycleLogger} from "./StreamLifecycleController"
import {slimStreamStatusEvent, streamStatusSignature} from "./slimStreamStatus"
import {
  getManagedStreamStatus,
  provisionManagedStream,
  teardownManagedStream,
  type CloudflareStatus,
  type ProvisionResult,
  type RestreamDestinationInput,
} from "./cloudStreamApi"

/**
 * Default cadence + thresholds. Exposed via {@link CoordinatorTimings} so tests
 * can shorten them; production code should never override these.
 */
const DEFAULT_TIMINGS = {
  keepAliveIntervalMs: 15_000,
  ackTimeoutMs: 10_000,
  maxMissedAcks: 3,
  cloudflareStatusPollMs: 5_000,
  // During WHIP startup, probe quickly so readiness is not quantized to the
  // steady-state 5s monitoring cadence. The delay backs off on each miss.
  cloudflareStartupPollInitialMs: 500,
  // Cloudflare typically needs ~5-10s after first frame before HLS is live.
  hlsReadinessInitialDelayMs: 5_000,
  hlsReadinessPollMs: 2_000,
  hlsReadinessMaxAttempts: 30,
  // How long a stream survives a BLE link drop before we give up on it. Must
  // stay under the glasses publisher's own 60s no-keep-alive watchdog with
  // margin for the resume heartbeat's round trip.
  glassesGraceMs: 45_000,
  // Consecutive Cloudflare "publisher disconnected" probes while suspended
  // before we conclude the glasses are off (not just out of BLE range).
  suspendedPublisherGoneProbes: 2,
} as const

type TimingConfig = {[K in keyof typeof DEFAULT_TIMINGS]: number}
export type CoordinatorTimings = Partial<TimingConfig>

/**
 * Where the coordinator learns whether the phone↔glasses BLE link is up.
 * Injected so tests can drive link transitions without the zustand store.
 */
export interface GlassesLinkSource {
  isConnected(): boolean
  /** Fires on every connected↔disconnected transition. */
  subscribe(listener: (connected: boolean) => void): () => void
}

const storeLinkSource: GlassesLinkSource = {
  isConnected: () => isGlassesConnected(useGlassesStore.getState().connection),
  subscribe: (listener) => useGlassesStore.subscribe((s) => isGlassesConnected(s.connection), listener),
}

/** Reasons carried on coordinator-sourced `stream_status` fanouts for link events. */
export const LINK_STATUS = {
  suspended: "suspended",
  resumed: "resumed",
  reason: "glasses_disconnected",
} as const

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
  video?: StreamStartRequest["video"]
  audio?: StreamStartRequest["audio"]
  sound?: boolean
  /** Optional Bearer token for WHIP Authorization (custom authenticated endpoints). */
  authToken?: string
  captureAudio?: boolean
  /**
   * ICE configuration for the glasses' publisher. SoftAP passes `{stun: ""}`, which puts the
   * glasses in host-only mode: there is no route from the hotspot to a STUN server, so a
   * configured one would only add doomed gathering to every call.
   */
  ice?: StreamStartRequest["ice"]
  /** Correlation id echoed by the glasses into their own logs. See softapTrace. */
  traceId?: string
}

export interface StartManagedOptions {
  restreamDestinations?: RestreamDestinationInput[]
  video?: StreamStartRequest["video"]
  audio?: StreamStartRequest["audio"]
  sound?: boolean
  /**
   * Ingest protocol preference — a real latency/durability trade on Cloudflare:
   *   - "srt" (default): SRT ingest -> LL-HLS playback (~10-20s glass-to-screen),
   *     with shareable HLS/DASH URLs and automatic recording.
   *   - "whip": WebRTC ingest -> WHEP playback (<1s glass-to-screen), but NO
   *     HLS/DASH playback and NO recording (Cloudflare limitation; the returned
   *     hlsUrl will serve 204 forever).
   *   - "rtmp": RTMPS ingest over TCP 443 -> HLS playback. Survives networks
   *     that drop WHIP/SRT UDP.
   */
  ingest?: "srt" | "whip" | "rtmp"
  /** When false, glasses skip encoding their mic for this WHIP session. */
  captureAudio?: boolean
}

export interface StreamPublisherStartResult {
  streamId: string
  status: string
  resolvedConfig?: StreamResolvedConfig
}

export interface ManagedStartResult extends StreamPublisherStartResult {
  liveInputId: string
  /** Playback mode this stream supports: "hls" (SRT/RTMP ingest — use hlsUrl/
   *  dashUrl, recording on) or "webrtc" (WHIP ingest — use webrtcUrl/WHEP,
   *  sub-second, no HLS, no recording). */
  mode: "hls" | "webrtc"
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
  /** Playback mode the chosen ingest supports: SRT/RTMP feed HLS; WHIP feeds
   *  only WHEP. Readiness is gated differently per mode. */
  mode: "hls" | "webrtc"
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
  publisherStart?: StreamPublisherStartResult
  subscribers: Set<string>
  hlsReady: boolean
  hlsReadyResolvers: Array<(result: ManagedStartResult) => void>
  hlsReadyRejecters: Array<(err: Error) => void>
  cloudflareTimer?: ReturnType<typeof setTimeout>
  hlsTimer?: ReturnType<typeof setInterval>
  hlsAttempts: number
  /** Cloudflare status probes made during this stream session. */
  cloudflareAttempts: number
  /** Wall-clock origin for end-to-end managed startup diagnostics. */
  startupStartedAtMs: number
}

type Entry = UnmanagedEntry | ManagedEntry

export class StreamConflictError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Pipeline stage that failed (provision | command | publish | playback). */
    public readonly stage?: string,
    /** Transport in play at the failure (cloud-rest | ble | wifi). */
    public readonly transport?: string,
  ) {
    super(message)
    this.name = "StreamConflictError"
  }
}

interface SuspendedState {
  since: number
  graceTimer: ReturnType<typeof setTimeout>
  /** Consecutive Cloudflare probes that saw no publisher during this suspension. */
  publisherGoneProbes: number
}

export class PhoneStreamCoordinator {
  private current: Entry | null = null
  private lifecycle: StreamLifecycleController | null = null
  private statusSubscriber: StatusSubscriber | null = null
  private idCounter = 0
  private readonly timings: TimingConfig
  private readonly linkSource: GlassesLinkSource
  private unsubscribeLink: (() => void) | null = null
  private suspended: SuspendedState | null = null
  /**
   * A stream was torn down while the BLE link was down, so the glasses never
   * got `stopStream`. Sent on the next reconnect (if no new stream has claimed
   * the slot) so a publisher that outlived its input does not keep pushing
   * until its own watchdog fires.
   */
  private pendingBleStop: {streamId: string} | null = null
  /**
   * Serializes state transitions (start, stop, teardown). Without it, a
   * second `start*` racing with the first can pass the `this.current === null`
   * pre-check while the first is still awaiting its provision/BLE work, and
   * end up provisioning two separate streams. A teardown racing with a start
   * can clear `current` mid-stop and let the start fire BLE writes that
   * collide with the in-flight stopStream.
   */
  private inFlight: Promise<void> = Promise.resolve()
  /** Drop identical stream_status fanouts within one session. */
  private lastFanoutSignature: string | null = null
  /** Send full resolvedConfig only once per stream session. */
  private resolvedConfigForwarded = false

  constructor(timings: CoordinatorTimings = {}, deps: {linkSource?: GlassesLinkSource} = {}) {
    this.timings = {...DEFAULT_TIMINGS, ...timings}
    this.linkSource = deps.linkSource ?? storeLinkSource
  }

  /**
   * Fail fast if glasses aren't connected — BEFORE provisioning. Without this a
   * managed start would create a provider live input, fail the BLE command, and
   * tear the input down again: a slow, billable no-op with a confusing error.
   */
  private assertGlassesConnected(): void {
    if (!this.linkSource.isConnected()) {
      throw new StreamConflictError(
        "GLASSES_NOT_CONNECTED",
        "Glasses are not connected",
        "command",
        "ble",
      )
    }
  }

  /** True while the active stream is parked on a dropped BLE link. */
  isSuspended(): boolean {
    return this.suspended !== null
  }

  /**
   * Run `work` under the transition lock. Each call awaits the previous
   * transition before re-evaluating preconditions, so e.g. two concurrent
   * `startManaged` calls are observed sequentially.
   */
  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const prev = this.inFlight
    let release!: () => void
    this.inFlight = new Promise<void>((r) => (release = r))
    try {
      await prev
      return await work()
    } finally {
      release()
    }
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

  /** Report-safe stream ownership snapshot for incident diagnostics. */
  getDiagnosticSnapshot(): Record<string, unknown> {
    if (!this.current) return {active: false, pendingBleStop: this.pendingBleStop?.streamId ?? null}
    const link = {
      suspended: this.suspended !== null,
      ...(this.suspended ? {suspendedForMs: Date.now() - this.suspended.since} : {}),
    }
    return this.current.kind === "managed"
      ? {
          active: true,
          kind: this.current.kind,
          streamId: this.current.streamId,
          subscribers: [...this.current.subscribers].sort(),
          mode: this.current.mode,
          playbackReady: this.current.hlsReady,
          ...link,
        }
      : {
          active: true,
          kind: this.current.kind,
          streamId: this.current.streamId,
          ownerPackageName: this.current.packageName,
          ...link,
        }
  }

  async startUnmanaged(
    packageName: string,
    opts: StartUnmanagedOptions,
  ): Promise<StreamPublisherStartResult> {
    // Pre-check the obvious-bad input before queueing — the lock is for
    // serializing state transitions, not for validating arguments.
    if (!opts.streamUrl || typeof opts.streamUrl !== "string") {
      throw new StreamConflictError("STREAM_URL_REQUIRED", "streamUrl is required")
    }
    this.assertGlassesConnected()
    return this.runExclusive(async () => {
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
      // Claim the slot BEFORE the BLE call so a concurrent caller waiting on
      // the lock sees the in-progress entry and rejects with the conflict.
      this.current = entry

      try {
        const event = await BluetoothSdk.startExternallyManagedStream({
          type: "start_stream",
          streamUrl: opts.streamUrl,
          streamId,
          sound: opts.sound ?? true,
          // The native bridge rejects explicit `undefined` values ("Value is
          // undefined, expected an Object") — only include what was provided.
          ...(opts.video !== undefined ? {video: opts.video} : {}),
          ...(opts.audio !== undefined ? {audio: opts.audio} : {}),
          ...(opts.authToken ? {authToken: opts.authToken} : {}),
          ...(typeof opts.captureAudio === "boolean" ? {captureAudio: opts.captureAudio} : {}),
          ...(opts.ice !== undefined ? {ice: opts.ice} : {}),
          ...(opts.traceId ? {traceId: opts.traceId} : {}),
        })
        const result = publisherStartResult(streamId, event)
        this.startLifecycle(streamId)
        return result
      } catch (err) {
        this.current = null
        throw err
      }
    })
  }

  async startManaged(
    packageName: string,
    opts: StartManagedOptions,
  ): Promise<ManagedStartResult> {
    const startupStartedAtMs = Date.now()
    // streamId doesn't exist yet — it's minted a few lines below, once we
    // know this is a fresh provision rather than a join onto an existing one.
    console.info("[STREAM_STARTUP]", {
      stage: "requested",
      packageName,
      ingest: opts.ingest,
      elapsedMs: 0,
    })
    // Two-phase: the entry-claim runs under the transition lock; the wait for
    // HLS readiness happens AFTER the lock releases so a long warm-up doesn't
    // block subsequent start/stop transitions on this coordinator.
    this.assertGlassesConnected()
    type JoinDecision =
      | {kind: "join"; entry: ManagedEntry; immediate: ManagedStartResult | null}
      | {kind: "fresh"; entry: ManagedEntry}

    const decision = await this.runExclusive(async (): Promise<JoinDecision> => {
      if (this.current && this.current.kind === "unmanaged") {
        throw new StreamConflictError(
          "STREAM_ALREADY_ACTIVE",
          "An unmanaged stream is already active. Stop it before starting a managed stream.",
        )
      }

      // Join an existing managed stream if one is already running.
      if (this.current && this.current.kind === "managed") {
        const existing = this.current
        // Restream destinations are immutable after provision — a second
        // caller trying to dictate destinations on an already-live stream
        // is a likely bug or a feature we don't yet support.
        if (opts.restreamDestinations && opts.restreamDestinations.length > 0) {
          throw new StreamConflictError(
            "STREAM_DESTINATIONS_LOCKED",
            "Restream destinations cannot be modified on an already-running managed stream.",
          )
        }
        existing.subscribers.add(packageName)
        const immediate: ManagedStartResult | null = existing.hlsReady
          ? managedStartResult(existing)
          : null
        return {kind: "join", entry: existing, immediate}
      }

      // Fresh provision — claim slot BEFORE awaiting Cloudflare so a
      // concurrent caller queued behind us sees a managed stream in flight
      // and joins instead of double-provisioning.
      const provision = await provisionManagedStream(opts.restreamDestinations)
      const streamId = this.mintId("m")
      const ingestUrl = pickIngestUrl(provision, opts.ingest)
      const mode: ManagedEntry["mode"] =
        ingestUrl === provision.webrtcPublishUrl ? "webrtc" : "hls"

      const entry: ManagedEntry = {
        kind: "managed",
        streamId,
        liveInputId: provision.liveInputId,
        ingestUrl,
        mode,
        hlsUrl: provision.hlsUrl,
        dashUrl: provision.dashUrl,
        webrtcUrl: provision.webrtcUrl,
        subscribers: new Set([packageName]),
        hlsReady: false,
        hlsReadyResolvers: [],
        hlsReadyRejecters: [],
        hlsAttempts: 0,
        cloudflareAttempts: 0,
        startupStartedAtMs,
      }
      this.current = entry

      console.info("[STREAM_STARTUP]", {
        streamId,
        stage: "provisioned",
        mode,
        elapsedMs: Date.now() - startupStartedAtMs,
      })

      try {
        const event = await BluetoothSdk.startExternallyManagedStream({
          type: "start_stream",
          streamUrl: ingestUrl,
          streamId,
          sound: opts.sound ?? true,
          // See startUnmanaged: the native bridge rejects explicit `undefined`.
          ...(opts.video !== undefined ? {video: opts.video} : {}),
          ...(opts.audio !== undefined ? {audio: opts.audio} : {}),
          ...(typeof opts.captureAudio === "boolean" ? {captureAudio: opts.captureAudio} : {}),
        })
        entry.publisherStart = publisherStartResult(streamId, event)
        console.info("[STREAM_STARTUP]", {
          streamId,
          stage: "publisher_ready",
          mode,
          elapsedMs: Date.now() - startupStartedAtMs,
        })
      } catch (err) {
        this.current = null
        await teardownManagedStream(provision.liveInputId).catch(() => undefined)
        throw err
      }

      this.startLifecycle(streamId)
      this.startCloudflareStatusPoll(entry)
      // hls mode: readiness = a real HLS manifest exists. webrtc mode: HLS
      // never materializes (Cloudflare WHIP limitation) — readiness resolves
      // off the status poll's first "connected" instead.
      if (entry.mode === "hls") {
        this.startHlsReadinessPoll(entry)
      }
      return {kind: "fresh", entry}
    })

    if (decision.kind === "join" && decision.immediate) {
      return decision.immediate
    }

    // The first Cloudflare probe runs immediately and can complete before the
    // transition lock releases. Avoid stranding this caller after readiness
    // resolvers have already been drained.
    if (decision.entry.hlsReady) {
      return managedStartResult(decision.entry)
    }

    // Wait for playback readiness OUTSIDE the lock — readiness can take ~10s
    // and we don't want to block other transitions for that long.
    return new Promise<ManagedStartResult>((resolve, reject) => {
      decision.entry.hlsReadyResolvers.push(resolve)
      decision.entry.hlsReadyRejecters.push(reject)
    })
  }

  async stop(packageName: string, streamId?: string): Promise<void> {
    await this.runExclusive(async () => {
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

      await this.teardownLocked("explicit_stop")
    })
  }

  /**
   * Called by MantleManager when a `stream_status` event arrives from glasses
   * and the registry says it's phone-owned.
   */
  handleGlassesStatus(event: StreamStatusEvent): void {
    if (!this.current) return
    if (event.streamId && event.streamId !== this.current.streamId) return

    this.lifecycle?.recordActivity()
    const includeResolvedConfig = !this.resolvedConfigForwarded && !!event.resolvedConfig
    if (includeResolvedConfig) this.resolvedConfigForwarded = true
    const slimData = slimStreamStatusEvent(event, {includeResolvedConfig})
    const signature = streamStatusSignature(slimData)
    if (signature === this.lastFanoutSignature) return
    this.lastFanoutSignature = signature

    this.fanout({
      streamId: this.current.streamId,
      source: "glasses",
      status: event.status,
      data: slimData,
    })

    // Glasses-reported TERMINAL states unwind the coordinator. Terminal means
    // the publisher gave up or stopped — NOT a transient `kind:"error"`: the
    // glasses publisher auto-recovers (error → reconnecting → reconnected),
    // and tearing down on the first hiccup deletes the live input out from
    // under a publisher that comes right back (it then retries into a dead
    // input forever). A publisher that errors and never recovers is reaped by
    // the keep-alive ack timeout. Queue the teardown through the transition
    // lock so it serializes with any start/stop currently in flight.
    const isStopped =
      (event.kind === "lifecycle" && event.status === "stopped") ||
      (event.kind === "snapshot" && event.status === "stopped")
    const isGiveUp = event.kind === "reconnect" && event.status === "reconnect_failed"
    if (isGiveUp || isStopped) {
      const reason = isGiveUp ? "glasses_gave_up" : "glasses_stopped"
      const targetStreamId = this.current.streamId
      void this.runExclusive(async () => {
        // The stream we wanted to tear down may already be gone (e.g. another
        // teardown won the lock and unwound it). Guard before acting.
        if (this.current?.streamId !== targetStreamId) return
        await this.teardownLocked(reason, {sendBleStop: false})
      })
    }
  }

  /** Called by MantleManager when a phone-owned keep_alive_ack arrives. */
  handleKeepAliveAck(event: KeepAliveAckEvent): void {
    if (!event.ackId) return
    this.lifecycle?.handleAck(event.ackId)
  }

  // ===========================================================================
  // BLE link suspension
  // ===========================================================================

  private attachLink(): void {
    if (this.unsubscribeLink) return
    this.unsubscribeLink = this.linkSource.subscribe((connected) => this.handleLinkChange(connected))
  }

  private detachLinkIfIdle(): void {
    if (this.current || this.pendingBleStop || !this.unsubscribeLink) return
    this.unsubscribeLink()
    this.unsubscribeLink = null
  }

  private handleLinkChange(connected: boolean): void {
    if (connected) {
      if (this.current && this.suspended) {
        this.resumeLocked()
      } else if (!this.current && this.pendingBleStop) {
        this.flushPendingBleStop()
      }
      return
    }
    if (this.current && !this.suspended) this.suspend()
  }

  private suspend(): void {
    const entry = this.current
    if (!entry) return
    const since = Date.now()
    // Pause the heartbeat: misses now would be our own fault, not the
    // publisher's, and counting them would reap a stream that is still live.
    this.lifecycle?.setActive(false)
    const graceTimer = setTimeout(() => this.onGraceExpired(entry.streamId), this.timings.glassesGraceMs)
    this.suspended = {since, graceTimer, publisherGoneProbes: 0}
    console.warn("[STREAM] BLE link lost; stream suspended", {
      streamId: entry.streamId,
      graceMs: this.timings.glassesGraceMs,
    })
    this.fanout({
      streamId: entry.streamId,
      source: "coordinator",
      status: LINK_STATUS.suspended,
      data: {reason: LINK_STATUS.reason, graceMs: this.timings.glassesGraceMs, since},
    })
  }

  private resumeLocked(): void {
    const entry = this.current
    const suspended = this.suspended
    if (!entry || !suspended) return
    clearTimeout(suspended.graceTimer)
    this.suspended = null
    const suspendedMs = Date.now() - suspended.since
    console.info("[STREAM] BLE link back; stream resumed", {streamId: entry.streamId, suspendedMs})
    // Resume and heartbeat immediately: the glasses watchdog has been running
    // the whole time, so the first keep-alive must not wait another interval.
    this.lifecycle?.setActive(true)
    this.lifecycle?.tickNow()
    // A resumed session is a fresh status baseline for subscribers.
    this.lastFanoutSignature = null
    this.fanout({
      streamId: entry.streamId,
      source: "coordinator",
      status: LINK_STATUS.resumed,
      data: {reason: LINK_STATUS.reason, suspendedMs},
    })
  }

  private onGraceExpired(streamId: string): void {
    if (this.current?.streamId !== streamId || !this.suspended) return
    this.failSuspended(streamId, "glasses_disconnected", {publisherGone: false})
  }

  /**
   * End a suspended stream. `publisherGone` distinguishes "glasses are off and
   * Cloudflare confirms nothing is publishing" from "grace ran out with the
   * publisher possibly still alive" — miniapps word the two differently.
   */
  private failSuspended(streamId: string, reason: string, detail: {publisherGone: boolean}): void {
    this.fanout({
      streamId,
      source: "coordinator",
      status: "error",
      data: {reason: LINK_STATUS.reason, teardownReason: reason, ...detail},
    })
    void this.runExclusive(async () => {
      if (this.current?.streamId !== streamId) return
      await this.teardownLocked(reason)
    })
  }

  private flushPendingBleStop(): void {
    const pending = this.pendingBleStop
    if (!pending) return
    this.pendingBleStop = null
    console.info("[STREAM] BLE link back; sending deferred stopStream", pending)
    void BluetoothSdk.stopStream()
      .catch((err) => console.warn("[STREAM] deferred stopStream failed:", err))
      .finally(() => this.detachLinkIfIdle())
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private mintId(prefix: "u" | "m"): string {
    this.idCounter += 1
    return `phone-${prefix}-${Date.now().toString(36)}-${this.idCounter}`
  }

  /** BLE keep-alives. StreamLifecycleController uses BgTimer so they survive MentraOS backgrounding. */
  private startLifecycle(streamId: string): void {
    // A new stream supersedes any deferred stop for the previous one.
    this.pendingBleStop = null
    this.attachLink()
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
          await BluetoothSdk.sendExternallyManagedStreamKeepAlive({
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
          await this.runExclusive(async () => {
            // The stream this timeout was bound to may already be gone.
            if (this.current?.streamId !== streamId) return
            await this.teardownLocked("keep_alive_timeout")
          })
        },
      },
    )
    ctrl.setActive(true)
    this.lifecycle = ctrl
  }

  private startCloudflareStatusPoll(entry: ManagedEntry): void {
    // Keep the existing ~60s readiness budget while decoupling it from probe
    // count. Startup probes begin immediately and back off to the normal 5s
    // monitoring cadence, so a just-connected publisher is noticed quickly
    // without increasing steady-state traffic.
    const connectTimeoutMs = Math.max(1, this.timings.hlsReadinessMaxAttempts * this.timings.hlsReadinessPollMs)
    const pollingStartedAtMs = Date.now()

    const scheduleNext = () => {
      if (this.current !== entry) return
      const waitingForWebRtc = entry.mode === "webrtc" && !entry.hlsReady
      const elapsedMs = Date.now() - pollingStartedAtMs
      const remainingMs = Math.max(0, connectTimeoutMs - elapsedMs)
      const startupDelayMs = Math.min(
        this.timings.cloudflareStatusPollMs,
        this.timings.cloudflareStartupPollInitialMs * 2 ** Math.min(Math.max(0, entry.cloudflareAttempts - 1), 10),
      )
      const delayMs = waitingForWebRtc ? Math.min(startupDelayMs, remainingMs) : this.timings.cloudflareStatusPollMs
      entry.cloudflareTimer = setTimeout(() => void poll(), delayMs)
    }

    const poll = async () => {
      if (this.current !== entry) return
      const requestStartedAtMs = Date.now()
      let keepPolling = true
      entry.cloudflareAttempts += 1
      try {
        const status: CloudflareStatus = await getManagedStreamStatus(entry.liveInputId)
        console.debug("[STREAM_STARTUP]", {
          streamId: entry.streamId,
          stage: "cloudflare_probe",
          connected: status.isConnected,
          attempt: entry.cloudflareAttempts,
          requestMs: Date.now() - requestStartedAtMs,
          elapsedMs: Date.now() - entry.startupStartedAtMs,
        })
        this.fanout({
          streamId: entry.streamId,
          source: "cloudflare",
          status: status.isConnected ? "connected" : "disconnected",
          data: status as unknown as Record<string, unknown>,
        })
        // While the BLE link is down, Cloudflare is the only witness to the
        // publisher. Two consecutive "nobody is publishing" probes mean the
        // glasses are off, not merely out of Bluetooth range — stop waiting.
        if (this.suspended) {
          if (status.isConnected) {
            this.suspended.publisherGoneProbes = 0
          } else {
            this.suspended.publisherGoneProbes += 1
            if (this.suspended.publisherGoneProbes >= this.timings.suspendedPublisherGoneProbes) {
              this.failSuspended(entry.streamId, "glasses_disconnected_publisher_gone", {publisherGone: true})
              keepPolling = false
            }
          }
        }
        // webrtc mode readiness: first "connected" means WHEP playback is
        // available (WebRTC playback follows the ingest directly; there is no
        // manifest to probe).
        if (entry.mode === "webrtc" && !entry.hlsReady) {
          if (status.isConnected) {
            entry.hlsReady = true
            console.info("[STREAM_STARTUP]", {
              streamId: entry.streamId,
              stage: "playback_ready",
              mode: entry.mode,
              probes: entry.cloudflareAttempts,
              elapsedMs: Date.now() - entry.startupStartedAtMs,
            })
            const result = managedStartResult(entry)
            for (const r of entry.hlsReadyResolvers) r(result)
            entry.hlsReadyResolvers = []
            entry.hlsReadyRejecters = []
            this.fanout({
              streamId: entry.streamId,
              source: "coordinator",
              status: "webrtc_ready",
              data: result as unknown as Record<string, unknown>,
            })
          } else {
            if (Date.now() - pollingStartedAtMs >= connectTimeoutMs) {
              const err = new Error(`WebRTC ingest never reached Cloudflare after ${connectTimeoutMs}ms`)
              for (const reject of entry.hlsReadyRejecters) reject(err)
              entry.hlsReadyResolvers = []
              entry.hlsReadyRejecters = []
              this.fanout({
                streamId: entry.streamId,
                source: "coordinator",
                status: "error",
                data: {reason: "webrtc_not_connected"},
              })
              const targetStreamId = entry.streamId
              void this.runExclusive(async () => {
                if (this.current?.streamId !== targetStreamId) return
                await this.teardownLocked("webrtc_not_connected")
              })
              keepPolling = false
            }
          }
        }
      } catch (err) {
        console.warn("[STREAM] cloudflare status poll failed:", err)
        if (entry.mode === "webrtc" && !entry.hlsReady && Date.now() - pollingStartedAtMs >= connectTimeoutMs) {
          const timeoutErr = new Error(`WebRTC ingest status could not be confirmed after ${connectTimeoutMs}ms`)
          for (const reject of entry.hlsReadyRejecters) reject(timeoutErr)
          entry.hlsReadyResolvers = []
          entry.hlsReadyRejecters = []
          const targetStreamId = entry.streamId
          void this.runExclusive(async () => {
            if (this.current?.streamId !== targetStreamId) return
            await this.teardownLocked("webrtc_status_unavailable")
          })
          keepPolling = false
        }
      } finally {
        if (keepPolling) scheduleNext()
      }
    }

    // The glasses publisher has already reported streaming, so the first
    // status request is useful now. Most starts avoid the old blind 5s wait.
    void poll()
  }

  private startHlsReadinessPoll(entry: ManagedEntry): void {
    // Skip the first few seconds — Cloudflare doesn't have first-frame yet,
    // and the HEAD requests would all 404 and burn battery.
    const tick = async () => {
      if (this.current !== entry) return
      entry.hlsAttempts += 1
      try {
        // Require a real manifest (200 with a body), not just res.ok — the
        // playback edge returns 204 No Content while the input has no
        // HLS-capable frames (e.g. WebRTC ingest), and 204 is "ok".
        const res = await fetch(entry.hlsUrl, {method: "HEAD"})
        if (res.status === 200) {
          entry.hlsReady = true
          console.info("[STREAM_STARTUP]", {
            streamId: entry.streamId,
            stage: "playback_ready",
            mode: entry.mode,
            probes: entry.hlsAttempts,
            elapsedMs: Date.now() - entry.startupStartedAtMs,
          })
          if (entry.hlsTimer) {
            clearInterval(entry.hlsTimer)
            entry.hlsTimer = undefined
          }
          const result = managedStartResult(entry)
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
        const targetStreamId = entry.streamId
        void this.runExclusive(async () => {
          if (this.current?.streamId !== targetStreamId) return
          await this.teardownLocked("hls_not_ready")
        })
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

  /**
   * Run teardown of the currently-active stream. Caller must hold the
   * transition lock (see {@link runExclusive}). Keeps `this.current`
   * populated until BluetoothSdk.stopStream resolves so a concurrent caller
   * waiting on the lock can't claim the slot mid-stop and have its
   * startStream BLE write collide with our in-flight stopStream.
   */
  private async teardownLocked(reason: string, options: {sendBleStop?: boolean} = {}): Promise<void> {
    const entry = this.current
    if (!entry) return
    const sendBleStop = options.sendBleStop !== false

    this.lastFanoutSignature = null
    this.resolvedConfigForwarded = false

    if (this.suspended) {
      clearTimeout(this.suspended.graceTimer)
      this.suspended = null
    }

    // Dispose the lifecycle controller immediately so it doesn't fire one
    // more keep-alive against a stream we're tearing down. The transition
    // lock guarantees no new lifecycle is started concurrently.
    this.lifecycle?.dispose()
    this.lifecycle = null

    // With the link down a BLE write can only fail (and hold the transition
    // lock for the native timeout). Defer it to the next reconnect instead.
    const linkUp = this.linkSource.isConnected()
    if (sendBleStop && !linkUp) {
      this.pendingBleStop = {streamId: entry.streamId}
      console.warn("[STREAM] BLE link down during teardown; stopStream deferred", {
        streamId: entry.streamId,
        reason,
      })
    }

    if (entry.kind === "managed") {
      if (entry.cloudflareTimer) clearTimeout(entry.cloudflareTimer)
      if (entry.hlsTimer) clearInterval(entry.hlsTimer)
      // Reject any still-pending HLS readiness waiters.
      const pendingErr = new Error(`Stream torn down: ${reason}`)
      for (const reject of entry.hlsReadyRejecters) reject(pendingErr)
      entry.hlsReadyResolvers = []
      entry.hlsReadyRejecters = []
    }

    try {
      if (sendBleStop && linkUp) {
        await BluetoothSdk.stopStream()
      }
    } catch (err) {
      console.warn("[STREAM] BluetoothSdk.stopStream failed:", err)
    } finally {
      // Release the slot AFTER the BLE stop finished, so the next start can
      // safely write its own start_stream without colliding with ours.
      // Only clear if we're still the active entry (defensive — runExclusive
      // serializes us, so this should always be true).
      if (this.current === entry) this.current = null
      this.detachLinkIfIdle()

      if (entry.kind === "managed") {
        // Start remote cleanup only after the publisher has stopped, but do not
        // hold the local transition lock on an unbounded network request. The
        // runtime's durable cleanup queue owns retries if this request fails or
        // the app exits before Cloudflare finishes finalizing the recording.
        void teardownManagedStream(entry.liveInputId).catch((err) => {
          console.warn("[STREAM] teardownManagedStream failed:", err)
        })
      }
    }
  }
}

function pickIngestUrl(p: ProvisionResult, preference?: "srt" | "whip" | "rtmp"): string {
  // Glasses' StreamCommandHandler detects protocol from URL prefix.
  //
  // Default priority: SRT > RTMP > WHIP. SRT first: Cloudflare's WebRTC (WHIP)
  // ingest does NOT feed HLS/DASH playback or recording — a WHIP-ingested
  // managed stream reports "connected" while its hlsUrl serves 204 forever,
  // which breaks the managed contract (subscribers share HLS playback). SRT
  // also survives office firewalls that kill RTMPS:443 mid-handshake.
  //
  // "whip" preference flips the trade: sub-second WHEP playback for
  // live-monitor use cases, accepting no HLS and no recording.
  // "rtmp" prefers TCP 443 ingest so networks that drop WHIP/SRT UDP still
  // get HLS playback. Callers must request it explicitly; WHIP starts do not
  // fall back to RTMP.
  //
  // Throw if none resolved so the caller's Promise rejects with a clear
  // message rather than the glasses' "unknown protocol" error.
  const url =
    preference === "whip"
      ? p.webrtcPublishUrl || p.srtUrl || p.rtmpUrl
      : preference === "rtmp"
        ? p.rtmpUrl || p.srtUrl || p.webrtcPublishUrl
        : p.srtUrl || p.rtmpUrl || p.webrtcPublishUrl
  if (!url) {
    throw new Error("Cloudflare provision returned no usable ingest URL")
  }
  return url
}

function publisherStartResult(streamId: string, event?: StreamStatusEvent): StreamPublisherStartResult {
  return {
    streamId: event?.streamId || streamId,
    status: event?.status ?? "streaming",
    ...(event?.resolvedConfig ? {resolvedConfig: event.resolvedConfig} : {}),
  }
}

function managedStartResult(entry: ManagedEntry): ManagedStartResult {
  const publisher = entry.publisherStart ?? publisherStartResult(entry.streamId)
  return {
    ...publisher,
    streamId: entry.streamId,
    liveInputId: entry.liveInputId,
    mode: entry.mode,
    hlsUrl: entry.hlsUrl,
    dashUrl: entry.dashUrl,
    webrtcUrl: entry.webrtcUrl,
  }
}

// Singleton — coordinator's single-stream constraint is process-wide.
export const phoneStreamCoordinator = new PhoneStreamCoordinator()
