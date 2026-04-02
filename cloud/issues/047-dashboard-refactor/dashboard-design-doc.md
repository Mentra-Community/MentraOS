# Design: Dashboard Mini App → Cloud OS Service

## Overview

**What this doc covers:** Exact file structure, class signatures, method signatures, and deletion checklist for the dashboard refactor implementation.
**Why this doc exists:** Spec covers what and why. This covers how — every file, every method, what changes, what disappears.
**What you need to know first:** [dashboard-refactor-spec.md](./dashboard-refactor-spec.md), [dashboard-refactor-spike.md](./dashboard-refactor-spike.md)
**Who should read this:** Engineers implementing the refactor.

---

## Changes Summary

| Component                      | File                                                | Change                                                                                                |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DashboardManager`             | `services/session/dashboard/DashboardManager.ts`    | Major rewrite — active service, new data hooks, dead code + dead modes removed                        |
| `NotificationService`          | `services/session/dashboard/NotificationService.ts` | New — moved + renamed from mini app's `NotificationRankingAgent.ts`, no LangChain                     |
| `WeatherService`               | `services/core/WeatherService.ts`                   | Moved from mini app's `services/weather.service.ts` — cross-user singleton, lives at core level       |
| `index.ts`                     | `services/session/dashboard/index.ts`               | Remove `handleAppDisconnected` + `handleAppMessage` helpers — callers use `DashboardManager` directly |
| `notifications.api.ts`         | `api/hono/client/notifications.api.ts`              | Wire `dashboardManager.onNotification()` + `onNotificationDismissed()`                                |
| `calendar.api.ts`              | `api/hono/client/calendar.api.ts`                   | Wire `dashboardManager.onCalendarUpdate()`                                                            |
| `location.api.ts`              | `api/hono/client/location.api.ts`                   | Wire `dashboardManager.onLocationUpdate()`                                                            |
| `app-settings.routes.ts`       | `api/hono/routes/app-settings.routes.ts`            | Remove `SYSTEM_DASHBOARD_PACKAGE_NAME` special-case (phase 2)                                         |
| `bun-websocket.ts`             | `services/websocket/bun-websocket.ts`               | Remove `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` (phase 2)                                            |
| `websocket-glasses.service.ts` | `services/websocket/websocket-glasses.service.ts`   | Remove `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` (phase 2)                                            |

---

## File Structure

### Before

```
services/session/dashboard/
  DashboardManager.ts     (894 lines)
  index.ts
  tests/
  docs/
```

### After

```
services/session/dashboard/
  DashboardManager.ts     (refactored — smaller)
  NotificationService.ts  (new — moved from mini app, no LangChain)
  index.ts                (simplified)
  tests/
  docs/

services/core/
  WeatherService.ts       (moved from apps/Dashboard/src/services/weather.service.ts)
  ...other core services
