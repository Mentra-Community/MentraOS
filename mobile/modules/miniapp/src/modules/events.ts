/**
 * @fileoverview EventManager — internal subscription registry + escape hatch.
 *
 * Most miniapp authors should NOT touch this directly. Use the typed methods
 * on domain modules instead:
 *   - session.transcription.on(...)
 *   - session.mic.onAudioChunk(...) / onVoiceActivity(...)
 *   - session.input.onButtonPress(...)
 *   - session.imu.onHeadPosition(...)
 *   - session.location.onUpdate(...)
 *   - session.glasses.onBattery(...) / onConnection(...)
 *   - session.phone.notifications.on(...) / session.phone.onBattery(...)
 *
 * This module's only public method is `subscribe(rawStreamType, handler)` —
 * a forward-compat escape hatch for new event types not yet wrapped on a
 * domain module. Officially undocumented; the typed methods on domain
 * modules are the canonical surface.
 *
 * Internally, EventManager owns:
 *   1. The ref-count map deduplicates upstream stream demand. Transcription
 *      updates also carry private listener identities, so the runtime can
 *      preserve a separate content boundary for each handler.
 *   2. Inbound event fan-out via `_forwardEvent(streamType, data)`, called
 *      by MiniappSession.handleIncoming when an EVENT envelope arrives.
 *
 * Domain modules call back into the session via session._subscribe(...) which
 * in turn delegates to this class — the session is the integration point;
 * domain modules don't see this class directly.
 */

import {EventEmitter} from "eventemitter3"

import {makeRequestId} from "../envelope"
import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import {resolveSpeechProcessing, type SpeechProcessing, type SpeechProcessingOptions} from "./speechProcessing"

export type UnsubscribeFn = () => void

/**
 * @internal Delivery class the host tags a transcription event with. Hosts
 * address each event to the listeners that should get it; SDKs from before
 * `processing` filter on this tag instead: `"forceLocal"` reaches `localOnly`
 * listeners, `"default"` the others, `"all"` everyone.
 */
export type TranscriptionEventRoute = "default" | "forceLocal" | "all"

// ---------------------------------------------------------------------------
// Shared event data shapes — re-exported by index.ts so consumers can type
// their handlers without importing this internal module.
// ---------------------------------------------------------------------------

export interface TranscriptionData {
  text: string
  isFinal: boolean
  language?: string
  /** Where the text was transcribed: `"cloud"`, or `"local"` for the phone's on-device model. */
  source: "cloud" | "local"
}

export interface TranslationData {
  text: string
  isFinal: boolean
  sourceLanguage: string
  targetLanguage: string
  /** Source-language text of the same utterance, when the provider supplies it. */
  originalText?: string
  /** Stable id correlating interim + final results of one utterance. */
  utteranceId?: string
  /** Speaker id when the provider reports diarization. */
  speakerId?: string
}

export interface ButtonPressData {
  buttonId: string
  pressType: "short" | "long"
}

export interface HeadPositionData {
  position: "up" | "down"
}

export interface AccelData {
  /** Accelerometer axes in g (gravity-normalized). */
  x: number
  y: number
  z: number
  /** Unix ms timestamp of the reading. */
  timestamp: number
}

export interface LocationData {
  lat: number
  lng: number
  /** Accuracy in meters, if the platform reported it. */
  accuracy?: number
  /** Unix ms timestamp of the fix. */
  timestamp?: number
  /** Set when this event is a response to a single-location request. */
  correlationId?: string
}

export interface HeadingData {
  /** Compass heading in degrees, 0 = north, 90 = east. */
  degrees: number
}

export interface BatteryData {
  level: number
  charging: boolean
}

export interface ConnectionData {
  connected: boolean
  modelName?: string
}

/** Glasses Wi-Fi state. `connected` is false on glasses without Wi-Fi or when offline. */
export interface WifiData {
  /** Glasses are on Bluetooth AND on Wi-Fi — what streaming actually needs. */
  connected: boolean
  /**
   * The phone↔glasses Bluetooth link on its own. When this is false the
   * glasses may well still be on Wi-Fi; `connected` is false only because the
   * phone cannot see them. Wait for the link — do not send the user to
   * Wi-Fi setup. Absent on hosts older than the field.
   */
  linkConnected?: boolean
  ssid?: string
  localIp?: string
}

