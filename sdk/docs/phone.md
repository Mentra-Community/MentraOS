# `session.phone`

Phone device-state APIs for miniapps — incoming notifications, calendar
snapshots, and phone battery. Sub-namespaced by concern:

```
session.phone.notifications.{on, onDismissed, hasPermission, stop}
session.phone.calendar.{listEvents, hasPermission}
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

const {events, truncated} = await session.phone.calendar.listEvents({
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  limit: 50,
})
for (const event of events) console.log(`${event.title} @ ${event.startsAt}`)
console.log({truncated})

const unsubBattery = session.phone.onBattery((b) => {
  console.log(`phone: ${b.level}% ${b.charging ? "(charging)" : ""}`)
})

// teardown
session.phone.notifications.stop()  // unsubs from notif + dismissed
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
  "permissions": [
    {"type": "READ_NOTIFICATIONS"},
    {"type": "CALENDAR"}
  ]
}
```

Calls made without the matching manifest permission are rejected by the
phone runtime with `PERMISSION_NOT_DECLARED`. Required permissions are
requested by the Mentra App before opening the miniapp.

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

Request a current snapshot of phone calendar events. This is an imperative
read, not a subscription; call it again when the UI opens or the user refreshes.

#### `hasPermission` — `boolean`

True iff `CALENDAR` is declared in the miniapp's manifest. Synchronous;
reads the cached manifest record populated at `CONNECT_ACK`.

#### `listEvents(options)` — `Promise<CalendarListResult>`

Lists events from all event calendars in the requested window. The window may
not exceed 31 days. `limit` defaults to 50 and must be between 1 and 100.

```ts
interface CalendarListOptions {
  startsAt: string | Date
  endsAt: string | Date
  limit?: number
}

interface CalendarEvent {
  /** Unique occurrence id, including recurring instances. */
  id: string
  calendarId: string
  title: string
  startsAt: string
  endsAt: string
  timezone?: string
  allDay: boolean
  location?: string
  notes?: string
  url?: string
  /** Deduplicated HTTPS links found in url, location, and notes. */
  links: string[]
}

interface CalendarListResult {
  events: CalendarEvent[]
  truncated: boolean
}
```

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

**Returns:** `UnsubscribeFn`. Not tracked by `phone.notifications.stop()` —
call the returned unsubscribe directly.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | Phone runtime, surfaced via `session.on("error", ...)` / `session.permissions.onPermissionError(...)` | A subscription or request requires a permission the miniapp's `miniapp.json` does not declare. |
| `PERMISSION_DENIED` | `calendar.listEvents()` rejection | Calendar access was revoked or is otherwise unavailable at request time. |
| `INVALID_ARGUMENT` | `calendar.listEvents()` rejection | Dates, range, or limit are invalid. |

Subscriptions on this module do not throw synchronously — rejections are
async, delivered as session-level error events.

---

## Platform notes

- **Android:** Full support for all sub-modules. `notifications.onDismissed`
  fires when the user clears or swipes a notification.
- **iOS:** `notifications.on`, `calendar.listEvents`, and `onBattery` all work.
  `notifications.onDismissed` accepts the subscription but never delivers
  events (Apple privacy restriction).

---

## Wire-level reference

Calendar reads use a request; notifications and battery use streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `notifications.on` | `PHONE_NOTIFICATION` | `PhoneNotificationData` |
| `notifications.onDismissed` | `PHONE_NOTIFICATION_DISMISSED` | `NotificationDismissedData` |
| `onBattery` | `PHONE_BATTERY` | `BatteryData` |

| Request | Wire type | Result |
| --- | --- | --- |
| `calendar.listEvents` | `miniapp_calendar_list_events` | `CalendarListResult` |

---

## Tests

Wire, mock transport, SDK request, validation, and link-extraction behavior
have unit coverage in the Miniapp SDK and engine packages.
