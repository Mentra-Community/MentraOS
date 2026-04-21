# Spike: Phone Events System — SDK v3

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md), [session.device spike](./session-device-spike.md), [session.mic spike](./session-mic-spike.md)
**Status:** Spike
**Date:** 2026-03-18

---

## Overview

**What this doc covers:** The full phone events system for SDK v3 — phone notifications, notification dismissals, calendar events, and phone battery. Covers current architecture audit, the end-to-end data flow for each event type, permission gating, the cloud-side `CalendarManager`, known issues, the unified v3 `session.phone` API with sub-scoped managers, and open design questions.

**What this doc does NOT cover:** Device/glasses state (`session.device` — see [session-device-spike.md](./session-device-spike.md)), audio input/output (see `session.mic` and `session.speaker` spikes), or the broader SDK v3 migration plan (see [spike.md](./spike.md)).

**Key naming distinction:** "Phone" events are data that originates from the **user's phone** (notifications, calendar, phone battery), not from the glasses hardware. Glasses state (battery, WiFi, buttons, gestures) lives on `session.device`. Phone data lives on `session.phone`. The line is clear: if it comes from the phone's OS, it's `session.phone`. If it comes from the glasses hardware, it's `session.device`.

**Key design pattern:** `session.phone` uses **sub-scoped managers** — `session.phone.notifications` and `session.phone.calendar` are each mini-managers with their own `.on()`, `.hasPermission`, and handler tracking. This mirrors how iOS/Android organize their notification and calendar APIs as distinct subsystems, not just different event types on one bus.

---

## Current Architecture (v2)

### Phone Notifications

**SDK:** `EventManager.onPhoneNotifications()` + `EventManager.onPhoneNotificationDismissed()`
**Cloud:** No dedicated manager — relay via `relayMessageToApps()` + REST endpoints

#### Type Definitions

```typescript
interface PhoneNotification {
  type: "phone_notification"
  notificationId: string
  app: string // source app name (e.g., "Messages", "Slack")
  title: string
  content: string
  priority: "low" | "normal" | "high"
}

interface PhoneNotificationDismissed {
  type: "phone_notification_dismissed"
  notificationId: string
  app: string
  title: string
  content: string
  notificationKey: string
}
```

#### Stream Types

- `StreamType.PHONE_NOTIFICATION` = `"phone_notification"` — category: `PHONE`
- `StreamType.PHONE_NOTIFICATION_DISMISSED` = `"phone_notification_dismissed"` — category: `PHONE`

#### End-to-End Flow

**Path 1 — REST (primary, newer):**

1. Phone app → `POST /api/client/notifications` with body `{ notificationId, app, title, content, priority }`
2. Cloud (`notifications.api.ts`) validates required fields, constructs message with `type: StreamType.PHONE_NOTIFICATION`
3. Cloud calls `userSession.relayMessageToApps(notificationMessage)`:
   - Queries `subscriptionManager.getSubscribedApps("phone_notification")` for all subscribed apps
   - Wraps data in a `DataStream` envelope (`type: "data_stream"`, `streamType: "phone_notification"`)
   - Sends over each app's WebSocket
4. SDK receives the `DataStream`, matches `streamType` to registered handler
5. Mini app handler fires via `session.events.onPhoneNotifications(handler)`

**Path 2 — WebSocket (legacy):**

1. Phone sends `GlassesToCloudMessage` with `type: "phone_notification"` over the glasses WebSocket
2. Cloud's `glasses-message-handler.ts` hits the `default` case → `relayMessageToApps(message)`
3. Same routing from there

A TODO comment in `message-types.ts` indicates the WebSocket enum values should be removed after the REST migration is complete:

```typescript
// TODO(isaiah): Remove PHONE_NOTIFICATION, and PHONE_NOTIFICATION_DISMISSED
// after moving to REST request.
PHONE_NOTIFICATION = StreamType.PHONE_NOTIFICATION,
PHONE_NOTIFICATION_DISMISSED = StreamType.PHONE_NOTIFICATION_DISMISSED,
```

**Notification dismissal — REST:**

`POST /api/client/notifications/dismissed` with body `{ notificationId, notificationKey, packageName }`. Same relay pattern using `StreamType.PHONE_NOTIFICATION_DISMISSED`.

**Issue:** The REST endpoint for dismissal expects `{ notificationId, notificationKey, packageName }` but the `PhoneNotificationDismissed` interface also declares `app`, `title`, and `content` fields. The REST handler doesn't populate these additional fields, so the SDK type received by apps via the REST path will be a subset of the full interface. Apps that rely on `title` or `content` in the dismissed event may get `undefined`.