```

---

## What Gets Deleted

### From `DashboardManager`

These are fully removed — no replacement:

| Symbol                             | Why                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `interface SystemContent`          | `systemContent` seam to mini app is gone                                                                                    |
| `private systemContent`            | Same                                                                                                                        |
| `handleDashboardSystemUpdate()`    | No external process sending system sections anymore                                                                         |
| `handleDashboardModeChange()`      | Only `SYSTEM_DASHBOARD_PACKAGE_NAME` could send this — that package is deleted. EXPANDED mode was never active in practice. |
| `private currentMode`              | Always MAIN — no longer needed                                                                                              |
| `DashboardConfig` interface        | No meaningful options left — constructor takes no config                                                                    |
| `private alwaysOnEnabled`          | Feature is off — entire codebase is commented-out                                                                           |
| `private alwaysOnContent: Map`     | Same                                                                                                                        |
| `generateAlwaysOnLayout()`         | Same                                                                                                                        |
| `isAlwaysOnEnabled(): boolean`     | Same                                                                                                                        |
| `generateExpandedLayout()`         | EXPANDED mode removed (see above)                                                                                           |
| `private expandedContent: Map`     | Same                                                                                                                        |
| `private updateInterval`           | Replaced by `heartbeatTimer`                                                                                                |
| `private updateIntervalMs`         | Hardcoded constant instead                                                                                                  |
| `private queueSize`                | Hardcoded constant instead                                                                                                  |
| `getCombinedAppContent()`          | Only callers: `generateAlwaysOnLayout()` (deleted) and `generateExpandedLayout()` (deleted)                                 |
| `sendDisplayRequest()`             | Inlined into `render()` — was a 60-line wrapper with redundant debug logging                                                |
| `startUpdateInterval()`            | Fully commented out already — delete                                                                                        |
| `formatSystemLeftSection()`        | Replaced by `formatHeaderLeft()`                                                                                            |
| `formatSystemRightSection()`       | Replaced by `formatHeaderRight()`                                                                                           |
| `updateDashboard()`                | Renamed `render()`                                                                                                          |
| `getCurrentMode()`                 | Always MAIN — pointless getter                                                                                              |
| `setDashboardMode()` / `setMode()` | No mode switching anymore                                                                                                   |
| `broadcastToMiniApps()`            | Only used by `setMode()` for mode-change notifications — both deleted                                                       |

### From `DashboardConfig` interface

```typescript
// Before
interface DashboardConfig {
  queueSize?: number // DELETE — hardcode to 5
  updateIntervalMs?: number // DELETE — hardcode heartbeat to 60s
  alwaysOnEnabled?: boolean // DELETE — feature is dead
  initialMode?: DashboardMode // DELETE — always MAIN now
}

// After: DashboardConfig is removed entirely.
// constructor(userSession: UserSession) — no config param needed.
```

### From `index.ts`

Delete the two module-level helper functions — `handleAppMessage` and `handleAppDisconnected`. They exist because callers used to get routed here via an indirection layer. After the refactor, callers hold a reference to `DashboardManager` directly via `userSession.dashboardManager`.

```typescript
// DELETE both of these from index.ts:
export function handleAppMessage(message, userSession): boolean { ... }
export function handleAppDisconnected(packageName, userSession): void { ... }

// KEEP:
export { DashboardManager };
```

---

## `DashboardManager` — Full New Signature

```typescript
// ─── Constants ───────────────────────────────────────────────────────────────
const WIDGET_QUEUE_SIZE = 5
const HEARTBEAT_INTERVAL_MS = 60_000
const UPDATE_COALESCE_MS = 500

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Widget content contributed by a third-party MiniApp for display on the dashboard.
 * Replaces the old `AppContent` interface — "App" is now "MiniApp".
 */
interface DashboardWidget {
  packageName: string
  content: string | Layout
  timestamp: Date
}

