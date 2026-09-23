/**
 * The preview connection for this document.
 *
 * Three owners with three lifetimes meet here:
 *   - The **lease** belongs to the miniapp's background (`session.stream.preview()`). The page
 *     never creates or releases it; it only hears `lease_available` / `lease_ended`.
 *   - The **connection** belongs to this document: the host config (token, docGen), the frame
 *     transport and the credit loop. It is a module-scoped singleton so it survives
 *     `<StreamPreview>` unmounting and remounting; a remount sends `start` without a handshake.
 *     It ends with the document (reload, navigation, `pagehide`) or when the lease ends.
 *   - The **renderer** belongs to the component and is attached here only as a draw callback.
 *
 * Control is desired-state: the component says which mount epoch wants which tier and whether it
 * wants frames, and `sync()` sends the difference to the host over `_preview`. A new document
 * always needs a new handshake; a new mount never does.
 */

import {createMentraControlChannel, PreviewControlError} from "./controlChannel"
import type {
  PreviewControlChannel,
  PreviewControlReply,
  PreviewControlRequest,
  PreviewDocumentConfig,
  PreviewHandshakeResult,
  PreviewHostEvent,
} from "./controlChannel"
import {CreditLoop, type CreditLoopStats} from "./creditLoop"
import type {ParsedFrame} from "./protocol"
import {sameTier, type PreviewTier} from "./tiers"
import {previewTrace, previewTraceWarn, previewTraceWarnLimited} from "./trace"
import {ackMessage, createPreviewTransport, type PreviewTransport, type PreviewTransportOptions} from "./transport"

/** The only control protocol this SDK speaks. Anything else is reported as `unsupported`. */
export const PREVIEW_PROTOCOL_VERSION = 1

/** Automatic re-handshakes after a transport failure, per window, before giving up until remount. */
const RECONNECT_BUDGET = 3
const RECONNECT_WINDOW_MS = 60_000
/** Immediate re-handshakes after the host answers a handshake as stale. */
const STALE_HANDSHAKE_RETRIES = 2

export type PreviewConnectionState =
  /** No handshake attempted yet in this document, or the lease ended and nobody wants frames. */
  | "idle"
  | "handshaking"
  /** The host has no lease for this miniapp yet. Not an error: `lease_available` will follow. */
  | "waiting_for_lease"
  | "connecting"
  | "open"
  /** A failure that a re-handshake may fix (transport lost, ack timeout, host refused). */
  | "error"
  /** Terminal for this document: unknown protocol version or missing platform support. */
  | "unsupported"
  /** Not running inside a Mentra App WebView. */
  | "unavailable"
  | "closed"

export interface PreviewConnectionStateDetail {
  code?: string
  reason?: string
  paused?: boolean
}

/** What a mounted `<StreamPreview>` gives the connection. */
export interface PreviewSink {
  readonly mountEpoch: number
  /** Submit one frame; null when the renderer has no usable context. */
  draw(frame: ParsedFrame): number | null
  onState(state: PreviewConnectionState, detail: PreviewConnectionStateDetail): void
  onStatus(status: Record<string, unknown>): void
  onError(code: string): void
}

export interface PreviewDesiredState {
  /** Rendered box in device pixels; only sent when `tier` changes. */
  boxWidth: number
  boxHeight: number
  /** Null means hidden (zero-size box). */
  tier: PreviewTier | null
  /** False while the page is hidden (`visibilitychange`) or the component is unmounting. */
  running: boolean
}

export interface PreviewConnectionCounters {
  handshakes: number
  reconnects: number
  staleReplies: number
  staleLocalOps: number
  tierChanges: number
  page: CreditLoopStats
}

export interface PreviewConnectionDeps {
  channel: PreviewControlChannel | null
  createTransport?: (transport: "websocket" | "webmessage", options: PreviewTransportOptions) => PreviewTransport
  now?: () => number
  /** Document event hookup; defaults to the real `document`/`window`. */
  listen?: (target: "document" | "window", type: string, handler: () => void) => () => void
  isDocumentVisible?: () => boolean
}

