import type {
  MentraUIHostReply,
  StreamPreviewHostPort,
  StreamPreviewMeetingSource,
  StreamPreviewStartRequest,
  StreamPreviewStartResult,
  StreamPreviewStatusEvent,
} from "@mentra/engine-host-internal"

import {createPreviewTraceLogger, type PreviewTraceFields, type PreviewTraceLogger} from "./previewTrace"

/**
 * Host side of `session.stream.preview()` and `<StreamPreview>`.
 *
 * Three owners, three lifetimes, and this class keeps them apart:
 *
 *  - The **lease** belongs to one background runtime and one meeting instance. It is created by
 *    `miniapp_stream_preview_start`, survives the UI closing and the WebView being destroyed, and
 *    ends on `stop`, when the meeting ends, or when that runtime stops. Exactly one exists.
 *  - The **document** belongs to one page load. Its generation is bumped when the page's shim says
 *    `ready` (never on `onLoadEnd`, which fires several times per load) and when the content
 *    process dies. Each document gets its own token; a new document always handshakes again.
 *  - The **binding** belongs to a native WebView. On Android the message listener has to exist
 *    before the first navigation, so the view holds its real source until {@link bindView}
 *    resolves; the reload-once path is only a counted fallback.
 *
 * Every control operation is identity-checked: background ops by `{runtimeId, handleId}`, page ops
 * by `{docGen, token, mountEpoch}`. A mismatch is dropped and counted, not treated as an error.
 *
 * Nothing here calls into the meeting beyond reading who owns it. A native failure, a throwing
 * listener or a bad page request ends in a log line and a typed status for the page — it never
 * reaches the call.
 */

/** Must match `PREVIEW_TIERS` in `@mentra/miniapp`'s stream-preview. The host is the authority. */
export const STREAM_PREVIEW_TIERS: ReadonlyArray<{width: number; height: number; maxFps: number}> = [
  {width: 320, height: 180, maxFps: 15},
  {width: 640, height: 360, maxFps: 15},
]

export const STREAM_PREVIEW_PROTOCOL_VERSION = 1
/**
 * How long a view holds its real source waiting for {@link StreamPreviewCoordinator.bindView}.
 * A miniapp must never fail to load because the preview transport is slow to install.
 */
export const STREAM_PREVIEW_BIND_TIMEOUT_MS = 2000

type Tier = (typeof STREAM_PREVIEW_TIERS)[number]

export function quantizeStreamPreviewTier(boxWidth: number, boxHeight: number): Tier | null {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return null
  for (const tier of STREAM_PREVIEW_TIERS) {
    if (tier.width >= boxWidth && tier.height >= boxHeight) return tier
  }
  return STREAM_PREVIEW_TIERS[STREAM_PREVIEW_TIERS.length - 1]!
}

export interface StreamPreviewDocumentConfig {
  protocolVersion: number
  transport: "webmessage" | "websocket"
  url?: string
  portName?: string
  token: string
  docGen: number
}

/** The native frame-preview module, as the StreamPreview contract defines it. */
export interface StreamPreviewNative {
  bind(options: {hostViewTag: number; packageName: string; traceId: string}): Promise<{
    installReloadRequired: boolean
    unavailableReason?: string
  }>
  prepareDocument(options: {docGen: number; traceId: string}): Promise<StreamPreviewDocumentConfig>
  configure(options: {
    source: "call"
    mode: "render"
    targetWidth: number
    targetHeight: number
    maxFps: number
  }): Promise<void>
  start(): Promise<void>
  stop(reason: string): Promise<void>
  unbind(reason: string): Promise<void>
  /** Diagnostics only; rejects `diagnostics_disabled` when native diagnostics are off. */
  injectFault(options: {kind: StreamPreviewFaultKind; ms?: number}): Promise<void>
  setDiagnosticsEnabled(enabled: boolean): Promise<void>
  addListener(event: "onStatus", listener: (status: Record<string, unknown>) => void): {remove(): void}
  addListener(event: "onStopped", listener: (event: {reason: string; docGen: number}) => void): {remove(): void}
  /** Native `PREVIEW_TRACE` lines; the host forwards them to the console. */
  addListener(event: "onLog", listener: (event: {level: "info" | "warn"; message: string}) => void): {remove(): void}
}

export type StreamPreviewFaultKind =
  | "ack_delay"
  | "ack_drop"
  | "transport_close"
  | "pack_throw"
  | "sink_throw"
  | "clear"

export const STREAM_PREVIEW_FAULT_KINDS: readonly StreamPreviewFaultKind[] = [
  "ack_delay",
  "ack_drop",
  "transport_close",
  "pack_throw",
  "sink_throw",
  "clear",
]

