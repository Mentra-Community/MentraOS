import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {StreamStartRequest, StreamStatusEvent} from "@mentra/bluetooth-sdk/internal"
import {acquireGlassesHotspot} from "./GlassesHotspotLease"
import {pcmToBase64} from "../utils/pcmToBase64"

export interface RelayOptions {
  streamId: string
  ingestUrl: string
  video?: StreamStartRequest["video"]
  audio?: StreamStartRequest["audio"]
  captureAudio?: boolean
  sound?: boolean
}

interface NativeRelayEvent {
  attemptId: string
  state: string
  reason: string
}
interface NativeRelay {
  prepare(options: {
    attemptId: string
    ingestUrl: string
    ssid: string
    password: string
    gatewayAddress?: string
    captureAudio: boolean
    audioTransport: "whip" | "ble-lc3" | "none"
    bitrate: number
  }): Promise<string>
  stop(attemptId: string): Promise<void>
  pushOutgoingPcm?(attemptId: string, base64: string, sampleRate: number, channels: number): boolean
  addListener(event: "onRelayState", listener: (event: NativeRelayEvent) => void): {remove(): void}
}

export interface RelayDependencies {
  native: NativeRelay
  hotspot(enabled: boolean): Promise<{state: string; ssid?: string; password?: string; localIp?: string}>
  startGlasses(request: StreamStartRequest): Promise<StreamStatusEvent | undefined>
  stopGlasses(): Promise<unknown>
  deferredStop(): void
  connected(): boolean
  sleep(ms: number): Promise<void>
  now(): number
  acquire(): () => void
  /** Present only on hosts that can pin and decode the glasses' BLE microphone, as ACS does. */
  microphone?: {
    acquire(): () => void
    subscribe(listener: (event: {pcm?: ArrayBuffer; sampleRate?: number; source?: string}) => void): {remove(): void}
  }
}

export interface ManagedRelay {
  start(): Promise<StreamStatusEvent | undefined>
  cancel(): void
  stop(): Promise<void>
  owns(streamId: string): boolean
  handleGlassesStatus(event: StreamStatusEvent): void
}

/** One attempt at a time; video stays native. All retries unwind both peers, mic and hotspot. */
export class ManagedWebRtcRelay implements ManagedRelay {
  private cancelled = false
  private started = false
  private attempt = 0
  private attemptId: string | null = null
  private attemptError: Error | null = null
  private hotspotTouched = false
  private nativeTouched = false
  private glassesTouched = false
  private release: (() => void) | null = null
  private listener: {remove(): void} | null = null
  private operation: Promise<unknown> = Promise.resolve()
  private restarting = false
  private retries = 0
  private readyAt: number | null = null
  private stopping: Promise<void> | null = null
  private releaseMic: (() => void) | null = null
  private micListener: {remove(): void} | null = null

  constructor(
    private readonly options: RelayOptions,
    private readonly onStatus: (status: string, reason: string) => void,
    private readonly onFailure: (error: Error) => void,
    private readonly deps: RelayDependencies,
  ) {}

  start(): Promise<StreamStatusEvent | undefined> {
    if (this.started) return Promise.reject(new Error("Relay already started"))
    this.started = true
    this.release = this.deps.acquire()
    this.listener = this.deps.native.addListener("onRelayState", (event) => {
      if (event.attemptId !== this.attemptId || this.cancelled) return
      if (event.state === "failed") this.failed(new Error(event.reason))
      else this.onStatus(event.state, event.reason)
    })
    const start = this.startAttempt()
    this.operation = start
    return start
  }

  cancel(): void {
    this.cancelled = true
  }

  owns(streamId: string): boolean {
    // Consume late status from all attempts without allowing it to affect the current attempt.
    return streamId.startsWith(`${this.options.streamId}-relay-`)
  }

  handleGlassesStatus(event: StreamStatusEvent): void {
    if (event.streamId !== this.attemptId || this.cancelled) return
    if (event.status === "stopped" || event.terminal) {
      this.failed(new Error("Glasses publisher stopped"))
    }
  }

