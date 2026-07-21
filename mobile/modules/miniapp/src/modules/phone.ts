/**
 * @fileoverview PhoneModule — phone device-state events.
 *
 * Mirrors cloud SDK v3's PhoneManager structure. Sub-namespaced by concern:
 *
 *   session.phone.notifications.{on, hasPermission, stop}
 *   session.phone.calendar.{listEvents, hasPermission}
 *   session.phone.onBattery(...)                          // stays flat
 *
 * Imperative phone-OS calls (share, openUrl, copyToClipboard, download) live
 * on `session.system` — different shape (one-shot calls vs. event subs) so
 * we don't conflate them.
 *
 * `phone.notifications.onDismissed` is Android-only. iOS doesn't expose
 * notification-dismiss callbacks to apps (Apple privacy restriction);
 * subscribing on iOS is a no-op even though the API is present.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {BatteryData, NotificationDismissedData, PhoneNotificationData, UnsubscribeFn} from "./events"

class TrackedSubs {
  private readonly unsubs = new Set<UnsubscribeFn>()

  protected track(unsub: UnsubscribeFn): UnsubscribeFn {
    this.unsubs.add(unsub)
    return () => {
      this.unsubs.delete(unsub)
      unsub()
    }
  }

  stop(): void {
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.clear()
  }
}

export class PhoneNotificationsModule extends TrackedSubs {
  constructor(private readonly session: MiniappSession) {
    super()
  }

  on(handler: (data: PhoneNotificationData) => void): UnsubscribeFn {
    return this.track(this.session._subscribe(MiniappStreamType.PHONE_NOTIFICATION, handler as (data: unknown) => void))
  }

  /**
   * Subscribe to dismiss events for phone notifications. Fires when the user
   * dismisses (swipes away or clears) a notification.
   *
   * **Android only.** iOS does not expose dismiss callbacks to apps (Apple
   * privacy restriction); subscribing on iOS succeeds but no events ever
   * fire. The matching `notifications.on()` post-event still works on both
   * platforms.
   */
  onDismissed(handler: (data: NotificationDismissedData) => void): UnsubscribeFn {
    return this.track(
      this.session._subscribe(MiniappStreamType.PHONE_NOTIFICATION_DISMISSED, handler as (data: unknown) => void),
    )
  }

  /** True iff `READ_NOTIFICATIONS` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("READ_NOTIFICATIONS")
  }
}

export interface CalendarListOptions {
  /** Inclusive start of the query window. */
  startsAt: string | Date
  /** Exclusive end of the query window. Must be after startsAt. */
  endsAt: string | Date
  /** Maximum events to return. Defaults to 50 and may not exceed 100. */
  limit?: number
}

export interface CalendarEvent {
  /** Stable occurrence id, unique across calendars and recurring instances. */
  id: string
  calendarId: string
  title: string
  /** ISO 8601 start time. All-day events preserve their calendar timezone offset. */
  startsAt: string
  /** ISO 8601 end time. All-day events preserve their calendar timezone offset. */
  endsAt: string
  timezone?: string
  allDay: boolean
  location?: string
  notes?: string
  url?: string
  /** Deduplicated HTTPS links found in the event URL, location, and notes. */
  links: string[]
}

export interface CalendarListResult {
  events: CalendarEvent[]
  /** True when more matching events existed than the requested limit. */
  truncated: boolean
}

export class PhoneCalendarModule {
  constructor(private readonly session: MiniappSession) {}

  /**
   * Read calendar events in a bounded window. CALENDAR must be declared in
   * miniapp.json and granted before the miniapp opens.
   */
  listEvents(options: CalendarListOptions): Promise<CalendarListResult> {
    const startsAt = normalizeCalendarDate(options?.startsAt, "startsAt")
    const endsAt = normalizeCalendarDate(options?.endsAt, "endsAt")
    return this.session.sendRequest<CalendarListResult>({
      type: MiniappRequestType.CALENDAR_LIST_EVENTS,
      startsAt,
      endsAt,
      ...(options.limit === undefined ? {} : {limit: options.limit}),
    })
  }

  /** True iff `CALENDAR` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("CALENDAR")
  }
}

function normalizeCalendarDate(value: string | Date | undefined, field: string): string {
  const date = value instanceof Date ? value : new Date(value ?? "")
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid Date or ISO 8601 string`)
  return date.toISOString()
}

export class PhoneModule {
  public readonly notifications: PhoneNotificationsModule
  public readonly calendar: PhoneCalendarModule

  constructor(private readonly session: MiniappSession) {
    this.notifications = new PhoneNotificationsModule(session)
    this.calendar = new PhoneCalendarModule(session)
  }

  /**
   * Phone battery events. Stays flat (not sub-namespaced) — single event,
   * no extra surface.
   */
  onBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.PHONE_BATTERY, handler as (data: unknown) => void)
  }
}