export interface StreamPreviewUiBridge {
  reply(packageName: string, requestId: string, reply: MentraUIHostReply): void
  push(packageName: string, payload: Record<string, unknown>): void
}

export interface StreamPreviewCoordinatorDeps {
  native: StreamPreviewNative
  meetings: StreamPreviewMeetingSource
  ui: StreamPreviewUiBridge
  now?: () => number
  newId?: () => string
  log?: PreviewTraceLogger
  /**
   * Whether fault injection may run: debug builds, or the hidden developer setting in release.
   * Defaults to never.
   */
  diagnosticsAllowed?: () => boolean
}

/** A typed refusal for the runtime; `code` is a preview error code. */
export class StreamPreviewRefusal extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "StreamPreviewError"
    this.code = code
  }
}

interface Lease {
  packageName: string
  runtimeId: string
  handleId: string
  previewTraceId: string
  meetingId: string
  state: "arming" | "held"
  notify: (event: StreamPreviewStatusEvent) => void
}

interface ViewBinding {
  packageName: string
  hostViewTag: number
  bound: boolean
  unavailableReason?: string
  binding: Promise<unknown> | null
}

interface DocumentState {
  packageName: string
  docGen: number
  config: StreamPreviewDocumentConfig | null
  preparing: Promise<StreamPreviewDocumentConfig | null> | null
  mountEpoch: number
  wantRunning: boolean
  tier: Tier | null
  /** Production was halted by a non-recoverable error for this epoch; a newer mount may retry. */
  haltedEpoch: number
  waitingForLease: boolean
  /** Native rejection code from the last failed `prepareDocument`, e.g. `not_bound`. */
  prepareError: string | null
}

interface PageRequest {
  cmd?: unknown
  docGen?: unknown
  token?: unknown
  mountEpoch?: unknown
  boxWidth?: unknown
  boxHeight?: unknown
  message?: unknown
  kind?: unknown
  ms?: unknown
}

export interface StreamPreviewCounters {
  staleControlOps: number
  installReloads: number
  handshakes: number
  tierChanges: number
  pausedBackgroundMs: number
  refusals: number
  faultsInjected: number
  /** Native production stops, by reason. */
  nativeStops: Record<string, number>
}

const STOP_CODES = new Set(["ack_timeout", "pack_failed", "transport_failed", "diagnostics_disabled"])
/** Stops a new start would only repeat; the mount epoch is halted until a newer mount. */
const HALTING_CODES = new Set(["pack_failed", "diagnostics_disabled"])
/** `onStopped` reasons native originates; anything else is the echo of a host stop/unbind. */
const NATIVE_STOP_REASONS = new Set([...STOP_CODES, "source_detached", "unbound"])