#### SDK Registration

```typescript
// events.ts L237-243
onPhoneNotifications(handler: Handler<PhoneNotification>) {
  return this.addHandler(StreamType.PHONE_NOTIFICATION, handler);
}

onPhoneNotificationDismissed(handler: Handler<PhoneNotificationDismissed>) {
  return this.addHandler(StreamType.PHONE_NOTIFICATION_DISMISSED, handler);
}
```

`addHandler` automatically subscribes the stream type, which propagates to the cloud on the next `updateSubscriptions()` call.

There are also convenience wrappers on `AppSession`:

```typescript
// AppSession L533-546
onPhoneNotifications(handler) {
  return this.events.onPhoneNotifications(handler);
}

onPhoneNotificationDismissed(handler) {
  return this.events.onPhoneNotificationDismissed(handler);
}
```

#### Permissions

- **Required:** `PermissionType.READ_NOTIFICATIONS` (for both notification and dismissed)
- **Legacy compat:** `PermissionType.NOTIFICATIONS` maps to `[READ_NOTIFICATIONS]` via `LEGACY_PERMISSION_MAP`
- **SDK-side:** `readNotificationWarnLog()` fires a non-blocking HTTP check against `GET /api/public/permissions/{packageName}` and logs a warning if the permission is missing. However, in `onPhoneNotifications()` this function is called without a `Logger` instance (unlike `calendarWarnLog` in `events.ts` which does have the logger), making the SDK-side check potentially a silent no-op.
- **Cloud-side:** `SimplePermissionChecker.filterSubscriptions()` rejects subscriptions at the cloud level if the app hasn't declared `READ_NOTIFICATIONS`. This is the real enforcement.

#### No Notification Caching

Notifications are **fire-and-forget**. Unlike calendar events (which cache up to 100 and replay to newly subscribed apps), if a notification arrives before an app subscribes, it's gone. The app misses it. This is by design — notifications are real-time events, not a queryable inbox. But it does mean that app startup timing matters.

---

### Calendar Events

**SDK:** `EventManager.onCalendarEvent()`
**Cloud:** `CalendarManager` — the most sophisticated of the phone event managers

#### Type Definition

```typescript
interface CalendarEvent {
  type: "calendar_event"
  eventId: string
  title: string
  dtStart: string // ISO date string
  dtEnd: string // ISO date string
  timezone: string // IANA timezone
  timeStamp: string // when this event was reported
}
```

#### Stream Type

- `StreamType.CALENDAR_EVENT` = `"calendar_event"` — category: `PHONE`

#### End-to-End Flow

**Path 1 — REST (primary):**

1. Phone app → `POST /api/client/calendar` with body `{ events: ExpoCalendarEvent[] }`
2. Cloud (`calendar.api.ts`) calls `userSession.calendarManager.updateEventsFromAPI(events)`
3. `CalendarManager` for each event:
   - Normalizes field names from Expo format to SDK `CalendarEvent` format (handles `startDate`/`start`/`dtStart` variants, etc.)
   - Adds to in-memory cache (max 100 events, prioritized: present/future first sorted soonest-first, then past events sorted most-recent-first)
   - De-duplicates by `eventId + dtStart`
   - Broadcasts via `userSession.relayMessageToApps(event)` to subscribed apps

**Path 2 — WebSocket (legacy):**

1. Phone sends `GlassesToCloudMessage` with `type: "calendar_event"` over glasses WebSocket
2. Cloud's `glasses-message-handler.ts` explicitly handles `CALENDAR_EVENT`:

```typescript
case GlassesToCloudMessageType.CALENDAR_EVENT:
  logger.debug({ message }, "Calendar event received from glasses");
  userSession.calendarManager.updateEventFromWebsocket(message as CalendarEvent);
  break;
```

3. `CalendarManager` normalizes, caches, and broadcasts

#### Smart Features

- **Cache replay:** When a new app subscribes to `calendar_event`, the `CalendarManager.handleSubscriptionUpdate()` detects newly subscribed apps and replays all cached events to them via `relayToApp()`. This means a newly started app immediately receives all known upcoming events, not just future ones.
- **SubscriptionManager integration:** `syncManagers()` calls `calendarManager.handleSubscriptionUpdate(calendarSubs)` after every subscription update.
- **Unsubscribe tracking:** `handleUnsubscribe()` removes apps from the internal tracking set.

#### SDK Registration

