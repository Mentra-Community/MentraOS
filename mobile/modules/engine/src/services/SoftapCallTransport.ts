/**
 * @fileoverview Sequences a SoftAP call. Sequencing only — no sockets, no peers, no BLE.
 *
 * The glasses open a hotspot, the phone joins it without giving up its cellular route, and the
 * glasses publish WebRTC straight to a listener on the phone. Cloudflare is not involved at all.
 *
 * The order below is the whole point of this file, and one step in it is load-bearing:
 *
 *   hotspot on -> scoped join -> ACS join (binds the listener and arms the raw outputs)
 *     -> glasses publish -> WHIP negotiation -> first frame -> LIVE
 *
 * Publishing must come after the ACS join, not before. `LIVE` means a frame reached ACS, so if the
 * glasses start publishing first, decoded video and audio can arrive before the raw outgoing
 * streams exist and the first frames are dropped by whatever happens to be null at the time. That
 * is not a lifecycle anyone designed; making the order explicit is what removes it.
 *
 * Ownership is deliberately narrow. This object owns the *sequence* and nothing else: the meeting
 * session owns the WHIP listener and the peer, `PhoneStreamCoordinator` owns the publisher, and
 * `localNetworkTransport` owns the scoped network. Every step therefore has exactly one owner that
 * can tear it down, which is what makes leaving mid-join safe.
 */

import {softapTrace, softapTraceFailure, beginSoftapTrace, resetSoftapTrace} from "../utils/softapTrace"

/** Steps in order. Also the teardown order, reversed. */
export const SOFTAP_STEPS = ["hotspot", "scopedJoin", "acsJoin", "publish", "live"] as const

export type SoftapStep = (typeof SOFTAP_STEPS)[number]

/**
 * Where the sequence is.
 *
 * `starting` covers every step up to `live` because the caller's only useful distinction is
 * "not yet usable" versus "carrying media"; the step names are for diagnostics, not for branching.
 */
export type SoftapPhase = "idle" | "starting" | "live" | "stopping" | "failed"

/** A failure, named by the step that produced it so the UI and the logs agree on the cause. */
export class SoftapCallError extends Error {
  constructor(
    readonly step: SoftapStep,
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "SoftapCallError"
  }
}

/** Gallery sync already learned this: glasses report enabled before the SSID is in the phone scan. */
export const HOTSPOT_BROADCAST_WAIT_MS = 3_000

export type SoftapStepStatus = "pending" | "running" | "done" | "failed"

/**
 * One step as the UI should show it. `detail` is the fact the step produced (SSID, phone address,
 * ingest URL, what the glasses last reported); `error` is set only on `failed`.
 */
export interface SoftapStepState {
  step: SoftapStep
  status: SoftapStepStatus
  detail?: string
  error?: string
  /** Wall-clock ms the step took; present once it is done or failed. */
  durationMs?: number
}

/**
 * Whole-sequence snapshot, re-sent on every transition so a consumer that missed one still holds
 * the truth. This is what the miniapp renders as its join checklist.
 */
export interface SoftapProgress {
  traceId: string
  phase: SoftapPhase
  steps: SoftapStepState[]
  /** ms since `start()` was called. */
  elapsedMs: number
}

/** Sub-status callback a step can use to narrate what it is doing while it runs. */
export type SoftapStepReporter = (detail: string) => void

