/**
 * MicStateCoordinator
 *
 * Owns local-miniapp-driven microphone requirements.
 *
 * Local miniapps subscribe to audio_chunk / transcription streams.
 * This coordinator pushes the aggregate local requirement set to BluetoothSdk
 * so the mic runs whenever at least one local consumer needs it.
 *
 * It also merges what the live microphone sessions require (MicSessionManager,
 * via `setSessionRequirement` / `setSessionMicTuning`) with the OS preferences
 * the settings store derives. Applications go through MicSessionManager; this
 * class is an engine implementation detail.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {createDebouncedPatchFlusher} from "../utils/debouncedPatch"
import type {MicTuningProfile} from "./micPolicy"

const LOG_TAG = "MIC_COORDINATOR"

/** Field-wise compare, so a profile that moves a threshold without the gain still lands. */
function sameProfile(a: MicTuningProfile | null, b: MicTuningProfile | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MicTuningProfile>
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

type MicGate = "vad" | "loudnessGate"

interface GateOverride {
  enabled: boolean
  order: number
}

interface ConfiguredMicGates {
  vadEnabled?: boolean | null
  loudnessGateEnabled?: boolean | null
  micTuning?: Record<string, number> | null
}

/** Mic-requirement flips are debounced (300ms) and merged into one BLE write
 *  (wire v2 keeps BLE JSON small and infrequent). */
const flushMicRequirementsPatch = createDebouncedPatchFlusher<Record<string, unknown>>((patch) => {
  try {
    // Resolve runtime overrides at flush time. A miniapp can acquire/release a
    // gate override during the debounce window, and a captured stale value
    // must not win after that lifecycle transition.
    const runtimePatch = micStateCoordinator.applyEffectiveGatePolicy(patch)
    // The merged patch, not the intent that produced it. Everything above this line is a
    // preference; this is the only record of what the glasses were actually told, and the three
    // keys a call depends on (VAD off, Barrier on, the tuning) are only decided here at flush.
    console.log(`${LOG_TAG}: write`, runtimePatch)
    void Promise.resolve(BluetoothSdk.updateBluetoothSettings(runtimePatch)).catch((err) => {
      console.error(`${LOG_TAG}: failed to apply mic requirements:`, err)
    })
  } catch (err) {
    console.error(`${LOG_TAG}: failed to apply mic requirements:`, err)
  }
}, 300)

class MicStateCoordinator {
  private static instance: MicStateCoordinator | null = null

  // Local miniapp requirements (set when miniapps subscribe to audio streams)
  private localWantsPcm = false
  private localWantsLc3 = false
  /**
   * A live microphone session held through MicSessionManager — a voice call today.
   *
   * Tracked separately from the miniapp requirement because the two have independent lifetimes:
   * the call miniapp does not subscribe to `audio_chunk`, and a captions miniapp that stops mid-call
   * must not take the call's microphone with it.
   */
  private sessionWantsPcm = false
  private configuredVad: boolean | undefined
  private configuredLoudnessGate: boolean | undefined
  /** `mic_tuning` as the settings store last derived it: `super_mode ? desired : {}`. */
  private configuredMicTuning: Record<string, number> = {}
  /** Tuning required by the live sessions, resolved by micPolicy. */
  private sessionMicTuning: MicTuningProfile | null = null
  /**
   * Latched once a session profile has actually been written.
   *
   * Before that, `mic_tuning` stays out of every patch, so a device that never
   * runs a profile does not carry the key on unrelated mic writes. After it,
   * the OS value keeps being restated, which is what stops a reconnect after a
   * call from resurrecting the profile.
   */
  private sessionMicTuningWritten = false
  /** Barrier required by the live sessions, or null when they have no opinion. */
  private sessionLoudnessGate: boolean | null = null
  /** Latched like the tuning, so the OS value is restated once a session has moved it. */
  private sessionLoudnessGateWritten = false
  private readonly miniappVadOverrides = new Map<string, GateOverride>()
  private readonly miniappLoudnessGateOverrides = new Map<string, GateOverride>()
  private overrideSequence = 0

  private constructor() {}

  public static getInstance(): MicStateCoordinator {
    if (!MicStateCoordinator.instance) {
      MicStateCoordinator.instance = new MicStateCoordinator()
    }
    return MicStateCoordinator.instance
  }

  /**
   * Update local miniapp requirements. Called by LocalMiniappRuntime when
   * the aggregated set of local subscriptions changes.
   */
  public setLocalRequirements(req: {pcm: boolean; lc3: boolean} & ConfiguredMicGates): void {
    this.localWantsPcm = req.pcm
    this.localWantsLc3 = req.lc3
    this.rememberConfiguredGates(req)
    console.log(`${LOG_TAG}: local requirements updated — pcm=${req.pcm} lc3=${req.lc3}`)
    this.applyUnion()
  }

  /**
   * Claim or release raw PCM on behalf of the live microphone sessions.
   *
   * MicSessionManager only. Applications acquire a session; they do not reach past it to here.
   * Releasing is a claim release, not a mic shutdown: if a captions miniapp still wants PCM the
   * microphone stays on, which is the whole reason this is a separate flag rather than a setter on
   * the local requirement.
   */
  public setSessionRequirement(pcm: boolean): void {
    if (this.sessionWantsPcm === pcm) return
    this.sessionWantsPcm = pcm
    console.log(`${LOG_TAG}: session requirement updated — pcm=${pcm}`)
    this.applyUnion()
  }

  /**
   * Apply or drop the tuning the live sessions require.
   *
   * MicSessionManager only. Rides `applyUnion` so the profile and the PCM claim land in one
   * debounced write, resolved at flush time: a session released inside the debounce window wins
   * over the value that was queued.
   */
  public setSessionMicTuning(profile: MicTuningProfile | null): void {
    if (sameProfile(profile, this.sessionMicTuning)) return
    this.sessionMicTuning = profile
    if (profile) this.sessionMicTuningWritten = true
    // Nothing was ever written, so there is nothing to restore.
    else if (!this.sessionMicTuningWritten) return
    console.log(`${LOG_TAG}: session mic tuning ${profile ? JSON.stringify(profile) : "cleared"}`)
    this.applyUnion()
  }

  /** Last session profile queued, or null when the OS value is in force. */
  public getSessionMicTuning(): MicTuningProfile | null {
    return this.sessionMicTuning
  }

  /** Last session Barrier queued, or null when the OS value is in force. For call logging. */
  public getSessionLoudnessGate(): boolean | null {
    return this.sessionLoudnessGate
  }

  /**
   * Run or stop the center-mic loudness gate on behalf of the live sessions.
   *
   * MicSessionManager only, and the counterpart to the PCM claim rather than a second opinion on
   * it: raw PCM turns hardware VAD off, which leaves Barrier as the only thing standing between
   * the far end and its own echo. Unlike VAD this never stops the stream, so the worst a wrong
   * threshold costs is a zeroed frame instead of a dropped word.
   */
  public setSessionLoudnessGate(enabled: boolean | null): void {
    if (this.sessionLoudnessGate === enabled) return
    this.sessionLoudnessGate = enabled
    if (enabled !== null) this.sessionLoudnessGateWritten = true
    else if (!this.sessionLoudnessGateWritten) return
    console.log(`${LOG_TAG}: session loudness gate ${enabled === null ? "cleared" : enabled}`)
    this.applyUnion()
  }

  /**
   * Super Mode sliders outrank a session profile. A live override means a gain
   * sweep would write to the coordinator and the glasses would ignore it.
   */
  public hasConfiguredMicTuning(): boolean {
    return Object.keys(this.configuredMicTuning).length > 0
  }

  /**
   * Whether anything on this device needs a continuous raw-PCM timeline. Also the condition that
   * forces hardware VAD off: a gate that drops silence turns a call into clipped half-words.
   */
  private get wantsRawPcm(): boolean {
    return this.localWantsPcm || this.sessionWantsPcm
  }

  /**
   * The session profile, but only when it wins.
   *
   * A live Super Mode tuning value outranks it: that screen is how a profile's numbers get found
   * on a real call in the first place. Emptiness is by key count — the settings store hands back a
   * fresh `{}` every time, so reference checks would never match.
   */
  private winningSessionMicTuning(): Record<string, number> | undefined {
    if (!this.sessionMicTuning) return undefined
    if (Object.keys(this.configuredMicTuning).length > 0) return undefined
    return {...this.sessionMicTuning} as Record<string, number>
  }

  /**
   * The session's Barrier, but only when it wins.
   *
   * Suppressed by a live Super Mode tuning value for the same reason the gain is: that screen is
   * the manual override, and a gate running against hand-entered thresholds is the one case where
   * the session's numbers are the wrong ones.
   */
  private winningSessionLoudnessGate(): boolean | undefined {
    if (this.sessionLoudnessGate === null) return undefined
    if (Object.keys(this.configuredMicTuning).length > 0) return undefined
    return this.sessionLoudnessGate
  }

  /**
   * Apply a miniapp-owned gate override without changing the OS preference.
   * Overrides are lifecycle-scoped and last-live-owner-wins independently for
   * VAD and Barrier.
   */
  public async setMiniappGateOverride(
    packageName: string,
    gate: MicGate,
    enabled: boolean,
    configured: ConfiguredMicGates = {},
  ): Promise<void> {
    this.rememberConfiguredGates(configured)
    const overrides = this.overridesFor(gate)
    const previous = overrides.get(packageName)
    const next = {enabled, order: ++this.overrideSequence}
    overrides.set(packageName, next)

    try {
      await BluetoothSdk.updateBluetoothSettings(this.effectiveGatePatch())
    } catch (error) {
      // Do not roll back a newer request from the same package that landed
      // while this native write was in flight.
      if (overrides.get(packageName) === next) {
        if (previous) overrides.set(packageName, previous)
        else overrides.delete(packageName)
      }
      throw error
    }
  }

  /**
   * Remove every gate override owned by a miniapp. This is synchronous so
   * unregister can drop ownership before recomputing aggregate mic state.
   */
  public clearMiniappGateOverrides(packageName: string): boolean {
    const removedVad = this.miniappVadOverrides.delete(packageName)
    const removedLoudness = this.miniappLoudnessGateOverrides.delete(packageName)
    return removedVad || removedLoudness
  }

  /** Re-apply the current runtime policy after an owner is released. */
  public async syncEffectiveGatePolicy(configured: ConfiguredMicGates = {}): Promise<void> {
    this.rememberConfiguredGates(configured)
    const patch = this.effectiveGatePatch()
    if (Object.keys(patch).length === 0) return
    await BluetoothSdk.updateBluetoothSettings(patch)
  }

  /**
   * Preserve the runtime microphone contract when the persisted device
   * settings are replayed (for example after a glasses reconnect). Active
   * miniapp gate overrides replace the OS values, and raw PCM keeps VAD off
   * until the last raw-audio consumer unsubscribes.
   */
  public applyRuntimeOverrides(settings: Record<string, unknown>): Record<string, unknown> {
    this.rememberConfiguredGates({
      vadEnabled:
        typeof settings.voice_activity_detection_enabled === "boolean"
          ? settings.voice_activity_detection_enabled
          : undefined,
      loudnessGateEnabled:
        typeof settings.loudness_gate_enabled === "boolean" ? settings.loudness_gate_enabled : undefined,
      micTuning:
        settings.mic_tuning && typeof settings.mic_tuning === "object"
          ? (settings.mic_tuning as Record<string, number>)
          : undefined,
    })

    return this.applyActiveRuntimeOverrides(settings)
  }

  /**
   * Apply the complete current gate policy without treating the input as an OS
   * preference update. Used by debounced mic-requirement writes, whose queued
   * gate values may be stale after an override is acquired or released.
   */
  public applyEffectiveGatePolicy(settings: Record<string, unknown>): Record<string, unknown> {
    return {
      ...settings,
      ...this.effectiveGatePatch(),
    }
  }

  private applyActiveRuntimeOverrides(settings: Record<string, unknown>): Record<string, unknown> {
    const runtimeSettings = {...settings}
    const vadOverride = this.latestOverride(this.miniappVadOverrides)
    const loudnessOverride = this.latestOverride(this.miniappLoudnessGateOverrides)

    if (this.wantsRawPcm) {
      runtimeSettings.voice_activity_detection_enabled = false
    } else if (vadOverride) {
      runtimeSettings.voice_activity_detection_enabled = vadOverride.enabled
    }
    const sessionGate = this.winningSessionLoudnessGate()
    if (loudnessOverride) {
      runtimeSettings.loudness_gate_enabled = loudnessOverride.enabled
    } else if (sessionGate !== undefined) {
      runtimeSettings.loudness_gate_enabled = sessionGate
    }

    // BES forgets mic_tuning on disconnect, so the on-connect replay is what
    // puts a live session's profile back.
    const sessionTuning = this.winningSessionMicTuning()
    if (sessionTuning) runtimeSettings.mic_tuning = sessionTuning
    else if (this.sessionMicTuningWritten) runtimeSettings.mic_tuning = this.configuredMicTuning

    return runtimeSettings
  }

  /**
   * Push local requirements to BluetoothSdk. `should_send_pcm` is strictly for
   * on-device PCM consumers; cloud audio uses LC3 through AudioCloudUplink.
   */
  private applyUnion(): void {
    const shouldSendPcm = this.wantsRawPcm
    const shouldSendLc3 = this.localWantsLc3

    // console.log(
    //   `${LOG_TAG}: applying requirements — pcm=${shouldSendPcm} lc3=${shouldSendLc3}`,
    // )

    // The mic control plane is a direct btsdk call now (was a host setMicRequirements
    // hook) so a bare OEM streams audio without wiring it.
    const patch: Record<string, unknown> = {
      should_send_pcm: shouldSendPcm,
      should_send_lc3: shouldSendLc3,
      should_send_transcript: false,
      ...this.effectiveGatePatch(),
    }

    flushMicRequirementsPatch(patch)
  }

  private rememberConfiguredGates(configured: ConfiguredMicGates): void {
    // null means the connected device intentionally omits that setting.
    // undefined means the caller is not updating the remembered preference.
    if (configured.vadEnabled !== undefined) {
      this.configuredVad = configured.vadEnabled ?? undefined
    }
    if (configured.loudnessGateEnabled !== undefined) {
      this.configuredLoudnessGate = configured.loudnessGateEnabled ?? undefined
    }
    if (configured.micTuning !== undefined) {
      this.configuredMicTuning = configured.micTuning ?? {}
    }
  }

  private overridesFor(gate: MicGate): Map<string, GateOverride> {
    return gate === "vad" ? this.miniappVadOverrides : this.miniappLoudnessGateOverrides
  }

  private latestOverride(overrides: Map<string, GateOverride>): GateOverride | undefined {
    let latest: GateOverride | undefined
    for (const entry of overrides.values()) {
      if (!latest || entry.order > latest.order) latest = entry
    }
    return latest
  }

  private effectiveGatePatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    const vadOverride = this.latestOverride(this.miniappVadOverrides)
    const loudnessOverride = this.latestOverride(this.miniappLoudnessGateOverrides)

    // Hardware VAD suppresses silence. Raw-audio consumers need a continuous
    // timeline, so their requirement wins over both OS and miniapp VAD values.
    if (this.wantsRawPcm) patch.voice_activity_detection_enabled = false
    else if (vadOverride) patch.voice_activity_detection_enabled = vadOverride.enabled
    else if (this.configuredVad !== undefined) patch.voice_activity_detection_enabled = this.configuredVad

    const sessionGate = this.winningSessionLoudnessGate()
    if (loudnessOverride) patch.loudness_gate_enabled = loudnessOverride.enabled
    else if (sessionGate !== undefined) patch.loudness_gate_enabled = sessionGate
    else if (this.configuredLoudnessGate !== undefined) {
      patch.loudness_gate_enabled = this.configuredLoudnessGate
    } else if (this.sessionLoudnessGateWritten) {
      // A session moved it and the device carries no preference, so restate the product default
      // rather than leaving the call's gate running after it ended.
      patch.loudness_gate_enabled = false
    }

    const sessionTuning = this.winningSessionMicTuning()
    if (sessionTuning) patch.mic_tuning = sessionTuning
    else if (this.sessionMicTuningWritten) patch.mic_tuning = this.configuredMicTuning

    return patch
  }

  /**
   * Reset all requirements to off. Called during cleanup.
   */
  public reset(): void {
    this.localWantsPcm = false
    this.localWantsLc3 = false
    this.sessionWantsPcm = false
    this.sessionMicTuning = null
    this.sessionLoudnessGate = null
    this.applyUnion()
  }

  public cleanup(): void {
    console.log(`${LOG_TAG}: cleanup()`)
    this.miniappVadOverrides.clear()
    this.miniappLoudnessGateOverrides.clear()
    this.reset()
    MicStateCoordinator.instance = null
  }
}

const micStateCoordinator = MicStateCoordinator.getInstance()
export default micStateCoordinator