interface DashboardConfig {
  initialMode?: DashboardMode
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class DashboardManager {
  // ── State ──────────────────────────────────────────────────────────────────

  private currentMode: DashboardMode = DashboardMode.MAIN

  // MiniApp widget content — keyed by packageName, one slot per app
  private mainWidgets: Map<string, DashboardWidget> = new Map()
  private expandedWidgets: Map<string, DashboardWidget> = new Map()
  private widgetRotationIndex = 0

  // System data owned directly (replaces systemContent from mini app)
  private weatherText: string | null = null
  private calendarText: string | null = null
  private notificationService: NotificationService

  // Timers
  private heartbeatTimer: NodeJS.Timeout | null = null
  private updateTimer: NodeJS.Timeout | null = null

  private readonly userSession: UserSession
  private readonly logger: Logger

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  constructor(userSession: UserSession)
  // Config param removed — no meaningful options left after cleanup

  dispose(): void
  // Clears timers, clears mainWidgets, disposes NotificationService

  // ── Public: MiniApp protocol ───────────────────────────────────────────────

  /**
   * Route an incoming MiniApp WebSocket message to the right handler.
   * Handles: DASHBOARD_CONTENT_UPDATE only.
   * (DASHBOARD_SYSTEM_UPDATE removed — no external process sends it anymore)
   * (DASHBOARD_MODE_CHANGE removed — only SYSTEM_DASHBOARD_PACKAGE_NAME could
   *  send it, and that package is being deleted. EXPANDED mode was never
   *  triggered in practice. Reintroduce when there's a real trigger.)
   */
  handleMiniAppMessage(message: AppToCloudMessage): boolean

  /**
   * Called when a MiniApp disconnects — removes its widget slot and re-renders.
   */
  handleMiniAppDisconnected(packageName: string): void

  /**
   * Called when MiniApp sends a DASHBOARD_CONTENT_UPDATE message.
   * Stores content in mainWidgets by packageName (one slot per MiniApp).
   * Triggers scheduleUpdate().
   */
  handleDashboardContentUpdate(message: DashboardContentUpdate): void

  /**
   * Called when the user looks up (head-up gesture, from glasses-message-handler).
   * Cycles the widget rotation index and re-renders if multiple widgets exist.
   */
  onHeadsUp(): void

  /**
   * Remove widget slots for a specific MiniApp and re-render.
   * Called on MiniApp disconnect/stop.
   */
  cleanupWidgets(packageName: string): void

  // getCurrentMode() removed — always MAIN now. Reintroduce if modes come back.

  // ── Public: Data event hooks (new — called from API handlers) ─────────────

  /**
   * Called from notifications.api.ts when a phone notification arrives.
   * Hands off to NotificationService, then schedules a re-render.
   */
  onNotification(notification: PhoneNotificationPayload): void

  /**
   * Called from notifications.api.ts when a notification is dismissed.
   * Removes from NotificationService cache, schedules re-render.
   */
  onNotificationDismissed(notificationId: string, notificationKey: string): void

  /**
   * Called from location.api.ts when a location update arrives.
   * Fetches weather from WeatherService (async), caches result, schedules re-render.
   */
  onLocationUpdate(lat: number, lng: number): Promise<void>

  /**
   * Called from calendar.api.ts after calendarManager.updateEventsFromAPI().
   * Picks the next upcoming event, formats it, schedules re-render.
   */
  onCalendarUpdate(events: CalendarEvent[]): void

  // ── Private: Render cycle ─────────────────────────────────────────────────

  /**
   * Debounced — coalesces rapid data updates into a single render.
   * All on* methods and onHeadsUp call this.
   * Heartbeat timer also calls this every 60s to keep clock placeholder fresh.
   */
  private scheduleUpdate(delayMs?: number): void

  /**
   * Builds the layout and sends it to DisplayManager.
   * Called by scheduleUpdate's timer callback.
   */
  private render(): void

  // ── Private: Layout generation ────────────────────────────────────────────

  /**
   * Builds the dashboard layout:
   * Row 1: column-split header via ColumnComposer (1 line only)
   * Rows 2–4: full-width TextWall (notifications, widget)
   */
  private generateLayout(): Layout
  // Was generateMainLayout(). Renamed — there's only one mode now.
  // generateExpandedLayout() deleted — EXPANDED mode removed (see handleMiniAppMessage note).

  /**
   * Left side of the header row — time and battery.
   * Returns "◌ $DATE$, $GBATT$" — tokens resolved by native at display time.
   * Replaces formatSystemLeftSection().
   */
  private formatHeaderLeft(): string

  /**
   * Right side of the header row — weather or next calendar event.
   * Returns the cached weatherText or calendarText string, or "".
   * Replaces formatSystemRightSection().
   */
  private formatHeaderRight(): string

  /**
   * Returns the next widget content string for the rotation slot.
   * Advances widgetRotationIndex when onHeadsUp() cycles through items.
   * Replaces getNextMainAppContent().
   */
  private getNextWidget(): string

  /**
   * Extracts a display string from widget content (string | Layout).
   * Handles TextWall, DoubleTextWall, DashboardCard, ReferenceCard.
   * Replaces extractTextFromContent().
   */
  private extractText(content: string | Layout): string

  // ── Private: MiniApp broadcasting ─────────────────────────────────────────

  /**
   * Sends a message to all connected MiniApp WebSockets.
   * Used for DASHBOARD_MODE_CHANGED notifications.
   * Replaces broadcastToAllApps().
   */
  private broadcastToMiniApps(message: object): void

  /**
   * Updates currentMode and broadcasts DASHBOARD_MODE_CHANGED to MiniApps.
   * Replaces setDashboardMode().
   */
  private setMode(mode: DashboardMode): void
}
```

---

## `NotificationService` — Full Signature

New file: `services/session/dashboard/NotificationService.ts`

Moved from `apps/Dashboard/src/agents/NotificationSummaryAgent.ts`. **No LangChain** — direct OpenAI API call. The prompt is preserved from the mini app.

```typescript
export interface PhoneNotification {
  uuid: string
  title: string
  content: string
  appName?: string
  timestamp: number
  viewCount: number
}

export interface RankedNotification {
  uuid: string
  summary: string // ≤ 30 chars
  rank: number
}

export class NotificationService {
  private cache: PhoneNotification[] = []
  private ranking: RankedNotification[] = []
  private rankingInFlight = false
  private readonly logger: Logger