export interface PhoneNotificationData {
  /** Stable id from the phone's notification listener. */
  notificationId: string
  /** Human app name (e.g. "Messages"). */
  app: string
  title: string
  content: string
  /** Android priority string; empty on iOS. */
  priority: string
  timestamp: number
  /** Reverse-DNS package/bundle id of the originating app. */
  packageName: string
}

export interface NotificationDismissedData {
  /** Same id as the matching post event from `notifications.on(...)`. */
  notificationId: string
  /** Android NotificationKey. More stable than notificationId across reposts. */
  notificationKey?: string
  /** Reverse-DNS package/bundle id of the originating app. */
  packageName?: string
  /** Unix ms timestamp of the dismissal. */
  timestamp: number
}

export interface VadData {
  /** True while the user is speaking (voice detected), false when silent. */
  status: boolean
  /** 0 while speaking; on a silence event, how long the audio has already been silent. */
  silentForMs?: number
  /** Unix epoch milliseconds of the transition, when the host reports it. */
  timestamp?: number
}

export interface TouchData {
  /** The gesture: single_tap, double_tap, triple_tap, long_press, swipe_up, or swipe_down. */
  kind: "single_tap" | "double_tap" | "triple_tap" | "long_press" | "swipe_up" | "swipe_down" | string
}