```typescript
// events.ts L262-264
onCalendarEvent(handler: Handler<CalendarEvent>) {
  return this.addHandler(StreamType.CALENDAR_EVENT, handler);
}
```

Also, `events.on(StreamType.CALENDAR_EVENT, handler)` triggers a `calendarWarnLog()` permission check (with the Logger instance, unlike the notification variant).

#### Permissions

- **Required:** `PermissionType.CALENDAR`
- Same dual-check pattern: SDK-side warning log + cloud-side rejection via `SimplePermissionChecker`

---

### Phone Battery

**SDK:** `EventManager.onPhoneBattery()`
**Cloud:** No dedicated manager, no REST endpoint — WS-only relay

#### Type Definition

```typescript
interface PhoneBatteryUpdate {
  type: "phone_battery_update"
  level: number // 0-100
  charging: boolean
  timeRemaining?: number // minutes
}
```

#### Stream Type

- `StreamType.PHONE_BATTERY_UPDATE` = `"phone_battery_update"` — category: **`HARDWARE`** (not `PHONE`!)

Note the inconsistency: phone battery is categorized as `HARDWARE` in `STREAM_CATEGORIES`, while notifications and calendar are `PHONE`. This is a historical artifact.

#### End-to-End Flow

Phone battery is the **simplest** of the phone events — no dedicated manager, no REST endpoint, no caching:

1. Phone app sends `GlassesToCloudMessage` with `type: "phone_battery_update"` over WebSocket
2. Cloud's `glasses-message-handler.ts` hits the `default` case (no explicit handler) → `relayMessageToApps(message)`
3. `relayMessageToApps` finds apps subscribed to `"phone_battery_update"` and sends `DataStream` messages

#### SDK Registration

```typescript
// events.ts L249-251
onPhoneBattery(handler: Handler<PhoneBatteryUpdate>) {
  return this.addHandler(StreamType.PHONE_BATTERY_UPDATE, handler);
}
```

#### Permissions

- **None required.** `phone_battery_update` is NOT in `SimplePermissionChecker.STREAM_TO_PERMISSION_MAP`. Any app can subscribe without declaring any special permission.

#### No REST Endpoint

Phone battery has no REST ingestion path, unlike notifications and calendar which have both REST and WebSocket. There's no TODO comment suggesting one is planned. This may be intentional (battery updates are frequent, low-value per-event, and the WS path works fine) or an oversight.

---

## Issues

| #   | Issue                                                               | Impact                                                                                                                                                                                                                     | Root Cause                                                                          |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | **All phone events on `session.events` alongside unrelated events** | Notifications, calendar, and phone battery are mixed with transcription, buttons, GPS, and 15+ other event types on the generic `EventManager`. No domain grouping.                                                        | v2 put everything on one event bus                                                  |
| 2   | **Phone battery categorized as `HARDWARE` not `PHONE`**             | `STREAM_CATEGORIES` maps `phone_battery_update` to `HARDWARE`. Inconsistent with notifications and calendar which are `PHONE`. Any category-based filtering treats phone battery differently from other phone events.      | Historical — battery was added with hardware events, phone category was added later |
| 3   | **Phone battery requires no permission**                            | Any app can subscribe to phone battery without declaring a permission. Notifications require `READ_NOTIFICATIONS`, calendar requires `CALENDAR`, but battery is ungated. May or may not be intentional.                    | `STREAM_TO_PERMISSION_MAP` doesn't include `phone_battery_update`                   |
| 4   | **Notification dismissed REST body mismatch**                       | REST endpoint expects `{ notificationId, notificationKey, packageName }` but `PhoneNotificationDismissed` type also has `app`, `title`, `content`. REST doesn't populate them → apps may get `undefined` for these fields. | REST endpoint was built to a simpler schema than the full type                      |
| 5   | **No notification caching**                                         | If a notification arrives before an app subscribes, it's missed. Calendar has caching + replay; notifications don't.                                                                                                       | Fire-and-forget design — intentional but creates timing dependencies on app startup |
| 6   | **SDK permission check for notifications is potentially broken**    | `readNotificationWarnLog()` in `onPhoneNotifications()` is called without a `Logger` instance, unlike the calendar equivalent which passes the logger. The notification check may silently fail.                           | Copy-paste inconsistency in `events.ts`                                             |
| 7   | **Dual ingestion paths (REST + WebSocket)**                         | Both paths exist for notifications and calendar. The WS path is legacy with a TODO to remove it. During transition, events could arrive via either path, potentially causing duplicates or ordering issues.                | Migration from WS to REST is incomplete                                             |
| 8   | **Phone battery has no REST endpoint**                              | Unlike notifications and calendar which migrated to REST (with WS as legacy), phone battery is WS-only. Inconsistent ingestion strategy.                                                                                   | Likely deemed low-priority since battery WS works fine                              |
| 9   | **No sub-scoping for permissions**                                  | All phone events use separate permission types (`READ_NOTIFICATIONS`, `CALENDAR`) but there's no API-level grouping. The developer has to know the permission name for each stream independently.                          | Permissions and events are separate flat systems with no namespace                  |
| 10  | **`CalendarEvent.timeStamp` is camelCase inconsistency**            | The field is `timeStamp` (capital S) while every other timestamp in the system is lowercase `timestamp`.                                                                                                                   | Expo calendar API uses `timeStamp`; the cloud normalizer preserved it               |