  constructor(logger: Logger)

  // ── Public ─────────────────────────────────────────────────────────────────

  /**
   * Add or update a notification in the cache.
   * Fires async re-ranking after update.
   */
  add(notification: PhoneNotification): void

  /**
   * Remove a notification by ID and key.
   * Fires async re-ranking after removal.
   */
  dismiss(notificationId: string, notificationKey: string): void

  /**
   * Returns a display-ready string of the top 2 ranked notifications.
   * Falls back to recency sort if no ranking result yet.
   * Returns "" if cache is empty.
   */
  getDisplayText(): string

  dispose(): void

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Direct OpenAI chat completion — no LangChain.
   * Uses response_format: { type: "json_object" } for structured output.
   * Fires async, updates this.ranking when done.
   * No-ops if a ranking call is already in flight.
   */
  private rankAsync(): void

  /**
   * Fallback when LLM is unavailable or ranking hasn't run yet.
   * Sorts by timestamp descending, truncates title+content to 30 chars.
   */
  private fallbackRanking(): RankedNotification[]

  /**
   * Clean up old/stale notifications from the cache.
   * Max 20 items, max view count threshold.
   */
  private pruneCache(): void
}
```

---

## `WeatherService` — Location Change

**From:** `apps/Dashboard/src/services/weather.service.ts`
**To:** `services/core/WeatherService.ts`

Lives at core level because it has cross-user shared caching (geo-bucket proximity cache, LRU eviction). It's not session-scoped — the singleton is shared across all user sessions.

Changes from the original:

- Remove the `AppSession` parameter from `getWeather()` — replace with pino logger + `userId: string`
- Keep all caching logic unchanged (per-user cache, shared geo-bucket cache, neighbor-bucket boundary fix, 10-min TTL, LRU)

```typescript
// Before (mini app)
getWeather(session: AppSession, lat: number, long: number): Promise<WeatherSummary | null>

// After (cloud)
getWeather(userId: string, lat: number, long: number): Promise<WeatherSummary | null>

// Everything else unchanged.
export const weatherService = WeatherService.instance(); // singleton
```

---

## Wiring Points

Four one-liners, one per API handler:

### `notifications.api.ts` — `handlePhoneNotification()`

```typescript
// After relayMessageToApps:
userSession.dashboardManager.onNotification({
  uuid: notificationId,
  title,
  content,
  appName: app,
  timestamp: timestamp || Date.now(),
  viewCount: 0,
})
```

### `notifications.api.ts` — `handlePhoneNotificationDismissed()`

```typescript
// After relayMessageToApps:
userSession.dashboardManager.onNotificationDismissed(notificationId, notificationKey)
```

### `calendar.api.ts` — `updateCalendar()`

```typescript
// After calendarManager.updateEventsFromAPI(events):
userSession.dashboardManager.onCalendarUpdate(events as CalendarEvent[])
```

### `location.api.ts` — `updateLocation()`

```typescript
// After locationManager.updateFromAPI({ location }):
// fire-and-forget — onLocationUpdate fetches weather async
void userSession.dashboardManager.onLocationUpdate(location.coords.latitude, location.coords.longitude)
```

---

## Naming Decisions

| Old name                     | New name                      | Reason                                                                    |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `AppContent` interface       | `DashboardWidget`             | "App" → "MiniApp" policy; "Content" is vague — it's a widget slot         |
| `NotificationRankingAgent`   | `NotificationService`         | Not an agent framework; "Service" matches cloud naming convention         |
| `handleAppMessage()`         | `handleMiniAppMessage()`      | MiniApp terminology                                                       |
| `handleAppDisconnected()`    | `handleMiniAppDisconnected()` | MiniApp terminology                                                       |
| `cleanupAppContent()`        | `cleanupWidgets()`            | Clearer — it cleans up widget slots, not generic "app content"            |
| `mainContent` Map            | `mainWidgets` Map             | Consistent with `DashboardWidget` type                                    |
| `expandedContent` Map        | _(deleted)_                   | EXPANDED mode removed                                                     |
| `formatSystemLeftSection()`  | `formatHeaderLeft()`          | "System" no longer means "from the system mini app"; "Header" is accurate |
| `formatSystemRightSection()` | `formatHeaderRight()`         | Same                                                                      |
| `getNextMainAppContent()`    | `getNextWidget()`             | Shorter; "App" → widget; "Main" is implied                                |
| `extractTextFromContent()`   | `extractText()`               | Redundant words removed                                                   |
| `generateMainLayout()`       | `generateLayout()`            | Only one mode now — "Main" qualifier is redundant                         |
| `updateDashboard()`          | `render()`                    | You're in DashboardManager — "update dashboard" is tautological           |
| `setDashboardMode()`         | _(deleted)_                   | No mode switching                                                         |
| `broadcastToAllApps()`       | _(deleted)_                   | Only used for mode change notifications — both removed                    |
| `getCurrentMode()`           | _(deleted)_                   | Always MAIN — pointless                                                   |

---

## Rollout / Deployment Order

See spec §10. Summary:

1. Add `OPEN_WEATHER_API_KEY` to cloud deployment secrets before deploying any code
2. Deploy new `DashboardManager` — mini app still running, both write to `ViewType.DASHBOARD`, internal wins
3. Verify in BetterStack: dashboard errors drop to zero, content correct for test users
4. Stop Dashboard mini app deployment (scale to 0)
5. Remove `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` calls from websocket files (phase 2)
6. Remove all `SYSTEM_DASHBOARD_PACKAGE_NAME` special-cases from `DisplayManager`, `app-settings.routes.ts`, `app.service.ts` (phase 2)
7. Delete `apps/Dashboard/` repo after one week with no rollback

---

## Testing

The existing `DashboardTestHarness.ts` in `tests/` exercises layout generation. After the refactor:

- Replace `systemContent` setup calls with direct field assignment (`weatherText`, `calendarText`, `notificationService.add(...)`)
- Add test cases for `onNotification()` → `getDisplayText()` output
- Add test cases for `formatHeaderLeft()` returning token strings (not pre-computed time)
- Verify `render()` skips send when content unchanged (native handles this, but worth asserting the cloud doesn't thrash)
- The 3-sends-per-tick regression: verify a single `onNotification()` call results in exactly one `render()` call after the coalesce window
- Verify `handleMiniAppMessage()` returns `false` for `DASHBOARD_MODE_CHANGE` and `DASHBOARD_SYSTEM_UPDATE` message types (graceful no-op, not an error)
