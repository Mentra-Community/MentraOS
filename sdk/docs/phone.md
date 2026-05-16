# `session.phone`

Phone device-state event streams for miniapps — incoming notifications,
calendar events, and phone battery. Sub-namespaced by concern:

```
session.phone.notifications.{on, onDismissed, hasPermission, stop}
session.phone.calendar.{on, hasPermission, stop}
session.phone.onBattery(...)                          // stays flat
```

Imperative phone-OS calls (share, openUrl, copyToClipboard, download)
live on `session.system` — different shape (one-shot calls vs. event
subs) so they aren't conflated with this module.

> **Platform note:** `phone.notifications.onDismissed` is Android-only.
> iOS doesn't expose notification-dismiss callbacks to apps (Apple
> privacy restriction); subscribing on iOS succeeds but no events ever
> fire. The matching `notifications.on()` post-event still works on both
> platforms.

Source: [mobile/modules/miniapp/src/modules/phone.ts](../../mobile/modules/miniapp/src/modules/phone.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsubNotif = session.phone.notifications.on((data) => {
  console.log(`[${data.app}] ${data.title}: ${data.content}`)
})

const unsubDismissed = session.phone.notifications.onDismissed((data) => {
  console.log("dismissed:", data.notificationId)
})

const unsubCal = session.phone.calendar.on((event) => {
  console.log(`${event.title} @ ${event.dtStart}`)
})

const unsubBattery = session.phone.onBattery((b) => {
  console.log(`phone: ${b.level}% ${b.charging ? "(charging)" : ""}`)
})

// teardown
session.phone.notifications.stop()  // unsubs from notif + dismissed
session.phone.calendar.stop()
unsubBattery()
```

---

## Manifest

Sub-modules gate on manifest permissions:

| Sub-module | Required manifest permission |
| --- | --- |
| `phone.notifications` | `READ_NOTIFICATIONS` |
| `phone.calendar` | `CALENDAR` |
| `phone.onBattery` | none |

Manifest entries map onto canonical keys per `session.permissions`:
`READ_NOTIFICATIONS` and `POST_NOTIFICATIONS` both satisfy `notifications`.

```json
{
  "permissions": ["READ_NOTIFICATIONS", "CALENDAR"]
}
```

Subscriptions made without the matching manifest permission are rejected
by the phone runtime with `PERMISSION_NOT_DECLARED` (delivered async via
the session `"error"` event — see `session.permissions.onPermissionError`).

---

## API

### `session.phone.notifications`

Phone notification post + dismiss events.

#### `hasPermission` — `boolean`

True iff `READ_NOTIFICATIONS` is declared in the miniapp's manifest.
Synchronous; reads the cached manifest record populated at `CONNECT_ACK`.

#### `on(handler)` — `UnsubscribeFn`

Subscribe to new phone notifications. Fires when the phone's notification
listener emits a post event.

**Handler signature:** `(data: PhoneNotificationData) => void`

```ts
interface PhoneNotificationData {
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
```

**Returns:** `UnsubscribeFn` — also tracked by the module so `stop()` will
clean it up.

#### `onDismissed(handler)` — `UnsubscribeFn`

Subscribe to dismiss events for phone notifications. Fires when the user
dismisses (swipes away or clears) a notification.

**Android only.** iOS does not expose dismiss callbacks to apps (Apple
privacy restriction); subscribing on iOS succeeds but no events ever
fire. The matching `notifications.on()` post-event still works on both
platforms.

**Handler signature:** `(data: NotificationDismissedData) => void`

```ts
interface NotificationDismissedData {
  /** Same id as the matching post event from `notifications.on(...)`. */
  notificationId: string
  /** Android NotificationKey. More stable than notificationId across reposts. */
  notificationKey?: string
  /** Reverse-DNS package/bundle id of the originating app. */
  packageName?: string
  /** Unix ms timestamp of the dismissal. */
  timestamp: number
}
```

**Returns:** `UnsubscribeFn`.

#### `stop()` — `void`

Tear down every subscription owned by `phone.notifications` (both `on()`
and `onDismissed()` registrations).

---

### `session.phone.calendar`

Phone calendar event stream.

#### `hasPermission` — `boolean`

True iff `CALENDAR` is declared in the miniapp's manifest. Synchronous;
reads the cached manifest record populated at `CONNECT_ACK`.

#### `on(handler)` — `UnsubscribeFn`

Subscribe to calendar events delivered by the phone.

**Handler signature:** `(data: CalendarEventData) => void`

```ts
interface CalendarEventData {
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
```

**Returns:** `UnsubscribeFn` — also tracked by the module so `stop()` will
clean it up.

#### `stop()` — `void`

Tear down every subscription owned by `phone.calendar`.

---

### `onBattery(handler)` — `UnsubscribeFn`

Subscribe to phone battery events. Stays flat (not sub-namespaced) —
single event, no extra surface.

**Handler signature:** `(data: BatteryData) => void`

```ts
interface BatteryData {
  level: number
  charging: boolean
}
```

**Returns:** `UnsubscribeFn`. Not tracked by `phone.notifications.stop()`
/ `phone.calendar.stop()` — call the returned unsubscribe directly.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | Phone runtime, surfaced via `session.on("error", ...)` / `session.permissions.onPermissionError(...)` | A subscription requires a manifest permission the miniapp's `manifest.json` does not declare (e.g. subscribing to `phone_notification` without `READ_NOTIFICATIONS`). |

Subscriptions on this module do not throw synchronously — rejections are
async, delivered as session-level error events.

---

## Platform notes

- **Android:** Full support for all sub-modules. `notifications.onDismissed`
  fires when the user clears or swipes a notification.
- **iOS:** `notifications.on`, `calendar.on`, and `onBattery` all work.
  `notifications.onDismissed` accepts the subscription but never delivers
  events (Apple privacy restriction).

---

## Wire-level reference

This module emits no requests. It only subscribes to streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `notifications.on` | `PHONE_NOTIFICATION` | `PhoneNotificationData` |
| `notifications.onDismissed` | `PHONE_NOTIFICATION_DISMISSED` | `NotificationDismissedData` |
| `calendar.on` | `CALENDAR_EVENT` | `CalendarEventData` |
| `onBattery` | `PHONE_BATTERY` | `BatteryData` |

---

## Tests

_No integration tests yet._
