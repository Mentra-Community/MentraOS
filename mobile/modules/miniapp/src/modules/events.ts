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
 *   - session.phone.onNotification(...) / onCalendarEvent(...) / onBattery(...)
 *
 * This module's only public method is `subscribe(rawStreamType, handler)` —
 * a forward-compat escape hatch for new event types not yet wrapped on a
 * domain module. Officially undocumented; the typed methods on domain
 * modules are the canonical surface.
 *
 * Internally, EventManager owns:
 *   1. The ref-count map. Outbound SUBSCRIBE is only sent when a stream's
 *      ref count transitions 0↔1, so multiple components listening for the
 *      same stream issue one wire-level subscribe.
 *   2. Inbound event fan-out via `_forwardEvent(streamType, data)`, called
 *      by MiniappSession.handleIncoming when an EVENT envelope arrives.
 *
 * Domain modules call back into the session via session._subscribe(...) which
 * in turn delegates to this class — the session is the integration point;
 * domain modules don't see this class directly.
 */

import {EventEmitter} from "eventemitter3"

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type UnsubscribeFn = () => void

// ---------------------------------------------------------------------------
// Shared event data shapes — re-exported by index.ts so consumers can type
// their handlers without importing this internal module.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class EventManager {
  private readonly emitter = new EventEmitter()
  /** Stream -> ref count. Outbound SUBSCRIBE is sent when refs transition 0↔1. */
  private readonly refCounts = new Map<string, number>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Generic subscribe. `stream` is the raw wire value, including any language
   * suffix like `"transcription:en-US"`. Forward-compat escape hatch for new
   * event types not yet wrapped on a domain module. Most authors should use
   * typed methods on domain modules instead.
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

  // -------------------------------------------------------------------------
  // Internal — called by MiniappSession when EVENT arrives from phone
  // -------------------------------------------------------------------------

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
