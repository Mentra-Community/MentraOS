/**
 * @fileoverview PhoneModule — phone device-state events.
 *
 * Mirrors cloud SDK v3's PhoneManager structure. Sub-namespaced by concern:
 *
 *   session.phone.notifications.{on, hasPermission, stop}
 *   session.phone.calendar.{on, hasPermission, stop}
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

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {
  BatteryData,
  CalendarEventData,
  NotificationDismissedData,
  PhoneNotificationData,
  UnsubscribeFn,
} from "./events"

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
    return this.track(
      this.session._subscribe(MiniappStreamType.PHONE_NOTIFICATION, handler as (data: unknown) => void),
    )
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
      this.session._subscribe(
        MiniappStreamType.PHONE_NOTIFICATION_DISMISSED,
        handler as (data: unknown) => void,
      ),
    )
  }

  /** True iff `READ_NOTIFICATIONS` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("READ_NOTIFICATIONS")
  }
}

export class PhoneCalendarModule extends TrackedSubs {
  constructor(private readonly session: MiniappSession) {
    super()
  }

  on(handler: (data: CalendarEventData) => void): UnsubscribeFn {
    return this.track(
      this.session._subscribe(MiniappStreamType.CALENDAR_EVENT, handler as (data: unknown) => void),
    )
  }

  /** True iff `CALENDAR` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("CALENDAR")
  }
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