function defaultListen(target: "document" | "window", type: string, handler: () => void): () => void {
  const node =
    target === "document"
      ? typeof document === "undefined"
        ? null
        : document
      : typeof window === "undefined"
        ? null
        : window
  if (!node) return () => {}
  node.addEventListener(type, handler)
  return () => node.removeEventListener(type, handler)
}

function defaultIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

interface Applied {
  epoch: number
  tier: PreviewTier | null
  running: boolean
}

const NOTHING_APPLIED: Applied = {epoch: -1, tier: null, running: false}

export class PreviewConnection {
  private state: PreviewConnectionState
  private detail: PreviewConnectionStateDetail = {}
  private docGen = 0
  private config: PreviewDocumentConfig | null = null
  private transport: PreviewTransport | null = null
  /** Bumped whenever the transport is dropped, so a stale async continuation can tell. */
  private connectionGen = 0
  private mountEpochCounter = 0
  private latestEpoch = 0
  private sink: PreviewSink | null = null
  private desired: {epoch: number; state: PreviewDesiredState} | null = null
  private applied: Applied = NOTHING_APPLIED
  /** Epoch whose production the host halted on a non-recoverable error; not restarted until remount. */
  private haltedEpoch = -1
  private handshaking: Promise<boolean> | null = null
  private opChain: Promise<void> = Promise.resolve()
  private reconnectTimes: number[] = []
  private paused = false
  private readonly creditLoop: CreditLoop
  private readonly createTransport: NonNullable<PreviewConnectionDeps["createTransport"]>
  private readonly now: () => number
  private readonly isVisible: () => boolean
  private readonly unsubscribers: Array<() => void> = []
  private counters = {handshakes: 0, reconnects: 0, staleReplies: 0, staleLocalOps: 0, tierChanges: 0}