  private checkpoint(): void {
    if (this.cancelled) throw new Error("Relay cancelled")
    if (this.attemptError) throw this.attemptError
  }

  private async startAttempt(): Promise<StreamStatusEvent | undefined> {
    this.attemptId = `${this.options.streamId}-relay-${++this.attempt}`
    this.attemptError = null
    this.checkpoint()
    const captureAudio = this.options.captureAudio !== false
    const lc3 = captureAudio && !!this.deps.microphone && typeof this.deps.native.pushOutgoingPcm === "function"
    // Claim through the same policy/ownership layer as ACS before turning off WHIP audio.
    if (lc3) this.releaseMic = this.deps.microphone!.acquire()
    this.hotspotTouched = true // A timed-out BLE command may still have enabled the AP.
    const hotspot = await this.deps.hotspot(true)
    this.checkpoint()
    if (hotspot.state !== "enabled" || !hotspot.ssid || !hotspot.password)
      throw new Error("Glasses hotspot did not start")
    await this.deps.sleep(3_000) // Same beacon/DHCP startup allowance as ACS.
    this.checkpoint()
    this.nativeTouched = true
    const url = await this.deps.native.prepare({
      attemptId: this.attemptId,
      ingestUrl: this.options.ingestUrl,
      ssid: hotspot.ssid,
      password: hotspot.password,
      gatewayAddress: hotspot.localIp,
      captureAudio,
      audioTransport: lc3 ? "ble-lc3" : captureAudio ? "whip" : "none",
      bitrate: this.options.video?.bitrate ?? 2_000_000,
    })
    this.checkpoint()
    if (lc3) {
      const id = this.attemptId
      let received = false
      this.micListener = this.deps.microphone!.subscribe((event) => {
        if (this.cancelled || this.attemptId !== id || this.attemptError) return
        if (event.source !== "glasses") {
          this.failed(new Error("Managed stream lost the glasses microphone"))
          return
        }
        if (!event.pcm?.byteLength) return
        try {
          const accepted = this.deps.native.pushOutgoingPcm!(id, pcmToBase64(event.pcm), event.sampleRate ?? 16000, 1)
          if (accepted && !received) {
            received = true
            console.log("[ManagedRelay] First BLE LC3 audio frame", {
              attemptId: id,
              sampleRate: event.sampleRate ?? 16000,
            })
          }
        } catch (error) {
          this.failed(asError(error))
        }
      })
    }
    this.glassesTouched = true
    const result = await this.deps.startGlasses({
      type: "start_stream",
      streamId: this.attemptId,
      streamUrl: url,
      ice: {stun: ""},
      sound: this.options.sound ?? true,
      captureAudio: captureAudio && !lc3,
      ...(this.options.video !== undefined ? {video: this.options.video} : {}),
      ...(this.options.audio !== undefined ? {audio: this.options.audio} : {}),
    })
    this.checkpoint()
    this.readyAt = this.deps.now()
    return result
  }

  private failed(error: Error): void {
    if (this.cancelled || this.attemptError) return
    this.attemptError = error
    // Bound consecutive trouble, not the lifetime number of recoveries in a long stream.
    if (this.readyAt !== null && this.deps.now() - this.readyAt >= 60_000) this.retries = 0
    this.readyAt = null
    if (this.restarting) return
    this.restarting = true
    // Await startup before cleanup: late native/BLE success still belongs to this attempt.
    this.operation = this.operation
      .catch(() => undefined)
      .then(async () => {
        while (!this.cancelled) {
          try {
            await this.cleanupAttempt()
            if (this.cancelled) return
            if (this.retries >= 3) throw error
            this.onStatus("reconnecting", error.message)
            await this.deps.sleep(1_000 * 2 ** this.retries++)
            if (this.cancelled) return
            await this.startAttempt()
            this.onStatus("reconnected", "Glasses relay restarted")
            return
          } catch (failure) {
            // Cleanup failure retains ownership; never create another stream on uncertain state.
            if (this.hotspotTouched || this.nativeTouched || this.glassesTouched) {
              try {
                await this.cleanupAttempt()
              } catch (cleanupError) {
                if (!this.cancelled) this.onFailure(asError(cleanupError))
                return
              }
            }
            if (this.retries >= 3) {
              if (!this.cancelled) this.onFailure(asError(failure))
              return
            }
          }
        }
      })
      .finally(() => {
        this.restarting = false
      })
  }