export interface SoftapCallDeps {
  /** Enable the glasses hotspot and return its credentials. */
  startHotspot(report?: SoftapStepReporter): Promise<{ssid: string; passphrase: string}>
  /**
   * Wait until the phone can actually see the AP. `setHotspotState` resolves when the glasses
   * accept the command, not when `ap0` is beaconing. A WifiNetworkSpecifier issued too early
   * comes back `Unavailable` in well under a second — it does not keep scanning for the timeout.
   */
  waitUntilHotspotJoinable?(report?: SoftapStepReporter): Promise<void>
  /** Disable it. Must tolerate being called when it was never enabled. */
  stopHotspot(): Promise<void>
  /** Join the hotspot without taking the phone's default route. Resolves to the phone's own IPv4. */
  joinScopedNetwork(ssid: string, passphrase: string, report?: SoftapStepReporter): Promise<string | undefined>
  leaveScopedNetwork(): Promise<void>
  /**
   * Join the meeting. This is what binds the local WHIP listener and arms the ACS raw outputs, so
   * it must resolve before the glasses are told to publish.
   *
   * @returns the URL the glasses must POST their offer to
   */
  joinMeeting(
    args: {ssid: string; passphrase: string; bindAddress?: string},
    report?: SoftapStepReporter,
  ): Promise<{ingestUrl: string}>
  leaveMeeting(): Promise<void>
  /**
   * End the meeting for everyone instead of leaving it. Optional: a host that cannot do this still
   * tears down correctly, it just cannot honour `stop({mode: "end"})`.
   */
  endMeeting?(): Promise<void>
  /** Tell the glasses to publish to [ingestUrl] in host-only ICE mode. */
  startPublishing(args: {ingestUrl: string; traceId: string}, report?: SoftapStepReporter): Promise<void>
  stopPublishing(): Promise<void>
  /**
   * Resolves when a frame has reached ACS, rejects if the feed failed or the deadline passed.
   * Separate from [joinMeeting] because an answered negotiation is not a working call: a session
   * that never delivers a frame reads as healthy behind a frozen tile.
   */
  awaitFirstFrame(report?: SoftapStepReporter): Promise<void>
}

export interface SoftapCallOptions {
  /** Override the minted trace id, so a caller can correlate with logs it already started. */
  traceId?: string
  /**
   * Receives a fresh snapshot on every transition: step begins, step narrates, step ends, sequence
   * ends. Exceptions thrown here are swallowed — a broken listener must not fail the call.
   */
  onProgress?: (progress: SoftapProgress) => void
}

function freshSteps(): SoftapStepState[] {
  return SOFTAP_STEPS.map((step) => ({step, status: "pending"}))
}

/**
 * How a call is being taken down.
 *
 * `leave` takes this device out; `end` terminates the group call for everyone first. Everything
 * after that step is identical, which is the point: End is not a second teardown path, it is one
 * different verb at one step of the same one.
 */
export type SoftapTeardownMode = "leave" | "end"

export interface SoftapStopOptions {
  mode?: SoftapTeardownMode
  keepProgress?: boolean
}

export class SoftapEndNotSupportedError extends Error {
  constructor() {
    super("This host cannot end a meeting for everyone")
    this.name = "SoftapEndNotSupportedError"
  }
}

export class SoftapCallTransport {
  private phase: SoftapPhase = "idle"
  /**
   * Steps completed and not yet undone, in the order they succeeded. Teardown walks this
   * backwards, so a failure halfway through unwinds exactly what was built and nothing else.
   */
  private completed: SoftapStep[] = []
  /**
   * Bumped by every start and stop. A step that resolves after the caller has moved on must not
   * write to the new attempt's state, which is the leave-during-join race.
   */
  private generation = 0
  private stopping: Promise<void> | null = null
  /**
   * Raised the instant a teardown is decided, before any resource is touched.
   *
   * Everything that watches the call for failure — a lost hotspot above all — has to be able to ask
   * "was this supposed to happen?". Without the flag, releasing the scoped network during a
   * successful Leave looks exactly like the glasses walking out of range, and the wearer gets an
   * error screen for a call that ended the way they asked.
   */
  private terminating = false
  /** How this teardown ends the meeting. Read by the `acsJoin` undo. */
  private teardownMode: SoftapTeardownMode = "leave"
  /** Set when `stop({mode: "end"})` could not end for everyone. The caller must not claim it did. */
  private endFailure: unknown = null
  private hotspot: {ssid: string; passphrase: string} | null = null
  private ingestUrl: string | null = null
  private steps: SoftapStepState[] = freshSteps()
  private stepStartedAt = new Map<SoftapStep, number>()
  private startedAt = 0
  private traceId = ""
  private onProgress: ((progress: SoftapProgress) => void) | undefined

  constructor(private readonly deps: SoftapCallDeps) {}

  currentPhase(): SoftapPhase {
    return this.phase
  }

  /**
   * True once a teardown has been decided. Anything that would otherwise report a failure — a lost
   * hotspot, a dropped ACS call — must check this first: after the wearer asks to leave, those are
   * the sound of it working.
   */
  isTerminating(): boolean {
    return this.terminating
  }