---

## Proposed v3 API

### `session.phone`

```typescript
// ─── Phone Battery ──────────────────────────────
session.phone.battery // → number | null (cached)
session.phone.onBatteryUpdate(handler) // → () => void (cleanup)

// ─── Notifications (sub-scoped) ─────────────────
session.phone.notifications.on(handler) // → () => void (cleanup)
session.phone.notifications.onDismissed(handler) // → () => void (cleanup)
session.phone.notifications.hasPermission // → boolean

// ─── Calendar (sub-scoped) ──────────────────────
session.phone.calendar.on(handler) // → () => void (cleanup)
session.phone.calendar.hasPermission // → boolean
```

### Type Definitions

```typescript
// ─── Phone Manager ──────────────────────────────

interface PhoneManager {
  /** Cached phone battery level (0-100), or null if unknown. */
  readonly battery: number | null

  /** Subscribe to phone battery updates. Returns cleanup function. */
  onBatteryUpdate(handler: (event: PhoneBatteryEvent) => void): () => void

  /** Notification sub-manager. */
  readonly notifications: NotificationManager

  /** Calendar sub-manager. */
  readonly calendar: CalendarManager
}

// ─── Notifications ──────────────────────────────

interface NotificationManager {
  /** Subscribe to incoming phone notifications. Returns cleanup function. */
  on(handler: (notification: PhoneNotificationEvent) => void): () => void

  /** Subscribe to notification dismissals. Returns cleanup function. */
  onDismissed(handler: (event: NotificationDismissedEvent) => void): () => void

  /** Whether the app has notification reading permission. */
  readonly hasPermission: boolean
}

interface PhoneNotificationEvent {
  /** Unique notification identifier. */
  notificationId: string

  /** Source app name (e.g., "Messages", "Slack", "Gmail"). */
  app: string

  /** Notification title. */
  title: string

  /** Notification body/content. */
  content: string

  /** Notification priority. */
  priority: "low" | "normal" | "high"

  /** When this notification arrived. */
  timestamp: number
}

interface NotificationDismissedEvent {
  /** Unique notification identifier. */
  notificationId: string

  /** Source app name. */
  app: string

  /** Notification key (for grouping related notifications). */
  notificationKey: string

  /** When the dismissal happened. */
  timestamp: number
}

// ─── Calendar ───────────────────────────────────

interface CalendarEventManager {
  /** Subscribe to calendar events. Returns cleanup function.
   *  On first subscription, receives all cached events from the cloud. */
  on(handler: (event: CalendarEventData) => void): () => void

  /** Whether the app has calendar reading permission. */
  readonly hasPermission: boolean
}

interface CalendarEventData {
  /** Unique calendar event identifier. */
  eventId: string

  /** Event title/summary. */
  title: string

  /** Event start time (ISO 8601 string). */
  start: string

  /** Event end time (ISO 8601 string). */
  end: string

  /** IANA timezone (e.g., "America/New_York"). */
  timezone: string

  /** When this event was reported to the cloud. */
  timestamp: number
}

// ─── Phone Battery ──────────────────────────────

interface PhoneBatteryEvent {
  /** Battery level (0-100). */
  level: number

  /** Whether the phone is currently charging. */
  charging: boolean

  /** Estimated time remaining in minutes (may not be available). */
  timeRemaining?: number

  /** When this update was received. */
  timestamp: number
}
```

### Usage Examples

