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

export interface SoftapCallDeps {
  /** Enable the glasses hotspot and return its credentials. */
  startHotspot(): Promise<{ssid: string; passphrase: string}>
  /** Disable it. Must tolerate being called when it was never enabled. */
  stopHotspot(): Promise<void>
  /** Join the hotspot without taking the phone's default route. Resolves to the phone's own IPv4. */
  joinScopedNetwork(ssid: string, passphrase: string): Promise<string | undefined>
  leaveScopedNetwork(): Promise<void>
  /**
   * Join the meeting. This is what binds the local WHIP listener and arms the ACS raw outputs, so
   * it must resolve before the glasses are told to publish.
   *
   * @returns the URL the glasses must POST their offer to
   */
  joinMeeting(args: {ssid: string; passphrase: string; bindAddress?: string}): Promise<{ingestUrl: string}>
  leaveMeeting(): Promise<void>
  /** Tell the glasses to publish to [ingestUrl] in host-only ICE mode. */
  startPublishing(args: {ingestUrl: string; traceId: string}): Promise<void>
  stopPublishing(): Promise<void>
  /**
   * Resolves when a frame has reached ACS, rejects if the feed failed or the deadline passed.
   * Separate from [joinMeeting] because an answered negotiation is not a working call: a session
   * that never delivers a frame reads as healthy behind a frozen tile.
   */
  awaitFirstFrame(): Promise<void>
}

export interface SoftapCallOptions {
  /** Override the minted trace id, so a caller can correlate with logs it already started. */
  traceId?: string
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
  private hotspot: {ssid: string; passphrase: string} | null = null
  private ingestUrl: string | null = null

  constructor(private readonly deps: SoftapCallDeps) {}

  currentPhase(): SoftapPhase {
    return this.phase
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
    this.completed = []
    this.ingestUrl = null
    this.hotspot = null
    const traceId = beginSoftapTrace(options.traceId)
    softapTrace("softap_call_start", {traceId})

    try {
      await this.step(generation, "hotspot", "HOTSPOT_FAILED", async () => {
        const hotspot = await this.deps.startHotspot()
        if (!hotspot.ssid) {
          throw new Error("the glasses reported no hotspot SSID")
        }
        this.hotspot = hotspot
        // The passphrase never reaches the log; softapTrace redacts it by key, and only the SSID
        // is useful for matching against the phone's Wi-Fi state anyway.
        softapTrace("hotspot_enabled", {ssid: hotspot.ssid})
      })

      const hotspot = this.requireHotspot()
      let bindAddress: string | undefined
      await this.step(generation, "scopedJoin", "SCOPED_JOIN_FAILED", async () => {
        bindAddress = await this.deps.joinScopedNetwork(hotspot.ssid, hotspot.passphrase)
        softapTrace("scoped_network_joined", {bindAddress: bindAddress ?? "unknown"})
      })

      await this.step(generation, "acsJoin", "ACS_JOIN_FAILED", async () => {
        const {ingestUrl} = await this.deps.joinMeeting({
          ssid: hotspot.ssid,
          passphrase: hotspot.passphrase,
          bindAddress,
        })
        if (!ingestUrl) {
          // Without a bound listener there is nowhere for the glasses to publish, and telling them
          // to publish anyway produces a failure several seconds later on the wrong device.
          throw new Error("the meeting reported no ingest URL")
        }
        this.ingestUrl = ingestUrl
        softapTrace("acs_joined", {ingestUrl})
      })

      const ingestUrl = this.requireIngestUrl()
      await this.step(generation, "publish", "PUBLISH_FAILED", async () => {
        await this.deps.startPublishing({ingestUrl, traceId})
        softapTrace("glasses_publishing", {ingestUrl})
      })

      await this.step(generation, "live", "NO_FIRST_FRAME", async () => {
        await this.deps.awaitFirstFrame()
        softapTrace("first_frame_in_acs")
      })

      if (generation !== this.generation) return
      this.phase = "live"
      softapTrace("softap_call_live")
    } catch (error) {
      // Unwind before rethrowing. A caller that sees a rejection is entitled to assume nothing was
      // left running, and a hotspot left up is both a battery cost and a second call's failure.
      await this.stop()
      this.phase = "failed"
      throw error
    }
  }

  /**
   * Tears down in exact reverse order, and only what was built.
   *
   * Every step is attempted even if an earlier one throws: a failure to stop the publisher must
   * not leave the hotspot on. Concurrent calls share one teardown rather than racing each other
   * through the same resources.
   */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.completed.length === 0 && this.phase === "idle") return

    this.generation++
    this.phase = "stopping"
    softapTrace("softap_call_stop", {steps: this.completed.join(",")})

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
    })()

    try {
      await this.stopping
    } finally {
      this.stopping = null
    }
  }

  private async undo(step: SoftapStep): Promise<void> {
    switch (step) {
      // `live` is an observation, not a resource — there is nothing to release.
      case "live":
        return
      case "publish":
        return this.deps.stopPublishing()
      case "acsJoin":
        return this.deps.leaveMeeting()
      case "scopedJoin":
        return this.deps.leaveScopedNetwork()
      case "hotspot":
        return this.deps.stopHotspot()
    }
  }

  /**
   * Runs one step, records it as undoable, and maps any throw to a [SoftapCallError] naming the
   * step. The generation check is what makes leaving mid-step safe: a step that resolves after the
   * caller gave up is not recorded, so teardown does not try to undo it twice.
   */
  private async step(generation: number, step: SoftapStep, code: string, run: () => Promise<void>): Promise<void> {
    if (generation !== this.generation) {
      throw new SoftapCallError(step, "CANCELLED", `SoftAP call was cancelled before ${step}`)
    }
    softapTrace("softap_step_begin", {step})
    try {
      await run()
    } catch (error) {
      softapTraceFailure("softap_step_failed", {
        step,
        code,
        reason: error instanceof Error ? error.message : String(error),
      })
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
    ingestUrl: () => string | null
    startPublishing: (
      packageName: string,
      options: {streamUrl: string; ice: {stun: string}; traceId: string},
    ) => Promise<unknown>
    stopPublishing: (packageName: string) => Promise<void>
  }
}): SoftapCallDeps {
  const {packageName, subsystems} = args
  return {
    startHotspot: async () => {
      const status = await subsystems.setHotspotState(true)
      if (status.state !== "enabled" || !status.ssid) {
        throw new Error(`the glasses hotspot did not start (state=${status.state})`)
      }
      return {ssid: status.ssid, passphrase: status.password ?? ""}
    },
    stopHotspot: async () => {
      await subsystems.setHotspotState(false)
    },
    joinScopedNetwork: (ssid, passphrase) => subsystems.joinScopedNetwork(ssid, passphrase),
    leaveScopedNetwork: () => subsystems.leaveScopedNetwork(),
    joinMeeting: async ({ssid, passphrase, bindAddress}) => {
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
    startPublishing: async ({ingestUrl, traceId}) => {
      await subsystems.startPublishing(packageName, {
        streamUrl: ingestUrl,
        // Empty STUN server means host-only: there is no route from the hotspot to a STUN server,
        // so a configured one would add doomed gathering to every call.
        ice: {stun: ""},
        traceId,
      })
    },
    stopPublishing: () => subsystems.stopPublishing(packageName),
    awaitFirstFrame: args.awaitFirstFrame,
  }
}
