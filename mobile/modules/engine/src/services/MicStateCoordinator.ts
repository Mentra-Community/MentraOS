/**
 * MicStateCoordinator
 *
 * Owns local-miniapp-driven microphone requirements.
 *
 * Local miniapps subscribe to audio_chunk / transcription streams.
 * This coordinator pushes the aggregate local requirement set to BluetoothSdk
 * so the mic runs whenever at least one local consumer needs it.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {createDebouncedPatchFlusher} from "../utils/debouncedPatch"

const LOG_TAG = "MIC_COORDINATOR"

type MicGate = "vad" | "loudnessGate"

interface GateOverride {
  enabled: boolean
  order: number
}

interface ConfiguredMicGates {
  vadEnabled?: boolean | null
  loudnessGateEnabled?: boolean | null
}

/** Mic-requirement flips are debounced (300ms) and merged into one BLE write
 *  (wire v2 keeps BLE JSON small and infrequent). */
const flushMicRequirementsPatch = createDebouncedPatchFlusher<Record<string, unknown>>((patch) => {
  try {
    // Resolve runtime overrides at flush time. A miniapp can acquire/release a
    // gate override during the debounce window, and a captured stale value
    // must not win after that lifecycle transition.
    const runtimePatch = micStateCoordinator.applyEffectiveGatePolicy(patch)
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
  private configuredVad: boolean | undefined
  private configuredLoudnessGate: boolean | undefined
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

    if (this.localWantsPcm) {
      runtimeSettings.voice_activity_detection_enabled = false
    } else if (vadOverride) {
      runtimeSettings.voice_activity_detection_enabled = vadOverride.enabled
    }
    if (loudnessOverride) {
      runtimeSettings.loudness_gate_enabled = loudnessOverride.enabled
    }

    return runtimeSettings
  }

  /**
   * Push local requirements to BluetoothSdk. `should_send_pcm` is strictly for
   * on-device PCM consumers; cloud audio uses LC3 through AudioCloudUplink.
   */
  private applyUnion(): void {
    const shouldSendPcm = this.localWantsPcm
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
    if (this.localWantsPcm) patch.voice_activity_detection_enabled = false
    else if (vadOverride) patch.voice_activity_detection_enabled = vadOverride.enabled
    else if (this.configuredVad !== undefined) patch.voice_activity_detection_enabled = this.configuredVad

    if (loudnessOverride) patch.loudness_gate_enabled = loudnessOverride.enabled
    else if (this.configuredLoudnessGate !== undefined) {
      patch.loudness_gate_enabled = this.configuredLoudnessGate
    }

    return patch
  }

  /**
   * Reset all requirements to off. Called during cleanup.
   */
  public reset(): void {
    this.localWantsPcm = false
    this.localWantsLc3 = false
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