```typescript
// ─── Notifications ──────────────────────────────

// Check permission first
if (session.phone.notifications.hasPermission) {
  // Subscribe to incoming notifications
  const stopNotifs = session.phone.notifications.on((notification) => {
    console.log(`[${notification.app}] ${notification.title}: ${notification.content}`)

    if (notification.priority === "high") {
      session.display.showText(`🔔 ${notification.title}`)
    }
  })

  // Track dismissals
  session.phone.notifications.onDismissed((event) => {
    console.log(`Notification ${event.notificationId} dismissed`)
  })

  // Later: stop receiving notifications
  stopNotifs()
}

// ─── Calendar ───────────────────────────────────

if (session.phone.calendar.hasPermission) {
  // Subscribe — immediately receives all cached events from the cloud
  session.phone.calendar.on((event) => {
    const startTime = new Date(event.start)
    const now = new Date()
    const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000)

    if (minutesUntil > 0 && minutesUntil <= 15) {
      session.display.showText(`📅 ${event.title} in ${minutesUntil} min`)
    }
  })
}

// ─── Phone Battery ──────────────────────────────

// Read cached value (synchronous)
const phoneBattery = session.phone.battery
console.log(`Phone battery: ${phoneBattery}%`)

// Subscribe to updates
session.phone.onBatteryUpdate((event) => {
  if (event.level < 10 && !event.charging) {
    session.display.showText("⚠️ Phone battery critically low")
  }
})
```

---

## Design: Sub-Scoped Managers

### The Question

How does the sub-scoping pattern (`session.phone.notifications.on()`) interact with the subscription system? Is `notifications` a sub-manager with its own handler tracking?

### The Answer

`NotificationManager` and `CalendarEventManager` are lightweight sub-manager objects created by `PhoneManager` during initialization. They're not full managers in the sense of `TranscriptionManager` — they're thin wrappers that:

1. Register handlers on the `DataStreamRouter` for their specific stream types
2. Track their own handler sets (for cleanup and `hasPermission` checks)
3. Read permission state from the centralized `PermissionsManager`

```typescript
// Internal structure (simplified)
class PhoneManager {
  readonly notifications: NotificationManager
  readonly calendar: CalendarEventManager

  private _battery: number | null = null

  constructor(
    private router: DataStreamRouter,
    private permissions: PermissionsManager,
  ) {
    this.notifications = new NotificationManager(router, permissions)
    this.calendar = new CalendarEventManager(router, permissions)

    // Phone battery — PhoneManager handles directly (no sub-manager needed)
    // Cached from incoming events
  }

  get battery(): number | null {
    return this._battery
  }

  onBatteryUpdate(handler: (event: PhoneBatteryEvent) => void): () => void {
    return this.router.register("phone_battery_update", (data) => {
      this._battery = data.level
      handler(this.normalize(data))
    })
  }
}

class NotificationManager {
  constructor(
    private router: DataStreamRouter,
    private permissions: PermissionsManager,
  ) {}

  get hasPermission(): boolean {
    return this.permissions.has("notifications")
  }

  on(handler: (notification: PhoneNotificationEvent) => void): () => void {
    return this.router.register("phone_notification", (data) => {
      handler(this.normalize(data))
    })
  }

  onDismissed(handler: (event: NotificationDismissedEvent) => void): () => void {
    return this.router.register("phone_notification_dismissed", (data) => {
      handler(this.normalize(data))
    })
  }
}

class CalendarEventManager {
  constructor(
    private router: DataStreamRouter,
    private permissions: PermissionsManager,
  ) {}

  get hasPermission(): boolean {
    return this.permissions.has("calendar")
  }

  on(handler: (event: CalendarEventData) => void): () => void {
    return this.router.register("calendar_event", (data) => {
      handler(this.normalize(data))
    })
  }
}
```

The subscription lifecycle works exactly the same as other managers: registering a handler adds a subscription (via `DataStreamRouter` → `updateSubscriptions()`), removing the last handler for a stream removes the subscription. The sub-manager pattern is purely an API-level grouping — underneath, the subscription mechanism is identical.

### Why Sub-Managers (Not Flat Methods)

**Alternative considered:**

```typescript
// Flat approach (NOT recommended):
session.phone.onNotification(handler)
session.phone.onNotificationDismissed(handler)
session.phone.notificationHasPermission
session.phone.onCalendarEvent(handler)
session.phone.calendarHasPermission
session.phone.onBatteryUpdate(handler)
```

Problems:

- `notificationHasPermission` is awkward — the permission belongs to the notification domain, not to `phone` generically.
- No grouping — all methods at the same level, hard to discover what's available for notifications vs calendar vs battery.
- Adding more notification-related methods later (e.g., `notifications.getRecent()`, `notifications.dismiss()`) would require flat names like `getRecentNotifications()`, `dismissNotification()` — verbose and cluttered.