  /** What the UI should show right now. Safe to call in any phase. */
  progress(): SoftapProgress {
    return {
      traceId: this.traceId,
      phase: this.phase,
      steps: this.steps.map((step) => ({...step})),
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
    }
  }

  private emitProgress(): void {
    const listener = this.onProgress
    if (!listener) return
    try {
      listener(this.progress())
    } catch (error) {
      softapTraceFailure("softap_progress_listener_threw", {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private setStep(step: SoftapStep, patch: Partial<SoftapStepState>): void {
    this.steps = this.steps.map((entry) => (entry.step === step ? {...entry, ...patch} : entry))
    this.emitProgress()
  }

  /** Narration for a running step: what the phone or the glasses just reported. */
  private note(generation: number, step: SoftapStep, detail: string): void {
    if (generation !== this.generation) return
    softapTrace("softap_step_note", {step, detail})
    this.setStep(step, {detail})
  }

  /** Steps currently built up, oldest first. Empty when nothing needs tearing down. */
  activeSteps(): SoftapStep[] {
    return [...this.completed]
  }

  /** The URL handed to the glasses, for diagnostics. Null outside a live attempt. */
  currentIngestUrl(): string | null {
    return this.ingestUrl
  }

  /**
   * Runs the sequence. On any failure the partial sequence is torn down before the error is
   * rethrown, so a failed start never leaves a hotspot up or a publisher running.
   */
  async start(options: SoftapCallOptions = {}): Promise<void> {
    if (this.phase !== "idle" && this.phase !== "failed") {
      throw new SoftapCallError("hotspot", "ALREADY_ACTIVE", `A SoftAP call is already ${this.phase}`)
    }
    const generation = ++this.generation
    this.phase = "starting"
    this.terminating = false
    this.teardownMode = "leave"
    this.endFailure = null
    this.completed = []
    this.ingestUrl = null
    this.hotspot = null
    this.steps = freshSteps()
    this.stepStartedAt.clear()
    this.startedAt = Date.now()
    this.onProgress = options.onProgress
    const traceId = beginSoftapTrace(options.traceId)
    this.traceId = traceId
    softapTrace("softap_call_start", {traceId})
    this.emitProgress()

    try {
      await this.step(generation, "hotspot", "HOTSPOT_FAILED", async (report) => {
        report("Asking the glasses to turn on their hotspot")
        const hotspot = await this.deps.startHotspot(report)
        if (!hotspot.ssid) {
          throw new Error("the glasses reported no hotspot SSID")
        }
        this.hotspot = hotspot
        // The passphrase never reaches the log; softapTrace redacts it by key, and only the SSID
        // is useful for matching against the phone's Wi-Fi state anyway.
        softapTrace("hotspot_enabled", {ssid: hotspot.ssid})
        report(`Hotspot ${hotspot.ssid} is on; waiting for it to broadcast`)
        await this.deps.waitUntilHotspotJoinable?.(report)
        softapTrace("hotspot_broadcast_wait_done", {ssid: hotspot.ssid})
        report(`Hotspot ${hotspot.ssid}`)
      })

      const hotspot = this.requireHotspot()
      let bindAddress: string | undefined
      await this.step(generation, "scopedJoin", "SCOPED_JOIN_FAILED", async (report) => {
        report(
          `Phone joining ${hotspot.ssid}. Turn Wi-Fi on if a panel opens — Teams stays on cellular.`,
        )
        bindAddress = await this.deps.joinScopedNetwork(hotspot.ssid, hotspot.passphrase, report)
        softapTrace("scoped_network_joined", {bindAddress: bindAddress ?? "unknown"})
        if (bindAddress) report(`Phone is ${bindAddress} on ${hotspot.ssid}`)
      })

      await this.step(generation, "acsJoin", "ACS_JOIN_FAILED", async (report) => {
        report(bindAddress ? `Opening video receiver on ${bindAddress}, then joining Teams` : "Joining Teams")
        const {ingestUrl} = await this.deps.joinMeeting(
          {
            ssid: hotspot.ssid,
            passphrase: hotspot.passphrase,
            bindAddress,
          },
          report,
        )
        if (!ingestUrl) {
          // Without a bound listener there is nowhere for the glasses to publish, and telling them
          // to publish anyway produces a failure several seconds later on the wrong device.
          throw new Error("the meeting reported no ingest URL")
        }
        this.ingestUrl = ingestUrl
        softapTrace("acs_joined", {ingestUrl})
        report(`Receiver ready at ${ingestUrl}`)
      })

      const ingestUrl = this.requireIngestUrl()
      await this.step(generation, "publish", "PUBLISH_FAILED", async (report) => {
        report("Telling the glasses to start the camera and publish to the phone")
        await this.deps.startPublishing({ingestUrl, traceId}, report)
        softapTrace("glasses_publishing", {ingestUrl})
        report("Glasses camera is streaming to the phone")
      })

      await this.step(generation, "live", "NO_FIRST_FRAME", async (report) => {
        report("Waiting for the first video frame to reach Teams")
        await this.deps.awaitFirstFrame(report)
        softapTrace("first_frame_in_acs")
        report("Video is live in the meeting")
      })

      if (generation !== this.generation) return
      this.phase = "live"
      softapTrace("softap_call_live")
      this.emitProgress()
    } catch (error) {
      // Unwind before rethrowing. A caller that sees a rejection is entitled to assume nothing was
      // left running, and a hotspot left up is both a battery cost and a second call's failure.
      await this.stop({keepProgress: true})
      this.phase = "failed"
      this.emitProgress()
      throw error
    }
  }

  /**
   * Tears down in exact reverse order, and only what was built.
   *
   * Every step is attempted even if an earlier one throws: a failure to stop the publisher must
   * not leave the hotspot on. Concurrent calls share one teardown rather than racing each other
   * through the same resources, and a second `stop()` after one finished is a no-op — this is the
   * only SoftAP exit, so every terminal path can call it without checking whether another already
   * did.
   *
   * `mode: "end"` swaps the meeting verb and nothing else. If ending for everyone fails, the rest of
   * the teardown still runs and the failure is rethrown at the end, so the caller can tell the
   * wearer they left a meeting that may still be live rather than inventing a clean end.
   */
  async stop(options: SoftapStopOptions = {}): Promise<void> {
    // Intent before action, always: a watcher must be able to tell a deliberate teardown from a
    // failure even during the very first await below.
    this.terminating = true
    if (options.mode) this.teardownMode = options.mode
    if (this.stopping) return this.stopping
    if (this.completed.length === 0 && this.phase === "idle") return

    this.generation++
    this.phase = "stopping"
    this.endFailure = null
    softapTrace("softap_call_stop", {steps: this.completed.join(","), mode: this.teardownMode})
    this.emitProgress()

    this.stopping = (async () => {
      const failures: string[] = []
      for (const step of [...this.completed].reverse()) {
        try {
          await this.undo(step)
          softapTrace("softap_step_undone", {step})
        } catch (error) {
          // Recorded, not rethrown: the remaining steps still have to be undone.
          failures.push(step)
          softapTraceFailure("softap_step_undo_failed", {
            step,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      this.completed = []
      this.hotspot = null
      this.ingestUrl = null
      this.phase = "idle"
      softapTrace("softap_call_stopped", {undoFailures: failures.join(",")})
      resetSoftapTrace()
      // A failed start keeps its checklist so the UI can show which step broke; a deliberate
      // leave wipes it, because there is nothing left to explain.
      if (!options.keepProgress) {
        this.steps = freshSteps()
        this.emitProgress()
      }
    })()

    try {
      await this.stopping
    } finally {
      this.stopping = null
    }
    // Rethrown last, after every resource is released. An End that could not terminate the meeting
    // has still taken this device out; only the claim about the others is wrong.
    const endFailure = this.endFailure
    this.endFailure = null
    if (endFailure) throw endFailure
  }

  private async undo(step: SoftapStep): Promise<void> {
    switch (step) {
      // `live` is an observation, not a resource — there is nothing to release.
      case "live":
        return
      case "publish":
        return this.deps.stopPublishing()
      case "acsJoin":
        return this.leaveOrEndMeeting()
      case "scopedJoin":
        return this.deps.leaveScopedNetwork()
      case "hotspot":
        return this.deps.stopHotspot()
    }
  }

  /**
   * The one step End changes.
   *
   * A failed End falls back to leaving, so the wearer is out either way, and the original failure is
   * kept for [stop] to rethrow. Recording it rather than throwing here is what keeps the hotspot
   * teardown — the steps after this one — unconditional.
   */
  private async leaveOrEndMeeting(): Promise<void> {
    if (this.teardownMode !== "end") return this.deps.leaveMeeting()
    const endMeeting = this.deps.endMeeting
    if (!endMeeting) {
      this.endFailure = new SoftapEndNotSupportedError()
      return this.deps.leaveMeeting()
    }
    try {
      await endMeeting()
      softapTrace("softap_meeting_ended_for_everyone")
    } catch (error) {
      this.endFailure = error
      softapTraceFailure("softap_end_for_everyone_failed", {
        reason: error instanceof Error ? error.message : String(error),
      })
      // Native ends the local call even when the hang-up is refused, so this is a belt-and-braces
      // leave rather than a second teardown: it must not resurrect the failure it is covering for.
      await this.deps.leaveMeeting().catch(() => undefined)
    }
  }

  /**
   * Runs one step, records it as undoable, and maps any throw to a [SoftapCallError] naming the
   * step. The generation check is what makes leaving mid-step safe: a step that resolves after the
   * caller gave up is not recorded, so teardown does not try to undo it twice.
   */
  private async step(
    generation: number,
    step: SoftapStep,
    code: string,
    run: (report: SoftapStepReporter) => Promise<void>,
  ): Promise<void> {
    if (generation !== this.generation) {
      throw new SoftapCallError(step, "CANCELLED", `SoftAP call was cancelled before ${step}`)
    }
    softapTrace("softap_step_begin", {step})
    const startedAt = Date.now()
    this.stepStartedAt.set(step, startedAt)
    this.setStep(step, {status: "running", error: undefined})
    const report: SoftapStepReporter = (detail) => this.note(generation, step, detail)
    try {
      await run(report)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      softapTraceFailure("softap_step_failed", {step, code, reason})
      if (generation === this.generation) {
        this.setStep(step, {status: "failed", error: reason, durationMs: Date.now() - startedAt})
      }
      throw new SoftapCallError(step, code, error instanceof Error ? error.message : `${step} failed`, error)
    }
    if (generation !== this.generation) {
      // The step succeeded after the caller gave up. Release it here rather than recording it for
      // the teardown to find: that teardown may already have walked past this step, or finished
      // altogether, in which case nothing else ever would. This is the leak the generation guard
      // exists to close — a meeting joined a few milliseconds after the user left.
      softapTrace("softap_step_completed_after_cancel", {step})
      await this.undoSafely(step)
      throw new SoftapCallError(step, "CANCELLED", `SoftAP call was cancelled during ${step}`)
    }
    this.completed.push(step)
    softapTrace("softap_step_done", {step, durationMs: Date.now() - startedAt})
    this.setStep(step, {status: "done", durationMs: Date.now() - startedAt})
  }

  /** Undo that reports rather than throws, for the cancellation path where there is no caller. */
  private async undoSafely(step: SoftapStep): Promise<void> {
    try {
      await this.undo(step)
    } catch (error) {
      softapTraceFailure("softap_step_undo_failed", {
        step,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private requireHotspot(): {ssid: string; passphrase: string} {
    const hotspot = this.hotspot
    if (!hotspot) throw new SoftapCallError("hotspot", "HOTSPOT_FAILED", "no hotspot credentials")
    return hotspot
  }

  private requireIngestUrl(): string {
    const url = this.ingestUrl
    if (!url) throw new SoftapCallError("acsJoin", "ACS_JOIN_FAILED", "no ingest URL")
    return url
  }
}

/**
 * Binds the sequence to the real subsystems.
 *
 * Kept separate from the class so the ordering above is tested against fakes rather than against
 * BLE and ACS. The only logic here is adapting shapes; anything that needs a decision belongs in
 * the class.
 *
 * @param packageName the miniapp that owns the call
 * @param meeting the meeting to join, and how to observe its media health
 */
export function createSoftapCallDeps(args: {
  packageName: string
  meetingUrl: string
  token: string
  displayName?: string
  /** Resolves when the meeting reports a frame reached ACS; rejects on a failed feed. */
  awaitFirstFrame: () => Promise<void>
  subsystems: {
    setHotspotState: (enabled: boolean) => Promise<{state: string; ssid?: string; password?: string}>
    joinScopedNetwork: (ssid: string, passphrase: string) => Promise<string | undefined>
    leaveScopedNetwork: () => Promise<void>
    joinMeeting: (
      packageName: string,
      options: {
        meetingUrl: string
        token: string
        videoSource: {type: "softap"; ssid?: string; passphrase?: string; bindAddress?: string}
        displayName?: string
      },
    ) => Promise<unknown>
    leaveMeeting: (packageName: string) => Promise<void>
    /** Terminate the group call for everyone. Absent on hosts that cannot. */
    endMeeting?: (packageName: string) => Promise<void>
    ingestUrl: () => string | null
    startPublishing: (
      packageName: string,
      options: {streamUrl: string; ice: {stun: string}; traceId: string; captureAudio?: boolean},
    ) => Promise<unknown>
    stopPublishing: (packageName: string) => Promise<void>
    /**
     * Whether the host is taking the wearer's voice off the glasses over BLE LC3 for this call.
     *
     * Asked after the meeting join and before the publish, because that is the only moment the
     * answer is both known (the host has seen the native's capabilities) and still actionable (the
     * glasses have not been told what to capture). True means the WHIP publish is video-only;
     * false means the glasses put their microphone on the WHIP track as they always have. Absent
     * on hosts that only have the WHIP audio path.
     */
    glassesLc3Uplink?: () => boolean
    /**
     * Prove the phone can reach the glasses over the hotspot it just joined. Optional because
     * only Android hosts have the scoped network handle; when present its verdict is narrated
     * into the scoped-join step and a failure is reported, not thrown — the glasses-to-phone
     * direction is what the call actually needs, and that is tested by the publish step.
     */
    probeGateway?: () => Promise<{reachable: boolean; detail: string}>
    /**
     * Wait for the phone's default network to be validated again after the hotspot join took Wi-Fi
     * away. Optional because only Android hosts can answer it.
     *
     * Not fatal when it reports an unusable network: the wearer is told, and the join is attempted
     * anyway. Aborting here would fail calls that recover a second later, and the ACS join has its
     * own bounded timeout for the case that does not.
     */
    awaitValidatedDefaultNetwork?: () => Promise<{usable: boolean; detail: string} | null>
    /**
     * Glasses `stream_status` events, so the publish step can say "camera starting" and "offer
     * posted" instead of going quiet for the whole BLE round trip. Returns an unsubscribe.
     */
    onGlassesStreamStatus?: (
      listener: (event: {status: string; streamId?: string; reason?: string; error?: string}) => void,
    ) => () => void
  }
  /** Override only in tests. Production waits the gallery-proven broadcast window. */
  hotspotBroadcastWaitMs?: number
}): SoftapCallDeps {
  const {packageName, subsystems} = args
  const hotspotBroadcastWaitMs = args.hotspotBroadcastWaitMs ?? HOTSPOT_BROADCAST_WAIT_MS
  return {
    startHotspot: async (report) => {
      const status = await subsystems.setHotspotState(true)
      if (status.state !== "enabled" || !status.ssid) {
        throw new Error(`the glasses hotspot did not start (state=${status.state})`)
      }
      if (!status.password) {
        throw new Error("the glasses hotspot reported no password")
      }
      report?.(`Glasses report hotspot ${status.ssid} enabled`)
      return {ssid: status.ssid, passphrase: status.password}
    },
    waitUntilHotspotJoinable: async (report) => {
      if (hotspotBroadcastWaitMs <= 0) return
      softapTrace("hotspot_broadcast_wait", {ms: hotspotBroadcastWaitMs})
      report?.(`Giving the hotspot ${Math.round(hotspotBroadcastWaitMs / 1000)}s to start broadcasting`)
      await new Promise<void>(resolve => setTimeout(resolve, hotspotBroadcastWaitMs))
    },
    stopHotspot: async () => {
      await subsystems.setHotspotState(false)
    },
    joinScopedNetwork: async (ssid, passphrase, report) => {
      const address = await subsystems.joinScopedNetwork(ssid, passphrase)
      if (subsystems.probeGateway) {
        report?.(`Phone is ${address ?? "on the hotspot"}; checking it can reach the glasses`)
        try {
          const probe = await subsystems.probeGateway()
          softapTrace(probe.reachable ? "gateway_probe_ok" : "gateway_probe_failed", {detail: probe.detail})
          report?.(
            probe.reachable
              ? `Phone ${address ?? ""} ↔ glasses OK (${probe.detail})`
              : `Phone ${address ?? ""} joined, but cannot reach the glasses: ${probe.detail}`,
          )
        } catch (error) {
          softapTraceFailure("gateway_probe_threw", {
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return address
    },
    leaveScopedNetwork: () => subsystems.leaveScopedNetwork(),
    joinMeeting: async ({ssid, passphrase, bindAddress}, report) => {
      // The hotspot join just took this phone off Wi-Fi, so the route Teams needs is whatever
      // Android promoted in its place. Waiting for it to validate is what stopped the ACS join
      // from burning its whole timeout on DNS that could not resolve yet.
      if (subsystems.awaitValidatedDefaultNetwork) {
        report?.("Waiting for this phone's mobile data to take over so Teams can connect")
        try {
          const network = await subsystems.awaitValidatedDefaultNetwork()
          if (network) {
            softapTrace(network.usable ? "default_network_ok" : "default_network_unvalidated", {
              detail: network.detail,
            })
            report?.(
              network.usable
                ? `Internet is on ${network.detail}`
                : `Internet is not confirmed yet (${network.detail}); joining Teams anyway`,
            )
          }
        } catch (error) {
          softapTraceFailure("default_network_check_threw", {
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      report?.("Binding the video receiver and joining Teams over cellular")
      await subsystems.joinMeeting(packageName, {
        meetingUrl: args.meetingUrl,
        token: args.token,
        videoSource: {type: "softap", ssid, passphrase, bindAddress},
        displayName: args.displayName,
      })
      // The listener binds during the join, so the URL only exists now.
      return {ingestUrl: subsystems.ingestUrl() ?? ""}
    },
    leaveMeeting: () => subsystems.leaveMeeting(packageName),
    ...(subsystems.endMeeting ? {endMeeting: () => subsystems.endMeeting!(packageName)} : {}),
    startPublishing: async ({ingestUrl, traceId}, report) => {
      // Narrate the glasses side while the BLE start command is in flight. `initializing` means
      // the glasses accepted the command and are opening the camera; `streaming` means the WHIP
      // offer was answered and ICE connected; anything else is the reason it did not.
      const unsubscribe = subsystems.onGlassesStreamStatus?.((event) => {
        if (event.status === "initializing") {
          report?.("Glasses accepted the command: camera starting, gathering ICE, posting offer to the phone")
        } else if (event.status === "streaming") {
          report?.("Glasses are streaming to the phone")
        } else if (event.status === "error") {
          report?.(`Glasses reported: ${event.error ?? event.reason ?? "stream error"}`)
        } else if (event.status === "reconnecting") {
          report?.(`Glasses reconnecting: ${event.reason ?? ""}`)
        }
      })
      // Decided before the command goes out, never after: the glasses cannot drop an audio track
      // they already negotiated, and two live copies of the wearer's voice in one call is worse
      // than either one alone.
      const lc3Uplink = subsystems.glassesLc3Uplink?.() ?? false
      softapTrace("publish_audio_decision", {captureAudio: !lc3Uplink, micTransport: lc3Uplink ? "ble-lc3" : "whip"})
      report?.(
        lc3Uplink
          ? "Publishing video only; the wearer's voice comes over Bluetooth LC3"
          : "Publishing video and the glasses microphone",
      )
      try {
        await subsystems.startPublishing(packageName, {
          streamUrl: ingestUrl,
          // Empty STUN server means host-only: there is no route from the hotspot to a STUN server,
          // so a configured one would add doomed gathering to every call.
          ice: {stun: ""},
          traceId,
          captureAudio: !lc3Uplink,
        })
      } finally {
        unsubscribe?.()
      }
    },
    stopPublishing: () => subsystems.stopPublishing(packageName),
    awaitFirstFrame: args.awaitFirstFrame,
  }
}