  constructor(private readonly deps: PreviewConnectionDeps) {
    this.createTransport = deps.createTransport ?? createPreviewTransport
    this.now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()))
    this.isVisible = deps.isDocumentVisible ?? defaultIsVisible
    this.state = deps.channel ? "idle" : "unavailable"
    this.creditLoop = new CreditLoop({
      sendAck: (gen, seq) => this.transport?.sendText(ackMessage(gen, seq)),
      onParseError: (reason) =>
        previewTraceWarnLimited(`parse:${reason}`, "parse_reject", {reason, docGen: this.docGen}),
    })
    if (deps.channel) {
      this.unsubscribers.push(deps.channel.onEvent((event) => this.handleHostEvent(event)))
      const listen = deps.listen ?? defaultListen
      this.unsubscribers.push(listen("window", "pagehide", () => this.close("pagehide")))
      // A page restored from the back/forward cache is the same document with a dead transport.
      this.unsubscribers.push(
        listen("window", "pageshow", () => {
          if (this.state !== "closed") return
          this.setState("idle", {reason: "pageshow"})
          this.sync()
        }),
      )
      this.unsubscribers.push(listen("document", "visibilitychange", () => this.handleVisibility()))
    }
  }

  get currentState(): PreviewConnectionState {
    return this.state
  }

  get documentGeneration(): number {
    return this.docGen
  }

  snapshot(): PreviewConnectionCounters {
    return {...this.counters, page: this.creditLoop.snapshot()}
  }

  /** A fresh, strictly increasing epoch for a component mounting in this document. */
  nextMountEpoch(): number {
    this.mountEpochCounter += 1
    return this.mountEpochCounter
  }

  /**
   * Route frames to this component's renderer. The newest mount wins; an older sink detaching
   * later cannot remove a newer one.
   */
  attach(sink: PreviewSink): () => void {
    if (sink.mountEpoch < this.latestEpoch) {
      this.counters.staleLocalOps += 1
      return () => {}
    }
    this.latestEpoch = sink.mountEpoch
    this.sink = sink
    this.creditLoop.setDraw((frame) => sink.draw(frame))
    sink.onState(this.state, {...this.detail, paused: this.paused})
    return () => {
      if (this.sink !== sink) return
      this.sink = null
      this.creditLoop.setDraw(null)
    }
  }

  /** Declare what `mountEpoch` wants. Operations from a superseded epoch are ignored. */
  update(mountEpoch: number, state: PreviewDesiredState): void {
    if (mountEpoch < this.latestEpoch) {
      this.counters.staleLocalOps += 1
      previewTrace("stale_local_op", {mountEpoch, latestEpoch: this.latestEpoch})
      return
    }
    this.latestEpoch = mountEpoch
    this.desired = {epoch: mountEpoch, state}
    this.sync()
  }

  reportRendererError(mountEpoch: number, message: string): void {
    this.creditLoop.recordError(message)
    if (this.state !== "open" || !this.config) return
    void this.send({cmd: "rendererError", mountEpoch, message}).catch(() => undefined)
  }

  /** End of document. The lease is untouched; a new document will handshake again. */
  close(reason: string): void {
    if (this.state === "closed") return
    previewTrace("connection_closed", {reason, docGen: this.docGen})
    this.dropTransport()
    this.setState("closed", {reason})
  }

  /** Test seam: detach from the channel and document. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.dropTransport()
  }

  // ---------------------------------------------------------------------------

  private sync(): void {
    this.opChain = this.opChain
      .then(() => this.syncOnce())
      .catch((error: unknown) => {
        previewTraceWarn("sync_failed", {error: error instanceof Error ? error.message : String(error)})
      })
  }

  private wantsFrames(): boolean {
    const desired = this.desired
    return !!desired && desired.state.running && desired.state.tier !== null && desired.epoch !== this.haltedEpoch
  }

  private async syncOnce(): Promise<void> {
    const desired = this.desired
    if (!desired) return
    if (this.state !== "open") {
      // Hidden components never force a handshake; the next visible one will.
      if (!this.wantsFrames()) return
      if (!(await this.ensureOpen())) return
    }
    const gen = this.connectionGen
    const {epoch, state} = desired
    if (state.tier && !sameTier(state.tier, this.applied.tier)) {
      const reply = await this.send({
        cmd: "configure",
        mountEpoch: epoch,
        boxWidth: state.boxWidth,
        boxHeight: state.boxHeight,
      })
      if (gen !== this.connectionGen || !this.accept(reply, "configure")) return
      this.counters.tierChanges += 1
      previewTrace("tier_sent", {
        mountEpoch: epoch,
        width: state.tier.width,
        height: state.tier.height,
        docGen: this.docGen,
      })
      this.applied = {...this.applied, tier: state.tier}
    }
    const running = this.wantsFrames()
    if (running !== this.applied.running || (running && epoch !== this.applied.epoch)) {
      const reply = await this.send({cmd: running ? "start" : "stop", mountEpoch: epoch})
      if (gen !== this.connectionGen || !this.accept(reply, running ? "start" : "stop")) return
      this.applied = {...this.applied, epoch, running}
    }
  }

  /** False when the host dropped the op as stale; our identity is then out of date. */
  private accept(reply: PreviewControlReply | null, cmd: string): boolean {
    if (!reply) return false
    if (!reply.stale) return true
    this.counters.staleReplies += 1
    previewTraceWarn("control_stale", {cmd, docGen: this.docGen})
    // The host no longer recognises this document's credential: start over with a handshake.
    this.dropTransport()
    this.setState("idle", {reason: "stale_identity"})
    this.scheduleReconnect("stale_identity")
    return false
  }

  private async send(request: Omit<PreviewControlRequest, "docGen" | "token">): Promise<PreviewControlReply | null> {
    const channel = this.deps.channel
    if (!channel) return null
    try {
      const reply = await channel.request({...request, docGen: this.docGen, token: this.config?.token})
      return (reply ?? {}) as PreviewControlReply
    } catch (error) {
      const code = error instanceof PreviewControlError ? error.code : "transport_failed"
      previewTraceWarn("control_failed", {cmd: request.cmd, code, docGen: this.docGen})
      this.sink?.onError(code)
      return null
    }
  }

  private ensureOpen(): Promise<boolean> {
    if (this.state === "open") return Promise.resolve(true)
    if (this.state === "unsupported" || this.state === "unavailable" || this.state === "closed") {
      return Promise.resolve(false)
    }
    if (!this.handshaking) {
      this.handshaking = this.handshake().finally(() => {
        this.handshaking = null
      })
    }
    return this.handshaking
  }

  private async handshake(staleRetries = STALE_HANDSHAKE_RETRIES): Promise<boolean> {
    const channel = this.deps.channel
    if (!channel) return false
    const gen = this.connectionGen
    const mountEpoch = this.desired?.epoch ?? 0
    this.setState("handshaking")
    previewTrace("handshake_attempt", {docGen: this.docGen, mountEpoch})
    let result: PreviewHandshakeResult
    try {
      result = (await channel.request({cmd: "handshake", docGen: this.docGen, mountEpoch})) as PreviewHandshakeResult
    } catch (error) {
      const code = error instanceof PreviewControlError ? error.code : "transport_failed"
      previewTraceWarn("handshake_failed", {code, docGen: this.docGen})
      this.setState(code === "unsupported" ? "unsupported" : "error", {code})
      this.sink?.onError(code)
      return false
    }
    if (gen !== this.connectionGen) return false
    if (!result || typeof result !== "object") {
      this.setState("error", {code: "transport_failed"})
      return false
    }
    if ("stale" in result) {
      // The docGen this page claimed (or the one minted for it mid-handshake) was superseded,
      // e.g. by the `ready` that follows `handshake_without_ready`. Ask again as a page that does
      // not know its document yet; the host answers with its current one.
      this.counters.staleReplies += 1
      previewTraceWarn("handshake_stale", {docGen: this.docGen, staleRetries})
      this.docGen = 0
      if (staleRetries > 0) return this.handshake(staleRetries - 1)
      this.setState("error", {reason: "stale_identity"})
      return false
    }
    if (result.t === "waiting_for_lease") {
      if (typeof result.docGen === "number") this.docGen = result.docGen
      previewTrace("waiting_for_lease", {docGen: this.docGen})
      this.setState("waiting_for_lease")
      return false
    }
    return this.openTransport(result)
  }

  private async openTransport(config: PreviewDocumentConfig): Promise<boolean> {
    if (config.protocolVersion !== PREVIEW_PROTOCOL_VERSION) {
      previewTraceWarn("handshake_rejected", {reason: "unsupported_version", protocolVersion: config.protocolVersion})
      this.setState("unsupported", {code: "unsupported"})
      this.sink?.onError("unsupported")
      return false
    }
    this.docGen = config.docGen
    this.config = config
    this.counters.handshakes += 1
    this.setState("connecting")
    const gen = ++this.connectionGen
    let transport: PreviewTransport
    try {
      transport = this.createTransport(config.transport, {
        url: config.url,
        portName: config.portName,
        token: config.token,
      })
      transport.onBinary((buffer) => this.creditLoop.handleBinary(buffer))
      transport.onError((reason) => this.handleTransportError(gen, reason))
      await transport.connect()
    } catch (error) {
      const reason = (error as {reason?: string}).reason ?? "connect_failed"
      previewTraceWarn("transport_failed", {reason, docGen: this.docGen, transport: config.transport})
      if (gen === this.connectionGen) {
        this.config = null
        this.setState("error", {code: "transport_failed", reason})
        this.sink?.onError("transport_failed")
      }
      return false
    }
    if (gen !== this.connectionGen) {
      transport.close()
      return false
    }
    this.transport = transport
    this.applied = NOTHING_APPLIED
    previewTrace("handshake_ok", {
      docGen: this.docGen,
      transport: config.transport,
      handshakes: this.counters.handshakes,
    })
    this.setState("open")
    return true
  }

  private handleTransportError(gen: number, reason: string): void {
    if (gen !== this.connectionGen) return
    previewTraceWarn("transport_closed", {reason, docGen: this.docGen})
    this.dropTransport()
    this.setState("error", {code: "transport_failed", reason})
    this.sink?.onError("transport_failed")
    // A socket the OS tore down while suspended is re-established on foreground instead.
    if (this.isVisible()) this.scheduleReconnect(reason)
  }

  private handleHostEvent(event: PreviewHostEvent): void {
    switch (event.t) {
      case "lease_available":
        previewTrace("lease_available", {docGen: this.docGen, state: this.state})
        if (this.state === "waiting_for_lease" || this.state === "idle" || this.state === "error") {
          this.setState("idle")
          // Hidden stays connected-but-stopped, so handshake as soon as anyone has mounted.
          if (this.desired) void this.ensureOpen().then((open) => open && this.sync())
        }
        return
      case "lease_ended":
        previewTrace("lease_ended", {reason: event.reason, docGen: this.docGen})
        this.dropTransport()
        this.setState("waiting_for_lease", {reason: event.reason})
        if (event.reason === "source_ended") this.sink?.onError("source_ended")
        return
      case "error":
        if (typeof event.docGen === "number" && event.docGen !== this.docGen) return
        this.handleHostError(event.code)
        return
      case "status":
        this.sink?.onStatus({...event, page: this.snapshot()})
        return
      case "paused_background":
        this.paused = true
        this.sink?.onState(this.state, {...this.detail, paused: true})
        return
      case "resumed":
        this.paused = false
        this.sink?.onState(this.state, {...this.detail, paused: false})
        return
      case "config":
        if (event.docGen === this.docGen && this.state !== "open" && this.state !== "connecting") {
          void this.openTransport(event).then((open) => open && this.sync())
        }
        return
    }
  }

  private handleHostError(code: string): void {
    previewTraceWarn("host_error", {code, docGen: this.docGen})
    this.sink?.onError(code)
    if (code === "transport_failed" || code === "ack_timeout") {
      this.dropTransport()
      this.setState("error", {code})
      this.scheduleReconnect(code)
      return
    }
    // The host halted production (pack_failed, diagnostics_disabled, ...). Restarting would only
    // hit the same failure; a new mount epoch may try again.
    this.applied = {...this.applied, running: false}
    this.haltedEpoch = this.desired?.epoch ?? this.haltedEpoch
  }

  private handleVisibility(): void {
    const visible = this.isVisible()
    previewTrace("visibility", {visible, state: this.state, docGen: this.docGen})
    if (visible && (this.state === "error" || this.state === "idle")) this.sync()
  }

  private scheduleReconnect(reason: string): void {
    const at = this.now()
    this.reconnectTimes = this.reconnectTimes.filter((t) => at - t < RECONNECT_WINDOW_MS)
    if (this.reconnectTimes.length >= RECONNECT_BUDGET) {
      previewTraceWarn("reconnect_budget_exhausted", {reason, docGen: this.docGen})
      return
    }
    this.reconnectTimes.push(at)
    this.counters.reconnects += 1
    previewTrace("reconnect", {reason, docGen: this.docGen, reconnects: this.counters.reconnects})
    this.sync()
  }

  private dropTransport(): void {
    this.connectionGen += 1
    const transport = this.transport
    this.transport = null
    this.config = null
    this.applied = NOTHING_APPLIED
    if (transport) {
      transport.close()
      previewTrace("transport_close", {docGen: this.docGen})
    }
  }

  private setState(state: PreviewConnectionState, detail: PreviewConnectionStateDetail = {}): void {
    this.state = state
    this.detail = detail
    this.sink?.onState(state, {...detail, paused: this.paused})
  }
}

let shared: PreviewConnection | null = null

/** The connection for this document, created on first use. */
export function getPreviewConnection(): PreviewConnection {
  if (!shared) shared = new PreviewConnection({channel: createMentraControlChannel()})
  return shared
}

/** Test seam: replace (or clear) the document singleton, as a reload would. */
export function setPreviewConnectionForTests(next: PreviewConnection | null): void {
  shared?.dispose()
  shared = next
}