The sub-scope pattern (`session.phone.notifications.on()`) is more discoverable, scales better, and matches how developers think about these capabilities as distinct subsystems.

---

## Design: Phone Battery — Where Does It Belong?

### The Question

Phone battery vs glasses battery — `session.phone.battery` vs `session.device.state.batteryLevel`. Is the naming clear enough?

### The Answer

Yes. The distinction is physical location:

| Property                            | What it measures        | Source                                   |
| ----------------------------------- | ----------------------- | ---------------------------------------- |
| `session.phone.battery`             | Phone battery (0-100)   | Phone app reports via WS                 |
| `session.device.state.batteryLevel` | Glasses battery (0-100) | Glasses report via cloud `DeviceManager` |

The naming maps directly to the physical device. `session.phone.battery` is the phone. `session.device.state.batteryLevel` is the glasses. No ambiguity.

### Why Not Observable for Phone Battery?

Glasses battery uses `Observable<number | null>` on `DeviceState`. Phone battery uses a simple cached number + event handler. Why the difference?

- **Glasses state** comes from `DEVICE_STATE_UPDATE` messages — a general state-sync mechanism where multiple properties update at once. Observable is the right pattern for state synchronization.
- **Phone battery** comes as a discrete event (`phone_battery_update`) — a single value arriving as a stream event. A cached value + event handler is the right pattern for event streams.

Using Observable for phone battery would work but adds conceptual weight. The developer would need to know: "for glasses state, use `device.state.*.onChange()`. For phone state... also use an Observable but it's on `phone`, not `phone.state`." Keeping phone battery as a simple cached value + event callback is more natural and consistent with how other phone events (notifications, calendar) work — they're all events, not state.

### Permissions for Phone Battery

Phone battery currently requires **no permission**. This is inconsistent with notifications (`READ_NOTIFICATIONS`) and calendar (`CALENDAR`), but arguably correct — battery level is not sensitive data. Knowing someone's phone is at 47% isn't a privacy concern.

**Decision:** Keep phone battery permission-free. Don't add a permission gate where none is needed. If this changes in the future, the cloud's `SimplePermissionChecker` can add it without SDK changes.

---

## Design: Notification Dismissed Event Cleanup

### The Problem

The `PhoneNotificationDismissed` type declares `app`, `title`, and `content` fields, but the REST endpoint that processes dismissals only sends `notificationId`, `notificationKey`, and `packageName`. Apps that expect `title` or `content` in the dismissed event may get `undefined`.

### The Fix

The v3 `NotificationDismissedEvent` type only includes fields that are always populated:

```typescript
interface NotificationDismissedEvent {
  notificationId: string
  app: string
  notificationKey: string
  timestamp: number
}
```

`title` and `content` are **removed from the dismissed event type**. They're unreliable (not always populated from the REST path), and the developer already received them in the original `PhoneNotificationEvent`. If they need to correlate dismissals with notification content, they can keep a map of `notificationId → content` from the `on()` handler.

The cloud-side REST handler should populate the `app` field from the `packageName` in the request body (or from the notification record if one is cached). If `app` can't be determined, it defaults to an empty string.

---

## Design: CalendarEvent Field Name Normalization

### The Problem

`CalendarEvent` has `dtStart`, `dtEnd`, and `timeStamp` — naming conventions from the Expo/iCal world that are inconsistent with the rest of the SDK:

- `dtStart` / `dtEnd` — iCal naming, not idiomatic TypeScript
- `timeStamp` — capital S, every other timestamp in the system is lowercase

### The Fix

The v3 `CalendarEventData` type uses clean names:

| v2 field    | v3 field    | Notes             |
| ----------- | ----------- | ----------------- |
| `dtStart`   | `start`     | Shorter, clearer  |
| `dtEnd`     | `end`       | Shorter, clearer  |
| `timeStamp` | `timestamp` | Consistent casing |
| `eventId`   | `eventId`   | Unchanged         |
| `title`     | `title`     | Unchanged         |
| `timezone`  | `timezone`  | Unchanged         |

The `CalendarEventManager` normalizes incoming events from the wire format (which still uses `dtStart`, `dtEnd`, `timeStamp`) to the v3 shape. No cloud changes needed.

The legacy shim adds the old field names as aliases on the event object for backward compat:

```typescript
// Legacy shim adds v2 fields
{ ...v3Event, dtStart: v3Event.start, dtEnd: v3Event.end, timeStamp: v3Event.timestamp }
```

---

## Design: Notification Caching — Should v3 Add It?

### The Question

