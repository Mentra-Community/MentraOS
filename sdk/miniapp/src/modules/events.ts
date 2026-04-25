/**
 * @fileoverview EventManager — subscribes to glasses / phone / cloud streams.
 *
 * Each `onXxx(handler)` method:
 *   1. Adds the handler to a local EventEmitter.
 *   2. If this is the first handler for a stream, sends a SUBSCRIBE request
 *      over the bridge with the full current subscription list.
 *   3. Returns an unsubscribe function. Last handler removed → send SUBSCRIBE
 *      with the shortened list.
 *
 * The phone (LocalMiniappRuntime) de-dupes and aggregates subscriptions across
 * all running miniapps, so multiple miniapps asking for the same stream result
 * in one upstream subscription.
 */

import {EventEmitter} from "eventemitter3"

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"

export type UnsubscribeFn = () => void

export interface TranscriptionData {
  text: string
  isFinal: boolean
  language?: string
}

export interface TranslationData {
  text: string
  isFinal: boolean
  sourceLanguage: string
  targetLanguage: string
}

export interface ButtonPressData {
  buttonId: string
  pressType: "short" | "long"
}

export interface HeadPositionData {
  position: "up" | "down"
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

export interface CalendarEventData {
  eventId: string
  title: string
  /** ISO 8601 start time. */
  dtStart: string
  /** ISO 8601 end time. */
  dtEnd: string
  timezone: string
  allDay: boolean
  location: string
  notes: string
  calendarId: string
}

export interface VadData {
  /** True while the user is speaking (voice detected), false when silent. */
  status: boolean
}

export interface TouchData {
  kind: "click" | "double_click" | "scroll_top" | "scroll_bottom" | string
}

export interface AudioChunkData {
  /** PCM or LC3, base64-encoded. Format depends on phone's mic mode. */
  data: string
  sampleRate?: number
  format?: string
}

export class EventManager {
  private readonly emitter = new EventEmitter()
  /** Stream -> ref count. Outbound SUBSCRIBE is sent when refs transition 0↔1. */
  private readonly refCounts = new Map<string, number>()

  constructor(private readonly session: MiniappSession) {}

  // ------------------------------------------------------------------
  // High-level typed helpers
  // ------------------------------------------------------------------

  /**
   * Subscribe to live transcription.
   *
   * By default subscribes to `transcription:auto` — the cloud auto-detects
   * the spoken language and delivers transcripts in whatever was detected.
   * The resulting `data.transcribeLanguage` field tells you what it detected.
   *
   * Pass a BCP-47 language tag (e.g. `"en-US"`, `"fr-FR"`) to pin a specific
   * language.
   */
  onTranscription(
    handler: (data: TranscriptionData) => void,
    language: string = "auto",
  ): UnsubscribeFn {
    return this.subscribe(`${MiniappStreamType.TRANSCRIPTION}:${language}`, handler as (data: unknown) => void)
  }

  onTranslation(fromLang: string, toLang: string, handler: (data: TranslationData) => void): UnsubscribeFn {
    return this.subscribe(
      `${MiniappStreamType.TRANSLATION}:${fromLang}:${toLang}`,
      handler as (data: unknown) => void,
    )
  }

  onButtonPress(handler: (data: ButtonPressData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.BUTTON_PRESS, handler as (data: unknown) => void)
  }

  onTouch(handler: (data: TouchData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.TOUCH_EVENT, handler as (data: unknown) => void)
  }

  onHeadPosition(handler: (data: HeadPositionData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.HEAD_POSITION, handler as (data: unknown) => void)
  }

  onLocation(handler: (data: LocationData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.LOCATION_UPDATE, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to live compass heading from the phone's magnetometer
   * (Android only). Fires whenever the phone rotates more than ~1°.
   */
  onHeading(handler: (data: HeadingData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.HEADING_UPDATE, handler as (data: unknown) => void)
  }

  onGlassesBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.GLASSES_BATTERY, handler as (data: unknown) => void)
  }

  onPhoneBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.PHONE_BATTERY, handler as (data: unknown) => void)
  }

  onGlassesConnection(handler: (data: ConnectionData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.GLASSES_CONNECTION, handler as (data: unknown) => void)
  }

  onPhoneNotification(handler: (data: PhoneNotificationData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.PHONE_NOTIFICATION, handler as (data: unknown) => void)
  }

  onCalendarEvent(handler: (data: CalendarEventData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.CALENDAR_EVENT, handler as (data: unknown) => void)
  }

  onVoiceActivity(handler: (data: VadData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.VAD, handler as (data: unknown) => void)
  }

  onAudioChunk(handler: (data: AudioChunkData) => void): UnsubscribeFn {
    return this.subscribe(MiniappStreamType.AUDIO_CHUNK, handler as (data: unknown) => void)
  }

  // ------------------------------------------------------------------
  // Low-level generic subscribe (escape hatch)
  // ------------------------------------------------------------------

  /**
   * Generic subscribe. `stream` is the raw wire value, including any language
   * suffix like `"transcription:en-US"`.
   */
  subscribe(stream: string, handler: (data: unknown) => void): UnsubscribeFn {
    this.emitter.on(stream, handler)
    const before = this.refCounts.get(stream) ?? 0
    this.refCounts.set(stream, before + 1)
    if (before === 0) {
      this.sendSubscriptionUpdate()
    }
    return () => {
      this.emitter.off(stream, handler)
      const current = this.refCounts.get(stream) ?? 0
      if (current <= 1) {
        this.refCounts.delete(stream)
        this.sendSubscriptionUpdate()
      } else {
        this.refCounts.set(stream, current - 1)
      }
    }
  }

  /** Unsubscribe every handler on every stream this EventManager owns. */
  unsubscribeAll(): void {
    this.emitter.removeAllListeners()
    this.refCounts.clear()
    this.sendSubscriptionUpdate()
  }

  // ------------------------------------------------------------------
  // Internal — called by MiniappSession when EVENT arrives from phone
  // ------------------------------------------------------------------

  /** @internal */
  _forwardEvent(stream: string, data: unknown): void {
    this.emitter.emit(stream, data)

    // Wildcard fan-out: a handler subscribed to "transcription:auto" should
    // receive any "transcription:<lang>" event. The detected language is in
    // data.transcribeLanguage. Same for translation.
    if (stream.startsWith("transcription:") && stream !== "transcription:auto") {
      this.emitter.emit("transcription:auto", data)
    } else if (stream.startsWith("translation:") && stream !== "translation:auto") {
      this.emitter.emit("translation:auto", data)
    }
  }

  private sendSubscriptionUpdate(): void {
    this.session.sendOneShot({
      type: MiniappRequestType.SUBSCRIBE,
      subscriptions: Array.from(this.refCounts.keys()),
    })
  }
}