function defaultNewId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export class StreamPreviewCoordinator implements StreamPreviewHostPort {
  private lease: Lease | null = null
  private view: ViewBinding | null = null
  private doc: DocumentState | null = null
  private docGenCounter = 0
  private producing = false
  /** What native was last configured with while producing; cleared whenever production stops. */
  private configuredTier: Tier | null = null
  private lastTier: Tier | null = null
  private appActive = true
  private pausedAt: number | null = null
  private nativeChain: Promise<void> = Promise.resolve()
  private readonly counters: StreamPreviewCounters = {
    staleControlOps: 0,
    installReloads: 0,
    handshakes: 0,
    tierChanges: 0,
    pausedBackgroundMs: 0,
    refusals: 0,
    faultsInjected: 0,
    nativeStops: {},
  }
  private readonly now: () => number
  private readonly newId: () => string
  private readonly log: PreviewTraceLogger
  private readonly subscriptions: Array<{remove(): void}> = []
  /** Handshakes that arrived before their WebView was bound. */
  private readonly viewWaiters = new Set<() => void>()
  private readonly unsubscribeMeeting: () => void

  constructor(private readonly deps: StreamPreviewCoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? defaultNewId
    this.log = deps.log ?? createPreviewTraceLogger()
    this.unsubscribeMeeting = deps.meetings.onReleased((instanceId) =>
      this.guard("meeting_released", () => this.onMeetingReleased(instanceId)),
    )
    try {
      this.subscriptions.push(
        deps.native.addListener("onStatus", (status) => this.guard("status", () => this.onNativeStatus(status))),
      )
      this.subscriptions.push(
        deps.native.addListener("onStopped", (event) => this.guard("stopped", () => this.onNativeStopped(event))),
      )
      this.subscriptions.push(
        deps.native.addListener("onLog", (event) =>
          this.guard("native_log", () => this.log.forward(event.level, event.message)),
        ),
      )
    } catch (error) {
      this.log.warn("native_events_unavailable", {error: String(error)})
    }
  }

  /** Snapshot for diagnostics and tests. */
  getCounters(): StreamPreviewCounters {
    return {...this.counters, nativeStops: {...this.counters.nativeStops}}
  }

  // ===========================================================================
  // Diagnostics
  // ===========================================================================

  /**
   * Arm a native fault hook. Only in debug builds or with the hidden developer setting; anything
   * else is refused with `diagnostics_disabled` before native is asked.
   */
  async injectFault(options: {kind: string; ms?: number}): Promise<void> {
    const fields = {...this.currentFields(), kind: options.kind, ms: options.ms}
    if (!(STREAM_PREVIEW_FAULT_KINDS as readonly string[]).includes(options.kind)) {
      throw this.refuse("unsupported", `Unknown preview fault ${options.kind}`, fields)
    }
    if (!(this.deps.diagnosticsAllowed?.() ?? false)) {
      throw this.refuse("diagnostics_disabled", "Preview fault injection needs diagnostics", fields)
    }
    try {
      await this.deps.native.setDiagnosticsEnabled(true)
      await this.deps.native.injectFault({
        kind: options.kind as StreamPreviewFaultKind,
        ...(options.ms !== undefined ? {ms: options.ms} : {}),
      })
    } catch (error) {
      const code = (error as {code?: unknown}).code
      throw this.refuse(
        code === "diagnostics_disabled" ? "diagnostics_disabled" : "unsupported",
        error instanceof Error ? error.message : String(error),
        fields,
      )
    }
    this.counters.faultsInjected += 1
    this.log.warn("fault_injected", {...fields, faultsInjected: this.counters.faultsInjected})
  }

  getLeaseSnapshot(): {packageName: string; handleId: string; meetingId: string; state: string} | null {
    const lease = this.lease
    return lease
      ? {packageName: lease.packageName, handleId: lease.handleId, meetingId: lease.meetingId, state: lease.state}
      : null
  }

  isProducing(): boolean {
    return this.producing
  }

  dispose(): void {
    this.unsubscribeMeeting()
    for (const subscription of this.subscriptions.splice(0)) subscription.remove()
  }

  // ===========================================================================
  // Background: the lease
  // ===========================================================================

  async start(
    request: StreamPreviewStartRequest,
    notify: (event: StreamPreviewStatusEvent) => void,
  ): Promise<StreamPreviewStartResult> {
    const ids = {runtimeId: request.runtimeId, packageName: request.packageName}
    if (request.source !== "call") {
      throw this.refuse("unsupported", `Preview source "${String(request.source)}" is not supported`, ids)
    }
    if (!request.hasCamera) {
      throw this.refuse("permission_denied", "Declare the CAMERA permission to preview the call", ids)
    }
    const meeting = this.deps.meetings.current()
    if (!meeting || meeting.ownerPackage !== request.packageName) {
      throw this.refuse("not_meeting_owner", "Only the miniapp that owns the active meeting may preview it", {
        ...ids,
        meetingId: meeting?.instanceId,
      })
    }
    if (this.lease && this.lease.meetingId !== meeting.instanceId) {
      // The meeting it was bound to is gone; the release event just has not arrived yet.
      this.endLease("source_ended")
    }
    if (this.lease) {
      throw this.refuse("preview_busy", "Another preview already holds the source", {
        ...ids,
        holder: this.lease.packageName,
        meetingId: meeting.instanceId,
      })
    }

    const lease: Lease = {
      packageName: request.packageName,
      runtimeId: request.runtimeId,
      handleId: this.newId(),
      previewTraceId: this.newId(),
      meetingId: meeting.instanceId,
      state: "arming",
      notify,
    }
    this.lease = lease
    this.log.info("lease_arming", this.leaseFields(lease))
    // Arming waits out whatever the previous lease left in flight natively, and is tied to the
    // meeting instance: if that meeting ends meanwhile, this preview() rejects.
    await this.nativeChain
    const current = this.deps.meetings.current()
    if (this.lease !== lease || !current || current.instanceId !== lease.meetingId) {
      if (this.lease === lease) this.lease = null
      throw this.refuse("source_ended", "The meeting ended before the preview was ready", this.leaseFields(lease))
    }
    lease.state = "held"
    this.log.info("lease_held", this.leaseFields(lease))
    const doc = this.doc
    if (doc && doc.packageName === lease.packageName && doc.waitingForLease) {
      doc.waitingForLease = false
      this.log.info("lease_available_pushed", {...this.leaseFields(lease), docGen: doc.docGen})
      this.push(doc.packageName, {t: "lease_available"})
    }
    // After the reply, so the background already has the handle when the status arrives.
    void Promise.resolve().then(() => {
      if (this.lease === lease) this.notifySafe(lease, {handleId: lease.handleId, state: "held"})
    })
    return {handleId: lease.handleId, previewTraceId: lease.previewTraceId, source: "call"}
  }

  async stop(request: {packageName: string; runtimeId: string; handleId: string}): Promise<void> {
    const lease = this.lease
    const mismatch = !lease
      ? "lease"
      : lease.packageName !== request.packageName
      ? "packageName"
      : lease.runtimeId !== request.runtimeId
      ? "runtimeId"
      : lease.handleId !== request.handleId
      ? "handleId"
      : null
    if (mismatch) {
      this.stale("stop", mismatch, {runtimeId: request.runtimeId, handleId: request.handleId})
      return
    }
    this.endLease("stopped")
  }

  releaseRuntime(packageName: string, runtimeId: string, reason: string): void {
    this.guard("release_runtime", () => {
      const lease = this.lease
      if (!lease || lease.packageName !== packageName || lease.runtimeId !== runtimeId) return
      this.endLease(reason)
    })
  }

  // ===========================================================================
  // WebView binding and documents
  // ===========================================================================

  /**
   * Install the native transport on the WebView under `hostViewTag`. On Android the caller holds
   * the WebView's real source until this resolves, so the listener exists before the first
   * navigation. Resolves `installReloadRequired` only for the fallback where it did not.
   */
  async bindView(options: {
    packageName: string
    hostViewTag: number
  }): Promise<{installReloadRequired: boolean; available: boolean}> {
    const view: ViewBinding = {
      packageName: options.packageName,
      hostViewTag: options.hostViewTag,
      bound: false,
      binding: null,
    }
    this.view = view
    for (const wake of [...this.viewWaiters]) wake()
    const binding = this.deps.native
      .bind({
        hostViewTag: options.hostViewTag,
        packageName: options.packageName,
        traceId: this.lease?.previewTraceId ?? "",
      })
      .catch((error: unknown) => ({
        installReloadRequired: false,
        unavailableReason: error instanceof Error ? error.message : String(error),
      }))
    view.binding = binding
    const result = await binding
    view.binding = null
    if (this.view !== view) return {installReloadRequired: false, available: false}
    if (result.unavailableReason) {
      view.unavailableReason = result.unavailableReason
      this.log.warn("bind_unavailable", {packageName: view.packageName, reason: view.unavailableReason})
      return {installReloadRequired: false, available: false}
    }
    view.bound = true
    this.log.info("bound", {packageName: view.packageName, installReloadRequired: result.installReloadRequired})
    return {installReloadRequired: result.installReloadRequired, available: true}
  }

  /**
   * The view reloaded once because the listener arrived after its document started loading. This
   * is the fallback path; with the source held until {@link bindView} resolves it stays at zero.
   */
  noteInstallReload(packageName: string): void {
    this.counters.installReloads += 1
    this.log.warn("install_reload", {
      packageName,
      installReloads: this.counters.installReloads,
      docGen: this.doc?.docGen,
    })
  }

  /** The WebView is gone. The lease survives; the next WebView binds and handshakes again. */
  viewDestroyed(packageName: string, reason: string): void {
    this.guard("view_destroyed", () => {
      if (this.view?.packageName !== packageName) return
      this.log.info("view_destroyed", {packageName, reason, docGen: this.doc?.docGen})
      this.view = null
      if (this.doc?.packageName === packageName) this.doc = null
      this.reconcile(reason)
      this.enqueueNative("unbind", () => this.deps.native.unbind(reason))
    })
  }

  /** The page's shim said `ready`: a new document exists. */
  documentReady(packageName: string): void {
    this.guard("document_ready", () => this.beginDocument(packageName, "ready"))
  }

  /** The page's document died without a `ready` for its successor (content-process exit). */
  documentEnded(packageName: string, reason: string): void {
    this.guard("document_ended", () => {
      if (this.doc?.packageName !== packageName && this.view?.packageName !== packageName) return
      this.beginDocument(packageName, reason)
    })
  }

  private beginDocument(packageName: string, trigger: string): DocumentState {
    this.docGenCounter += 1
    const previous = this.doc
    const doc: DocumentState = {
      packageName,
      docGen: this.docGenCounter,
      config: null,
      preparing: null,
      mountEpoch: 0,
      wantRunning: false,
      tier: null,
      haltedEpoch: -1,
      waitingForLease: false,
      prepareError: null,
    }
    this.doc = doc
    this.log.info("doc_gen", {packageName, docGen: doc.docGen, previousDocGen: previous?.docGen, trigger})
    this.reconcile("new_document")
    return doc
  }

  // ===========================================================================
  // Page: the `_preview` channel
  // ===========================================================================

  handleUiRequest(packageName: string, requestId: string | undefined, payload: unknown): void {
    void this.dispatchUiRequest(packageName, requestId, (payload ?? {}) as PageRequest).catch((error: unknown) => {
      this.log.warn("ui_request_failed", {packageName, error: error instanceof Error ? error.message : String(error)})
      if (requestId)
        this.reply(packageName, requestId, {ok: false, error: {code: "unsupported", message: "Preview request failed"}})
    })
  }

  private async dispatchUiRequest(
    packageName: string,
    requestId: string | undefined,
    request: PageRequest,
  ): Promise<void> {
    const cmd = typeof request.cmd === "string" ? request.cmd : ""
    const respond = (reply: MentraUIHostReply) => {
      if (requestId) this.reply(packageName, requestId, reply)
    }
    if (cmd === "handshake") {
      respond(await this.handshake(packageName, request))
      return
    }
    const doc = this.doc
    if (!doc || doc.packageName !== packageName) {
      respond(this.staleReply(cmd, "docGen", {packageName}))
      return
    }
    const mismatch = this.checkPageIdentity(doc, cmd, request)
    if (mismatch) {
      respond(this.staleReply(cmd, mismatch, {packageName, docGen: doc.docGen, mountEpoch: num(request.mountEpoch)}))
      return
    }
    const mountEpoch = num(request.mountEpoch)!
    switch (cmd) {
      case "configure": {
        doc.mountEpoch = mountEpoch
        const tier = quantizeStreamPreviewTier(num(request.boxWidth) ?? 0, num(request.boxHeight) ?? 0)
        if (tier?.width !== doc.tier?.width || tier?.height !== doc.tier?.height) {
          doc.tier = tier
          this.log.info("tier", {...this.docFields(doc), width: tier?.width ?? 0, height: tier?.height ?? 0})
        }
        this.reconcile(tier ? "configure" : "hidden")
        respond({ok: true, result: {applied: true}})
        return
      }
      case "start":
        doc.mountEpoch = mountEpoch
        doc.wantRunning = true
        this.log.info("page_start", this.docFields(doc))
        this.reconcile("page_start")
        respond({ok: true, result: {applied: true}})
        return
      case "stop":
        doc.wantRunning = false
        this.log.info("page_stop", this.docFields(doc))
        this.reconcile("page_stop")
        respond({ok: true, result: {applied: true}})
        return
      case "injectFault":
        try {
          await this.injectFault({kind: String(request.kind), ms: num(request.ms)})
          respond({ok: true, result: {applied: true}})
        } catch (error) {
          respond({
            ok: false,
            error: {
              code: (error as {code?: string}).code ?? "unsupported",
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
        return
      case "rendererError":
        this.log.warnLimited(`renderer:${String(request.message)}`, "renderer_error", {
          ...this.docFields(doc),
          message: typeof request.message === "string" ? request.message.slice(0, 120) : "unknown",
        })
        respond({ok: true, result: {applied: true}})
        return
      default:
        respond({ok: false, error: {code: "unsupported", message: `Unknown preview command ${cmd}`}})
    }
  }

  private checkPageIdentity(doc: DocumentState, cmd: string, request: PageRequest): string | null {
    if (num(request.docGen) !== doc.docGen) return "docGen"
    if (!doc.config || request.token !== doc.config.token) return "token"
    const mountEpoch = num(request.mountEpoch)
    if (mountEpoch === undefined) return "mountEpoch"
    // A newer mount may configure or start; only the current mount may stop or report.
    if (cmd === "configure" || cmd === "start") return mountEpoch < doc.mountEpoch ? "mountEpoch" : null
    return mountEpoch !== doc.mountEpoch ? "mountEpoch" : null
  }

  private async handshake(packageName: string, request: PageRequest): Promise<MentraUIHostReply> {
    const deadline = Date.now() + STREAM_PREVIEW_BIND_TIMEOUT_MS
    let view = await this.waitForView(packageName)
    let waitedForBind = false
    // Android's first bind often returns no_webview, and LocalMiniappView retries.
    // The page's handshake is already in flight by then. Answering `unsupported`
    // for that miss is permanent: the page never asks again.
    while (view && !view.bound && Date.now() < deadline) {
      const pending = view.binding
      if (pending) await pending
      if (this.view !== view) {
        view = this.view?.packageName === packageName ? this.view : null
        continue
      }
      if (view.bound) break
      if (view.unavailableReason && view.unavailableReason !== "no_webview") break
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      waitedForBind = true
      this.log.info("handshake_waiting_for_bind", {
        packageName,
        reason: view.unavailableReason ?? "pending",
      })
      const next = await this.waitForDifferentView(view, remaining)
      view = next?.packageName === packageName ? next : null
    }
    if (waitedForBind && view?.bound) {
      this.log.info("handshake_bind_recovered", {packageName, reason: "no_webview"})
    } else if (waitedForBind) {
      this.log.warn("handshake_bind_gave_up", {
        packageName,
        reason: view?.unavailableReason ?? "not_bound",
      })
    }
    if (!view) {
      return this.refusePage(packageName, "unsupported", "This WebView has no preview binding")
    }
    if (this.view !== view || !view.bound) {
      return this.refusePage(
        packageName,
        "unsupported",
        `Preview transport unavailable (${view.unavailableReason ?? "not_bound"})`,
      )
    }
    let doc = this.doc
    if (!doc || doc.packageName !== packageName) doc = this.beginDocument(packageName, "handshake_without_ready")
    const claimed = num(request.docGen)
    if (claimed && claimed !== doc.docGen)
      return this.staleReply("handshake", "docGen", {packageName, docGen: doc.docGen})
    this.checkLeaseMeeting()
    const lease = this.lease
    if (!lease || lease.packageName !== packageName || lease.state !== "held") {
      doc.waitingForLease = true
      this.log.info("handshake_waiting_for_lease", {packageName, docGen: doc.docGen})
      return {ok: true, result: {t: "waiting_for_lease", docGen: doc.docGen}}
    }
    const config = await this.prepare(doc, lease)
    if (this.doc !== doc) return this.staleReply("handshake", "docGen", {packageName})
    if (!config) {
      if (doc.prepareError === "not_bound") {
        // Native lost (or never had) the WebView binding; only a new view binding fixes that.
        view.bound = false
        view.unavailableReason = "not_bound"
        return this.refusePage(packageName, "unsupported", "The preview transport is not bound to this WebView")
      }
      return this.refusePage(packageName, "transport_failed", "The preview transport could not be prepared")
    }
    if (config.protocolVersion !== STREAM_PREVIEW_PROTOCOL_VERSION) {
      return this.refusePage(packageName, "unsupported", `Unknown preview protocol version ${config.protocolVersion}`)
    }
    this.counters.handshakes += 1
    this.log.info("handshake_ok", {
      ...this.leaseFields(lease),
      docGen: doc.docGen,
      transport: config.transport,
      handshakes: this.counters.handshakes,
    })
    return {
      ok: true,
      result: {
        t: "config",
        protocolVersion: config.protocolVersion,
        transport: config.transport,
        ...(config.url ? {url: config.url} : {}),
        ...(config.portName ? {portName: config.portName} : {}),
        token: config.token,
        docGen: doc.docGen,
      },
    }
  }

  /** A page can ask before its view is bound (nothing holds an iOS WebView's source). */
  private async waitForView(packageName: string): Promise<ViewBinding | null> {
    if (this.view?.packageName !== packageName) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          this.viewWaiters.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, STREAM_PREVIEW_BIND_TIMEOUT_MS)
        this.viewWaiters.add(wake)
      })
    }
    return this.view?.packageName === packageName ? this.view : null
  }

  /** Resolves when `bindView` replaces `current`, or when `timeoutMs` elapses. */
  private waitForDifferentView(current: ViewBinding, timeoutMs: number): Promise<ViewBinding | null> {
    if (this.view && this.view !== current) return Promise.resolve(this.view)
    return new Promise((resolve) => {
      const finish = (view: ViewBinding | null) => {
        clearTimeout(timer)
        this.viewWaiters.delete(wake)
        resolve(view)
      }
      const wake = () => finish(this.view && this.view !== current ? this.view : null)
      const timer = setTimeout(() => finish(null), timeoutMs)
      this.viewWaiters.add(wake)
    })
  }

  /** One credential per document and lease; a page that asks twice gets the same answer. */
  private prepare(doc: DocumentState, lease: Lease): Promise<StreamPreviewDocumentConfig | null> {
    if (doc.config) return Promise.resolve(doc.config)
    if (!doc.preparing) {
      doc.preparing = this.deps.native
        .prepareDocument({docGen: doc.docGen, traceId: lease.previewTraceId})
        .then((config) => {
          if (this.doc !== doc || doc.preparing === null) return null
          doc.config = config
          return config
        })
        .catch((error: unknown) => {
          const code = (error as {code?: unknown}).code
          doc.prepareError = typeof code === "string" ? code : "prepare_failed"
          this.log.warn("prepare_failed", {
            ...this.leaseFields(lease),
            docGen: doc.docGen,
            code: doc.prepareError,
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        })
        .finally(() => {
          doc.preparing = null
        })
    }
    return doc.preparing
  }

  // ===========================================================================
  // App lifecycle
  // ===========================================================================

  /** Host visibility is the authority: an Android WebView can report itself visible while hidden. */
  setAppActive(active: boolean): void {
    this.guard("app_state", () => {
      if (active === this.appActive) return
      this.appActive = active
      const doc = this.doc
      if (!active) {
        const wasProducing = this.producing
        this.pausedAt = this.now()
        this.reconcile("paused_background")
        if (wasProducing && doc) {
          this.log.info("paused_background", this.docFields(doc))
          this.push(doc.packageName, {t: "paused_background"})
        }
        return
      }
      const pausedAt = this.pausedAt
      this.pausedAt = null
      if (pausedAt !== null) this.counters.pausedBackgroundMs += Math.max(0, this.now() - pausedAt)
      if (doc) {
        this.log.info("resumed", {...this.docFields(doc), pausedBackgroundMs: this.counters.pausedBackgroundMs})
        this.push(doc.packageName, {t: "resumed"})
      }
      this.reconcile("resumed")
    })
  }

  // ===========================================================================
  // Production
  // ===========================================================================

  private shouldProduce(): boolean {
    const lease = this.lease
    const doc = this.doc
    return (
      !!lease &&
      lease.state === "held" &&
      !!doc &&
      doc.packageName === lease.packageName &&
      !!doc.config &&
      doc.wantRunning &&
      !!doc.tier &&
      doc.haltedEpoch !== doc.mountEpoch &&
      this.appActive &&
      !!this.view?.bound
    )
  }

  private reconcile(reason: string): void {
    const want = this.shouldProduce()
    const tier = this.doc?.tier ?? null
    if (want && tier && (tier.width !== this.configuredTier?.width || tier.height !== this.configuredTier?.height)) {
      this.configuredTier = tier
      if (tier.width !== this.lastTier?.width || tier.height !== this.lastTier?.height) this.counters.tierChanges += 1
      this.lastTier = tier
      this.enqueueNative("configure", () =>
        this.deps.native.configure({
          source: "call",
          mode: "render",
          targetWidth: tier.width,
          targetHeight: tier.height,
          maxFps: tier.maxFps,
        }),
      )
    }
    if (want && !this.producing) {
      this.producing = true
      this.log.info("production_start", {...this.currentFields(), reason})
      this.enqueueNative("start", () => this.deps.native.start())
    } else if (!want && this.producing) {
      this.producing = false
      this.configuredTier = null
      this.log.info("production_stop", {...this.currentFields(), reason})
      this.enqueueNative("stop", () => this.deps.native.stop(reason))
    }
  }

  private enqueueNative(op: string, work: () => Promise<void>): void {
    this.nativeChain = this.nativeChain.then(async () => {
      try {
        await work()
      } catch (error) {
        const code = (error as {code?: unknown}).code
        this.log.warnLimited(`native:${op}`, "native_failed", {
          ...this.currentFields(),
          op,
          code: typeof code === "string" ? code : undefined,
          error: error instanceof Error ? error.message : String(error),
        })
        if (op === "start" || op === "configure") {
          this.producing = false
          this.configuredTier = null
          const doc = this.doc
          if (doc) {
            doc.haltedEpoch = doc.mountEpoch
            this.push(doc.packageName, {
              t: "error",
              code: code === "diagnostics_disabled" ? "diagnostics_disabled" : "pack_failed",
              docGen: doc.docGen,
            })
          }
        }
      }
    })
  }

  private onNativeStatus(status: Record<string, unknown>): void {
    const doc = this.doc
    const lease = this.lease
    if (!doc || !lease || doc.packageName !== lease.packageName) return
    // Native fields (acsSendFps, tap telemetry, ...) pass through untouched; the host's own
    // counters ride beside them rather than over same-named native ones.
    this.push(doc.packageName, {...status, t: "status", host: this.getCounters()})
  }

  private onNativeStopped(event: {reason: string; docGen: number}): void {
    const doc = this.doc
    if (!doc || event.docGen !== doc.docGen) {
      this.log.info("stopped_stale", {reason: event.reason, eventDocGen: event.docGen, docGen: doc?.docGen})
      return
    }
    if (!NATIVE_STOP_REASONS.has(event.reason)) {
      // Native echoes the reason of a stop or unbind the host asked for. It can arrive after a
      // later start, so it must not change the production state.
      this.log.info("native_stop_echo", {reason: event.reason, docGen: doc.docGen})
      return
    }
    this.producing = false
    this.configuredTier = null
    this.counters.nativeStops[event.reason] = (this.counters.nativeStops[event.reason] ?? 0) + 1
    this.log.warnLimited(`stopped:${event.reason}`, "native_stopped", {
      ...this.currentFields(),
      reason: event.reason,
      count: this.counters.nativeStops[event.reason],
    })
    if (event.reason === "source_detached") {
      this.checkLeaseMeeting()
      if (this.lease) this.push(doc.packageName, {t: "error", code: "transport_failed", docGen: doc.docGen})
      return
    }
    if (STOP_CODES.has(event.reason)) {
      if (HALTING_CODES.has(event.reason)) doc.haltedEpoch = doc.mountEpoch
      this.push(doc.packageName, {t: "error", code: event.reason, docGen: doc.docGen})
      return
    }
    if (event.reason === "unbound" && this.view) this.view.bound = false
  }

  // ===========================================================================
  // Lease end
  // ===========================================================================

  private onMeetingReleased(instanceId: string): void {
    if (this.lease?.meetingId === instanceId) this.endLease("source_ended")
  }

  private checkLeaseMeeting(): void {
    const lease = this.lease
    if (!lease) return
    const meeting = this.deps.meetings.current()
    if (!meeting || meeting.instanceId !== lease.meetingId) this.endLease("source_ended")
  }

  private endLease(reason: string): void {
    const lease = this.lease
    if (!lease) return
    this.lease = null
    this.log.info("lease_ended", {...this.leaseFields(lease), reason, docGen: this.doc?.docGen})
    const doc = this.doc
    if (doc && doc.packageName === lease.packageName) {
      doc.config = null
      doc.preparing = null
      doc.waitingForLease = true
      this.push(doc.packageName, {t: "lease_ended", reason})
    }
    this.reconcile(reason)
    this.notifySafe(lease, {handleId: lease.handleId, state: "ended", reason})
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private notifySafe(lease: Lease, event: StreamPreviewStatusEvent): void {
    try {
      lease.notify(event)
    } catch (error) {
      this.log.warn("notify_failed", {...this.leaseFields(lease), error: String(error)})
    }
  }

  private refuse(code: string, message: string, fields: PreviewTraceFields): StreamPreviewRefusal {
    this.counters.refusals += 1
    this.log.warn("refused", {...fields, code})
    return new StreamPreviewRefusal(code, message)
  }

  private refusePage(packageName: string, code: string, message: string): MentraUIHostReply {
    this.log.warn("handshake_refused", {packageName, code, docGen: this.doc?.docGen})
    return {ok: false, error: {code, message}}
  }

  private stale(cmd: string, field: string, fields: PreviewTraceFields): void {
    this.counters.staleControlOps += 1
    this.log.info("stale_control_op", {...fields, cmd, field, staleControlOps: this.counters.staleControlOps})
  }

  private staleReply(cmd: string, field: string, fields: PreviewTraceFields): MentraUIHostReply {
    this.stale(cmd, field, fields)
    return {ok: true, result: {stale: true}}
  }

  private reply(packageName: string, requestId: string, reply: MentraUIHostReply): void {
    try {
      this.deps.ui.reply(packageName, requestId, reply)
    } catch (error) {
      this.log.warnLimited("ui_reply", "ui_reply_failed", {packageName, error: String(error)})
    }
  }

  private push(packageName: string, payload: Record<string, unknown>): void {
    try {
      this.deps.ui.push(packageName, payload)
    } catch (error) {
      this.log.warnLimited("ui_push", "ui_push_failed", {packageName, error: String(error)})
    }
  }

  /** Run a callback from outside (native events, lifecycle) so a bug here stays here. */
  private guard(what: string, work: () => void): void {
    try {
      work()
    } catch (error) {
      this.log.warn("coordinator_error", {what, error: error instanceof Error ? error.message : String(error)})
    }
  }

  private leaseFields(lease: Lease): PreviewTraceFields {
    return {
      previewTraceId: lease.previewTraceId,
      runtimeId: lease.runtimeId,
      handleId: lease.handleId,
      meetingId: lease.meetingId,
      packageName: lease.packageName,
    }
  }

  private docFields(doc: DocumentState): PreviewTraceFields {
    return {
      ...(this.lease ? this.leaseFields(this.lease) : {packageName: doc.packageName}),
      docGen: doc.docGen,
      mountEpoch: doc.mountEpoch,
    }
  }

  private currentFields(): PreviewTraceFields {
    if (this.doc) return this.docFields(this.doc)
    return this.lease ? this.leaseFields(this.lease) : {}
  }
}