Calendar events are cached (up to 100) and replayed to newly subscribed apps. Notifications are fire-and-forget. Should v3 add notification caching?

### The Answer: No, Not in v3.0

Notifications are fundamentally different from calendar events:

- **Calendar events** are a queryable set of upcoming items. When an app subscribes, it needs the current schedule, not just future changes. Cache + replay makes sense.
- **Notifications** are transient real-time alerts. A notification from 30 seconds ago is stale. Replaying old notifications on subscription would confuse users ("why am I seeing a Slack message from before the app started?").

The correct pattern for apps that need notification history is to persist them in `session.storage` as they arrive. The SDK shouldn't cache notifications by default.

If a future use case demands it (e.g., a notification aggregation app that needs the last N notifications), the cloud-side `CalendarManager` pattern could be replicated for notifications. But this is v3.1+ territory.

---

## What Changes Where

### SDK

| File / Module                     | Change                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| New: `PhoneManager`               | `session.phone` — battery, notification sub-manager, calendar sub-manager                                                                            |
| New: `NotificationManager`        | `session.phone.notifications` — `.on()`, `.onDismissed()`, `.hasPermission`                                                                          |
| New: `CalendarEventManager`       | `session.phone.calendar` — `.on()`, `.hasPermission`                                                                                                 |
| `EventManager` (574 lines)        | Remove `onPhoneNotifications()`, `onPhoneNotificationDismissed()`, `onPhoneBattery()`, `onCalendarEvent()` — all move to `PhoneManager` sub-managers |
| `AppSession` (2,423 lines)        | Remove `onPhoneNotifications()`, `onPhoneNotificationDismissed()` convenience wrappers                                                               |
| `LegacyEventShim`                 | `session.events.onPhoneNotifications()` → `session.phone.notifications.on()`                                                                         |
| `LegacyEventShim`                 | `session.events.onPhoneNotificationDismissed()` → `session.phone.notifications.onDismissed()`                                                        |
| `LegacyEventShim`                 | `session.events.onPhoneBattery()` → `session.phone.onBatteryUpdate()`                                                                                |
| `LegacyEventShim`                 | `session.events.onCalendarEvent()` → `session.phone.calendar.on()`                                                                                   |
| `PhoneNotificationDismissed` type | Remove unreliable `title`, `content` fields → `NotificationDismissedEvent`                                                                           |
| `CalendarEvent` type              | Rename `dtStart` → `start`, `dtEnd` → `end`, `timeStamp` → `timestamp` → `CalendarEventData`                                                         |

### Cloud

| File / Module                | Change                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `CalendarManager`            | No changes — caching, normalization, and replay stay the same                            |
| `notifications.api.ts`       | No changes — REST endpoint stays the same                                                |
| `glasses-message-handler.ts` | No changes — event routing stays the same                                                |
| `SubscriptionManager`        | No changes — `syncManagers()` already notifies `CalendarManager` on subscription changes |
| `SimplePermissionChecker`    | No changes — permission gating stays the same                                            |
| `STREAM_CATEGORIES`          | Fix: recategorize `phone_battery_update` from `HARDWARE` to `PHONE` (consistency)        |

### Wire Protocol

| Message                                      | Change                                     |
| -------------------------------------------- | ------------------------------------------ |
| `DATA_STREAM` (phone_notification)           | No change — same stream type, same payload |
| `DATA_STREAM` (phone_notification_dismissed) | No change                                  |
| `DATA_STREAM` (calendar_event)               | No change                                  |
| `DATA_STREAM` (phone_battery_update)         | No change                                  |

The wire protocol requires **zero changes**. All v3 work is in the SDK's `PhoneManager` and its sub-managers — normalizing field names, grouping events by domain, and providing a clean namespace.

---

## Legacy Shim

```typescript
// ─── Notifications ──────────────────────────────

// v2 code:
session.events.onPhoneNotifications((notification) => {
  console.log(notification.title)
})
// LegacyEventShim maps to:
session.phone.notifications.on((notification) => {
  handler(notification) // fields are compatible
})

// v2 code:
session.events.onPhoneNotificationDismissed((event) => {
  console.log(event.notificationId, event.title)
})
// LegacyEventShim maps to:
session.phone.notifications.onDismissed((event) => {
  // v3 type omits unreliable title/content fields
  // shim adds them as undefined for compat
  handler({...event, title: undefined, content: undefined})
})

// v2 code:
session.onPhoneNotifications(handler)
// Deprecated method maps to:
session.phone.notifications.on(handler)

// ─── Calendar ───────────────────────────────────

// v2 code:
session.events.onCalendarEvent((event) => {
  console.log(event.dtStart, event.title)
})
// LegacyEventShim maps to:
session.phone.calendar.on((event) => {
  // shim adds v2 field names as aliases
  handler({...event, dtStart: event.start, dtEnd: event.end, timeStamp: event.timestamp})
})

// ─── Phone Battery ──────────────────────────────

// v2 code:
session.events.onPhoneBattery((event) => {
  console.log(event.level)
})
// LegacyEventShim maps to:
session.phone.onBatteryUpdate((event) => {
  handler(event) // fields are compatible
})
```