  stop(): Promise<void> {
    this.cancel()
    if (this.stopping) return this.stopping
    this.listener?.remove()
    this.listener = null
    this.stopping = this.operation
      .catch(() => undefined)
      .then(async () => {
        await this.cleanupAttempt()
        this.release?.()
        this.release = null
      })
      .finally(() => {
        this.stopping = null
      })
    return this.stopping
  }

  private async cleanupAttempt(): Promise<void> {
    const failures: unknown[] = []
    const step = async (action: () => Promise<void>) => {
      try {
        await action()
      } catch (error) {
        failures.push(error)
      }
    }
    // Invalidate callbacks before intentionally stopping the glasses or dropping the network.
    const id = this.attemptId
    this.attemptId = null
    await step(async () => {
      this.micListener?.remove()
      this.micListener = null
      this.releaseMic?.()
      this.releaseMic = null
    })
    if (this.glassesTouched)
      await step(async () => {
        if (this.deps.connected()) await this.deps.stopGlasses()
        else this.deps.deferredStop()
        this.glassesTouched = false
      })
    if (this.nativeTouched && id)
      await step(async () => {
        await this.deps.native.stop(id)
        this.nativeTouched = false
      })
    if (this.hotspotTouched)
      await step(async () => {
        if (this.deps.connected()) {
          const result = await this.deps.hotspot(false)
          if (result.state !== "disabled") throw new Error("Glasses hotspot shutdown was not confirmed")
        } else this.deps.deferredStop()
        this.hotspotTouched = false
      })
    if (failures.length) {
      this.attemptId = id // Retain the native attempt token for a subsequent cleanup retry.
      throw new Error(`Relay cleanup failed: ${failures.map((error) => asError(error).message).join("; ")}`)
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function createManagedWebRtcRelay(
  options: RelayOptions,
  onStatus: (status: string, reason: string) => void,
  onFailure: (error: Error) => void,
  connected: () => boolean,
  deferredStop: () => void,
): ManagedRelay {
  // Load only for managed WHIP. Hosts using direct SRT/RTMP need no relay module.
  const {requireNativeModule} = require("expo-modules-core") as typeof import("expo-modules-core")
  const {BgTimer} = require("../utils/timers") as typeof import("../utils/timers")
  const native = requireNativeModule<NativeRelay>("MentraGlassesMediaRelay")
  const {Platform} = require("react-native") as typeof import("react-native")
  const {default: micSessionManager} = require("./MicSessionManager") as typeof import("./MicSessionManager")
  return new ManagedWebRtcRelay(options, onStatus, onFailure, {
    native,
    hotspot: (enabled) => BluetoothSdk.setHotspotState(enabled),
    startGlasses: (request) => BluetoothSdk.startStream(request),
    stopGlasses: () => BluetoothSdk.stopStream(),
    connected,
    deferredStop,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => BgTimer.setTimeout(resolve, ms)),
    acquire: acquireGlassesHotspot,
    ...(Platform.OS === "android" && typeof BluetoothSdk.setMicSourcePin === "function"
      ? {
          microphone: {
            acquire: () =>
              micSessionManager.acquire({
                owner: `engine:managed-relay:${options.streamId}`,
                source: "glasses",
                useCase: "livestream",
              }).release,
            subscribe: (listener) => BluetoothSdk.addListener("mic_pcm", listener),
          },
        }
      : {}),
  })
}