export interface AudioChunkData {
  /** PCM or LC3, base64-encoded. Format depends on phone's mic mode. */
  data: string
  sampleRate?: number
  format?: string
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class EventManager {
  private readonly listenerScope = makeRequestId()
  private listenerSeq = 0
  private transcriptionListeners = new Map<
    string,
    {stream: string; processing: SpeechProcessing; invoke: (data: unknown, route?: TranscriptionEventRoute) => void}
  >()
  private retireListeners = new Set<() => void>()
  private readonly emitter = new EventEmitter()
  /** Stream -> ref count. Outbound SUBSCRIBE tracks active streams and routing changes. */
  private readonly refCounts = new Map<string, number>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Generic subscribe. `stream` is the raw wire value, including any language
   * suffix like `"transcription:en-US"`. Forward-compat escape hatch for new
   * event types not yet wrapped on a domain module. Most authors should use
   * typed methods on domain modules instead.
   *
   * Stream names beginning with `_` (e.g. `_ui` for the session.ui bus) are
   * INTERNAL — they ride the local _forwardEvent fan-out and never appear in
   * the outbound SUBSCRIBE list. Native already knows to deliver UI envelopes
   * via a separate envelope `type`; the EventManager only routes them
   * locally.
   *
   * `processing` applies to transcription streams only.
   */
  subscribe(stream: string, handler: (data: unknown) => void, options: SpeechProcessingOptions = {}): UnsubscribeFn {
    const isInternal = stream.startsWith("_")
    const isTranscription = stream.startsWith(`${MiniappStreamType.TRANSCRIPTION}:`)
    const processing = isTranscription ? resolveSpeechProcessing(options, "events.subscribe(options)") : "preferCloud"
    const localOnly = processing === "localOnly"
    const listenerId = isTranscription ? `${this.listenerScope}:${++this.listenerSeq}` : undefined
    let active = true
    const listener = (data: unknown, route?: TranscriptionEventRoute) => {
      if (!active) return
      if (isTranscription) {
        // The host tags every transcription event with the class it is for.
        // Hosts that predate routed transcription events omit `route`. Treat
        // those events as the cloud path so a localOnly listener can never
        // accidentally receive cloud text.
        if (localOnly ? route !== "forceLocal" && route !== "all" : route === "forceLocal") return
      }
      handler(data)
    }
    this.emitter.on(stream, listener)
    const retire = () => {
      active = false
    }
    this.retireListeners.add(retire)
    if (listenerId) this.transcriptionListeners.set(listenerId, {stream, processing, invoke: listener})
    if (!isInternal) {
      const before = this.refCounts.get(stream) ?? 0
      this.refCounts.set(stream, before + 1)
      // Every transcription listener is registered with the host by id.
      if (isTranscription || before === 0) this.sendSubscriptionUpdate()
    }
    return () => {
      if (!active) return
      retire()
      this.retireListeners.delete(retire)
      if (listenerId) this.transcriptionListeners.delete(listenerId)
      this.emitter.off(stream, listener)
      if (isInternal) return
      const current = this.refCounts.get(stream) ?? 0
      if (current <= 1) {
        this.refCounts.delete(stream)
      } else {
        this.refCounts.set(stream, current - 1)
      }
      if (isTranscription || current <= 1) this.sendSubscriptionUpdate()
    }
  }

  /** Unsubscribe every handler on every stream this EventManager owns. */
  unsubscribeAll(): void {
    for (const retire of this.retireListeners) retire()
    this.retireListeners.clear()
    this.transcriptionListeners.clear()
    this.emitter.removeAllListeners()
    this.refCounts.clear()
    this.sendSubscriptionUpdate()
  }

  // -------------------------------------------------------------------------
  // Internal — called by MiniappSession when EVENT arrives from phone
  // -------------------------------------------------------------------------

  /** @internal */
  _forwardEvent(
    stream: string,
    data: unknown,
    transcriptionRoute?: TranscriptionEventRoute,
    listenerId?: string,
  ): void {
    if (stream.startsWith(`${MiniappStreamType.TRANSCRIPTION}:`)) data = withTranscriptionSource(data)
    if (listenerId !== undefined) {
      const listener = this.transcriptionListeners.get(listenerId)
      if (listener && (listener.stream === stream || listener.stream === "transcription:auto"))
        listener.invoke(data, transcriptionRoute)
      return
    }
    this.emitter.emit(stream, data, transcriptionRoute)

    // Wildcard fan-out: handlers register under wildcard patterns
    // ("transcription:auto", "translation:*:<target>", …) but the host
    // delivers events under the CONCRETE stream key
    // ("transcription:en-US", "translation:en:es"). Re-emit on every
    // pattern the concrete key satisfies — the same pattern set
    // LocalMiniappRuntime.forwardEvent matches on the host side —
    // otherwise a wildcard subscriber never fires.
    if (stream.startsWith("transcription:") && stream !== "transcription:auto") {
      this.emitter.emit("transcription:auto", data, transcriptionRoute)
    } else if (stream.startsWith("translation:")) {
      const parts = stream.split(":")
      const patterns = new Set<string>(["translation:auto"])
      if (parts.length === 3) {
        const [, source, target] = parts
        patterns.add("translation:*:*")
        patterns.add(`translation:*:${target}`)
        patterns.add(`translation:${source}:*`)
      }
      patterns.delete(stream) // exact key already emitted above
      for (const pattern of patterns) {
        this.emitter.emit(pattern, data)
      }
    }
  }

  private sendSubscriptionUpdate(): void {
    const subscriptions: Array<string | Record<string, unknown>> = []
    for (const stream of this.refCounts.keys()) {
      if (stream === MiniappStreamType.LOCATION_UPDATE)
        subscriptions.push({stream: "location_stream", rate: "realtime"})
      else if (!stream.startsWith(`${MiniappStreamType.TRANSCRIPTION}:`)) subscriptions.push(stream)
    }
    // One entry per transcription stream and processing its listeners ask for.
    const transcription = new Set<string>()
    for (const {stream, processing} of this.transcriptionListeners.values()) {
      const key = `${processing} ${stream}`
      if (transcription.has(key)) continue
      transcription.add(key)
      subscriptions.push({stream, ...processingOnWire(processing)})
    }
    this.session.sendOneShot({
      type: MiniappRequestType.SUBSCRIBE,
      subscriptions,
      transcriptionListeners: [...this.transcriptionListeners].map(([id, {stream, processing}]) => ({
        id,
        stream,
        ...processingOnWire(processing),
      })),
    })
  }
}

/**
 * The wire form of a transcription listener's processing. Hosts before
 * `processing` (Mentra App 3.4.0) read only `forceLocal`, so `localOnly` keeps
 * sending it: there a localOnly listener still never gets cloud text.
 */
function processingOnWire(processing: SpeechProcessing): {processing: SpeechProcessing; forceLocal?: true} {
  return processing === "localOnly" ? {processing, forceLocal: true} : {processing}
}

/**
 * Hosts before `source` (Mentra App 3.4.0) leave it out. Their on-device
 * transcripts carry `type: "local_transcription"`, their cloud ones do not.
 */
function withTranscriptionSource(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data
  const event = data as {source?: unknown; type?: unknown}
  if (event.source === "cloud" || event.source === "local") return data
  return {...event, source: event.type === "local_transcription" ? "local" : "cloud"}
}
