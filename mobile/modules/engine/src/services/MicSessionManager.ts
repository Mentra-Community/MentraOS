/**
 * MicSessionManager
 *
 * The engine's microphone ownership layer. Applications acquire a lease that
 * says what they are doing; this class tracks the live leases, resolves them
 * through `micPolicy`, and pushes the result to MicStateCoordinator.
 *
 * Everything above it is semantic ("I need a glasses microphone for a voice
 * call"). Everything below it is hardware. Audio *sinks* — AcsMeetingService
 * today, another transport later — are downstream of the PCM this produces and
 * must not reach past it to the coordinator or the Bluetooth SDK.
 */

import {Platform} from "react-native"
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {getCallGainSweep} from "./CallGainSweep"
import micStateCoordinator from "./MicStateCoordinator"
import {
  resolveMicPolicy,
  type MicPlatformCaps,
  type MicSessionSpec,
  type MicSource,
  type MicUseCase,
} from "./micPolicy"

const LOG_TAG = "MIC_SESSION"

/** Raised when a second source is requested while another is already live. */
export const MIC_SOURCE_CONFLICT = "MIC_SOURCE_CONFLICT"

export interface MicSessionOptions {
  /** Package name for a miniapp, or `engine:<name>` for an engine feature. */
  owner: string
  source: MicSource
  useCase: MicUseCase
}

export interface MicSession {
  readonly id: number
  readonly owner: string
  readonly source: MicSource
  readonly useCase: MicUseCase
  /** Idempotent. Releasing a session that is already gone is a no-op. */
  release(): void
}

interface LiveSession extends MicSessionSpec {
  id: number
  owner: string
}

function defaultCaps(): MicPlatformCaps {
  return {
    // iOS has no `setMicSourcePin`, so it cannot promise the phone microphone
    // stays shut, and `glassesLc3UplinkSupported` never selects the BLE LC3
    // uplink there.
    glassesPcmUplink: Platform.OS === "android" && typeof BluetoothSdk.setMicSourcePin === "function",
  }
}

class MicSessionManager {
  private static instance: MicSessionManager | null = null

  private readonly sessions = new Map<number, LiveSession>()
  private nextId = 1
  private caps: MicPlatformCaps = defaultCaps()
  /** Last pin we asked for, so a no-op change does not re-enter native. */
  private pinned = false
  /**
   * One 15→14→15→13 walk per voice-call generation. Cleared when the last
   * glasses voice_call session drops so the next join can measure again.
   */
  private sweepFinished = false
  /** One-shot A/B walk. Off now that 15/14/13 is measured; Super Mode can still start it. */
  private sweepEnabled = false

  private constructor() {}

  public static getInstance(): MicSessionManager {
    if (!MicSessionManager.instance) {
      MicSessionManager.instance = new MicSessionManager()
    }
    return MicSessionManager.instance
  }

  /** Test seam. Production reads the platform once at construction. */
  public setPlatformCaps(caps: MicPlatformCaps): void {
    this.caps = caps
  }

  /**
   * Take a microphone lease.
   *
   * Throws [MIC_SOURCE_CONFLICT] when a different source is already live: only
   * the glasses can be pinned, so silently mixing sources would leave one
   * consumer reading a microphone it did not ask for. That is the failure ACS
   * already guards against frame by frame.
   */
  public acquire(options: MicSessionOptions): MicSession {
    const conflicting = [...this.sessions.values()].find((s) => s.source !== options.source)
    if (conflicting) {
      throw new Error(
        `${MIC_SOURCE_CONFLICT}: ${options.owner} asked for "${options.source}" while ` +
          `${conflicting.owner} holds "${conflicting.source}"`,
      )
    }

    const id = this.nextId++
    this.sessions.set(id, {id, owner: options.owner, source: options.source, useCase: options.useCase})
    console.log(`${LOG_TAG}: acquire #${id} ${options.owner} ${options.useCase}/${options.source}`)
    this.recompute()

    return {
      id,
      owner: options.owner,
      source: options.source,
      useCase: options.useCase,
      release: () => this.releaseId(id),
    }
  }