---

## Open Questions

| #                                                                                                 | Question                                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                                                                                                 | **Should `session.phone.notifications` support filtering by app?**                  | E.g., `session.phone.notifications.on({ app: "Slack" }, handler)` to only receive Slack notifications. This would be SDK-side filtering (cloud sends all, SDK filters). Useful but adds API complexity. Probably v3.1 — developers can filter in their handler for now.                                                                                                                                                                       |
| 2                                                                                                 | **Should notification dismissed events include the original notification content?** | The cloud could cache notifications and attach content to dismissal events. This adds cloud-side state for a niche use case. Recommendation: no. Developers can keep their own `notificationId → content` map from the `on()` handler.                                                                                                                                                                                                        |
| 3                                                                                                 | **Phone battery — should it require a permission?**                                 | Currently ungated. Battery level isn't sensitive data, but it IS phone data. Adding a `PHONE_BATTERY` permission would be consistent with other phone events but adds friction for a low-risk data type. Recommendation: keep ungated.                                                                                                                                                                                                        |
| 4                                                                                                 | **Should the calendar sub-manager expose `getEvents()` for cached events?**         | The cloud's `CalendarManager` caches up to 100 events. Should the SDK expose `session.phone.calendar.getEvents()` that returns all cached events synchronously? Currently, cached events are replayed individually via the `on()` handler on first subscription. A bulk `getEvents()` would need a request-response message type (cloud doesn't have one for calendar). Probably v3.1 if ever.                                                |
| 5                                                                                                 | **Should `session.phone` include phone model/OS info?**                             | E.g., `session.phone.model` ("iPhone 15 Pro"), `session.phone.os` ("iOS 18.2"). The mobile app probably knows this. Could be useful for app developers who need to handle platform differences. But it's metadata, not events — different from the event-focused `PhoneManager`. Maybe `session.phone.info` as a static read-only object? Low priority.                                                                                       |
| 6                                                                                                 | **Notification priority filtering — SDK-side or cloud-side?**                       | If a developer only wants `"high"` priority notifications, should they filter in their handler, or should the subscription system support priority-based filtering (`subscribe("phone_notification:high")`)? SDK-side filtering is simpler. Cloud-side filtering reduces bandwidth. Recommendation: SDK-side for v3.0.                                                                                                                        |
| 7                                                                                                 | **Calendar event updates vs new events**                                            | When a calendar event is modified (title change, time change), the phone sends the updated event with the same `eventId`. The cloud's `CalendarManager` deduplicates by `eventId + dtStart`. But if only the title changed (same `eventId`, same `dtStart`), the dedup would treat it as a duplicate and not relay the update. Is this a bug? Does the cloud need a more nuanced dedup strategy?                                              |
| 8                                                                                                 | **Should `session.phone` have an `isConnected` property?**                          | "Is the phone connected to the cloud?" is different from "are the glasses connected." If the phone app crashes or loses network, phone events stop flowing. The SDK has no way to know this. An `isConnected` Observable on `session.phone` would help. But the cloud doesn't currently track phone connection state separately from glasses connection state — they share the same `UserSession`. Probably a cloud-side change needed first. |
| 9                                                                                                 | **Notification grouping / threading**                                               | iOS and Android both support notification groups (a parent notification with child notifications). The current `PhoneNotification` type doesn't represent grouping. Should v3 add a `groupKey` or `threadId` field? This would require phone-side changes to send the grouping info. Low priority for v3.0.                                                                                                                                   |
| 10                                                                                                | **GPS location — `session.phone` or `session.location`?**                           | Location comes from the phone's GPS. By the "phone data → `session.phone`" rule, it could live on `session.phone.location`. But location is complex enough (accuracy modes, continuous vs one-shot, geofencing) that it deserves its own top-level manager. The 039 API map puts it at `session.location`. This is the right call — location is not a "phone event" in the same way notifications are. Keep it separate.                      |
| right call — location is not a "phone event" in the same way notifications are. Keep it separate. |