  /** Drop every lease an owner holds. The backstop for unregister / disconnect. */
  public releaseOwner(owner: string): boolean {
    let removed = false
    for (const [id, session] of this.sessions) {
      if (session.owner !== owner) continue
      this.sessions.delete(id)
      removed = true
    }
    if (removed) {
      console.log(`${LOG_TAG}: released all sessions for ${owner}`)
      this.recompute()
    }
    return removed
  }

  /**
   * Whether an owner holds a glasses lease.
   *
   * Ownership only. Whether that lease has any hardware effect is
   * [resolveMicPolicy]'s business, so on a platform without a glasses PCM
   * uplink this still answers true while nothing is claimed.
   */
  public hasGlassesSession(owner: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.owner === owner && session.source === "glasses") return true
    }
    return false
  }

  public releaseAll(): void {
    if (this.sessions.size === 0) {
      this.stopSweep("released_all")
      return
    }
    this.sessions.clear()
    console.log(`${LOG_TAG}: released all sessions`)
    this.recompute()
  }

  public cleanup(): void {
    this.stopSweep("cleanup")
    this.sessions.clear()
    this.pinned = false
    this.sweepFinished = false
    MicSessionManager.instance = null
  }

  /** Tests disable the auto-walk so acquire still means "policy 14". */
  public setCallGainSweepEnabled(enabled: boolean): void {
    this.sweepEnabled = enabled
    if (!enabled) this.stopSweep("disabled")
  }

  /**
   * Start or restart the 15→14→15→13 comparison on a live voice_call session.
   * Super Mode uses this so a call already in progress can be measured.
   */
  public startCallGainSweep(): boolean {
    if (!this.hasVoiceCallGlasses()) {
      console.warn(`${LOG_TAG}: CALL_GAIN_SWEEP ignored — no live voice_call glasses session`)
      return false
    }
    if (micStateCoordinator.hasConfiguredMicTuning()) {
      console.warn(
        `${LOG_TAG}: CALL_GAIN_SWEEP Super Mode mic-tuning is set; reset it or the glasses will ignore the sweep`,
      )
    }
    this.sweepFinished = false
    return getCallGainSweep().restart(
      (gain) => micStateCoordinator.setSessionMicTuning({gain}),
      () => {
        this.sweepFinished = true
        this.recompute()
      },
    )
  }

  private releaseId(id: number): void {
    if (!this.sessions.delete(id)) return
    console.log(`${LOG_TAG}: release #${id}`)
    this.recompute()
  }

  private hasVoiceCallGlasses(): boolean {
    if (!this.caps.glassesPcmUplink) return false
    for (const session of this.sessions.values()) {
      if (session.useCase === "voice_call" && session.source === "glasses") return true
    }
    return false
  }

  private stopSweep(reason: string): void {
    if (getCallGainSweep().isActive()) getCallGainSweep().stop(reason)
  }

  private recompute(): void {
    const policy = resolveMicPolicy([...this.sessions.values()], this.caps)
    const voiceCall = this.hasVoiceCallGlasses()
    if (!voiceCall) {
      this.stopSweep("session_ended")
      this.sweepFinished = false
    }

    // Pin before claiming PCM, so the first frame the claim produces is
    // already from the right microphone and the phone mic is never opened.
    if (policy.pinGlasses !== this.pinned) {
      this.pinned = policy.pinGlasses
      void Promise.resolve(BluetoothSdk.setMicSourcePin?.(policy.pinGlasses ? "glasses" : null)).catch(
        (error) => {
          console.warn(`${LOG_TAG}: setMicSourcePin failed`, error)
        },
      )
    }

    micStateCoordinator.setSessionRequirement(policy.rawPcm)
    // Barrier is the only echo control left once the PCM claim turns hardware VAD off, so it
    // rides with the claim rather than with the tuning a sweep may be rewriting.
    micStateCoordinator.setSessionLoudnessGate(policy.loudnessGate)

    if (getCallGainSweep().isActive()) {
      const gain = getCallGainSweep().currentGain()
      micStateCoordinator.setSessionMicTuning(gain == null ? policy.micTuning : {gain})
      return
    }

    if (this.sweepEnabled && voiceCall && !this.sweepFinished) {
      this.startCallGainSweep()
      return
    }

    micStateCoordinator.setSessionMicTuning(policy.micTuning)
  }
}

const micSessionManager = MicSessionManager.getInstance()
export default micSessionManager
