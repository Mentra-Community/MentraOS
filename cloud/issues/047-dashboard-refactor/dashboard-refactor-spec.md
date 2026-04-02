# Spec: Dashboard Mini App → Cloud OS Service

## Overview

**What this doc covers:** Exact specification for replacing the `system.augmentos.dashboard` mini app with a cloud-internal `DashboardManager` that owns all dashboard data and rendering directly.
**Why this doc exists:** The mini app architecture generates 900–1,200 prod errors/minute and adds 9 hops to every dashboard update. This spec defines what the new system looks like, what moves where, and what gets deleted.
**What you need to know first:** [dashboard-refactor-spike.md](./dashboard-refactor-spike.md) — read the spike before this.
**Who should read this:** Cloud engineers implementing the refactor.

---

## The Problem in 30 Seconds

The dashboard mini app runs on a separate server. It connects to the cloud like any third-party app — via WebSocket. It has a 60-second timer that calls `session.dashboard.system.setTopLeft(...)`. When the WebSocket closes (which it does constantly), the timer fires anyway and throws. This creates 900+ errors/minute across all active user sessions.

The fix: the dashboard has no business being an external process. Every piece of data it needs already lives inside `UserSession`. Move it in, delete the external app.

---

## Spec

### 1. New `DashboardManager` — active service, not passive receiver

`DashboardManager` goes from a passive compositor (waiting for `handleDashboardSystemUpdate` calls from an external app) to an active service that owns its own data and drives its own update cycle.

**What it owns directly:**

```
DashboardManager (per UserSession)
  ├── weatherCache: { data: string, fetchedAt: number } | null
  ├── notificationCache: NotificationEntry[]
  ├── notificationRanking: RankedNotification[] | null
  ├── calendarEvent: CalendarEvent | null
  ├── updateTimer: NodeJS.Timeout | null
  └── (existing) mainContent, expandedContent, alwaysOnContent  ← unchanged
```

**What it reads from `UserSession` on each render:**

```
userSession.userTimezone               → time formatting
userSession.deviceManager.deviceState → battery level, glasses connected
userSession.userSettingsManager.snapshot.metric_system → °C vs °F
```

No more `systemContent: { topLeft, topRight, bottomLeft, bottomRight }`. That struct is deleted. The four-quadrant seam is replaced by direct method calls to the formatting functions below.

---

### 2. Data sources — what moves into `DashboardManager`

#### 2a. Weather

Move `apps/Dashboard/src/services/weather.service.ts` to:

```
cloud/packages/cloud/src/services/core/WeatherService.ts
```

- Keep it as a singleton (already is).
- Remove the `AppSession` logger parameter from `getWeather()` — replace with the cloud pino logger.
- Keep all caching logic (per-user cache, shared geo-bucket cache, LRU, 10-min TTL) unchanged.
- `OPEN_WEATHER_API_KEY` env var stays — already set on the cloud deployment.

`DashboardManager` calls `WeatherService.instance().getWeather(userId, lat, lng)` when location updates arrive. Stores the result in `this.weatherCache`.

#### 2b. Notification ranking

Move `apps/Dashboard/src/agents/NotificationSummaryAgent.ts` to:

```
cloud/packages/cloud/src/services/session/dashboard/NotificationRankingAgent.ts
```

- Remove `AppSession` dependency — it only used the session for the logger. Replace with pino logger passed in constructor.
- Keep the LangChain + OpenAI logic unchanged. LangChain is already a cloud dependency.
- Keep the fallback (title truncation) on LLM failure.
- `DashboardManager` holds one `NotificationRankingAgent` instance per session.
- Ranking is async — fire it on `onNotification()` updates. Store result in `this.notificationRanking`. Dashboard render always uses whatever is cached.

#### 2c. Location, notifications, battery, calendar

These already flow through `UserSession` event paths. `DashboardManager` needs to hook into them:

| Event                                         | Handler                         | What it does                                                                                     |
| --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Location update (`POST /api/client/location`) | `onLocationUpdate(lat, lng)`    | Stores coords, triggers `WeatherService.getWeather()`, calls `scheduleUpdate()`                  |
| Phone notification                            | `onNotification(notification)`  | Appends to `notificationCache`, fires `NotificationRankingAgent` async, calls `scheduleUpdate()` |
| Notification dismissed                        | `onNotificationDismissed(uuid)` | Removes from cache, re-ranks, calls `scheduleUpdate()`                                           |
| Battery update                                | (no handler needed)             | Read directly from `deviceManager.deviceState` at render time                                    |
| Calendar event                                | `onCalendarEvent(event)`        | Stores in `this.calendarEvent`, calls `scheduleUpdate()`                                         |
| Timezone change                               | (no handler needed)             | Read directly from `userSession.userTimezone` at render time                                     |

**How these hooks are wired:** `UserSession` already processes these events. The managers that handle them (e.g. the notification handler in `UserSession`) call `this.dashboardManager.onNotification(...)` directly. Same pattern as how `DeviceManager` is called today — direct method call, no WS roundtrip.

---

### 3. Update cycle — `scheduleUpdate()`

The mini app used `setInterval(..., 60000)`. The new manager uses event-driven updates with a minimum coalesce interval to avoid thrashing:

```
scheduleUpdate(delayMs = 0):
  if updateTimer is running:
    return   // already scheduled, let it fire
  updateTimer = setTimeout(() => {
    updateTimer = null
    this.renderAndSend()
  }, max(delayMs, COALESCE_MS))   // COALESCE_MS = 500ms

renderAndSend():
  layout = generateLayout()
  userSession.displayManager.handleDisplayRequest({
    packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,   // see §6 — this constant lives on temporarily
    view: ViewType.DASHBOARD,
    layout,
    timestamp: new Date()
  })
```

Additionally, a 60-second heartbeat timer fires `scheduleUpdate()` so the clock stays fresh even with no events:

```
constructor:
  this.heartbeatTimer = setInterval(() => this.scheduleUpdate(), 60_000)

dispose:
  clearInterval(this.heartbeatTimer)
  clearTimeout(this.updateTimer)
```

No more external process keeping its own interval. The timers live on `DashboardManager`, which is owned by `UserSession` and disposed with it.

---

### 4. Layout — hybrid header row + full-width body

The current `DoubleTextWall` forces ALL 5 lines into two equal columns, wasting the right half of every row used for notifications and app content. The new layout uses a single `TextWall` where only the **first row is column-split** (header: time+battery left, weather/status right) and **rows 2–4 are full-width**.

```
G1 display — new MAIN mode layout:

┌────────────────────────────────────────────────────────┐
│ ◌ $DATE$, $GBATT$              Sunny, 72°F             │  ← row 1: column-split header
│ Alex: let's sync tmr                                   │  ← row 2: full width
│ Meeting @ 4pm                                          │  ← row 3: full width
│ [app widget content — full width now]                  │  ← row 4: full width
│                                                        │  ← row 5: spare
└────────────────────────────────────────────────────────┘
```

Compare to current `DoubleTextWall`:

```
┌──────────────────────┬─────────────────────────────────┐
│ ◌ 3/12, 85%          │ Sunny, 72°F                     │
│ Alex: let's sync     │ [app widget — cramped half-width]│
│ tmr                  │                                  │
│ (wraps into narrow   │                                  │
│  left column)        │                                  │
└──────────────────────┴─────────────────────────────────┘
```

**How the header row is composed:**

Row 1 is built using `ColumnComposer.composeDoubleTextWall()` with `maxLines: 1` — this gives pixel-precise alignment for just that one line, with the right column starting at `rightColumnStartPx` (~55% of display width). The result is a single composed string.

Rows 2–N are plain strings joined with `\n` — full 576px width, no column math.

```typescript
// Pseudocode for generateMainLayout()
const headerLine = columnComposer.composeDoubleTextWall(
  `◌ $DATE$, $GBATT$`, // left: time + battery token
  formatStatusText(), // right: weather OR calendar event
  {columnConfig: {maxLines: 1}},
).composedText // single composed string, e.g. "◌ 3/12, 85%      Sunny, 72°F"

const bodyLines = [
  formatNotificationLines(), // 1–2 lines, full width
  getNextMainAppContent(), // app widget, full width
]
  .flat()
  .filter(Boolean)

return {
  layoutType: LayoutType.TEXT_WALL,
  text: [headerLine, ...bodyLines].join("\n"),
}
```

**Why this is better:**

- Notifications get the full 576px width instead of ~288px — fits more text per line, fewer awkward wraps
- App widget content same improvement — nearly 2× more usable space
- Header row still looks visually split — time left, status right — same UX as before
- `DoubleTextWall` overflow bug (§4b below) only affects the 1-line header now, and with short predictable text (time + battery token) the overflow risk is near zero

**`$GBATT$` and `$DATE$`/`$TIME12$` tokens:** Resolved client-side by the mobile `DisplayProcessor`. The time and battery lines never need a cloud-side update. The 60s heartbeat timer keeps content fresh for weather/notification/calendar changes, but the clock itself is always accurate via tokens regardless of when the cloud last sent.

`EXPANDED` mode (TextWall, unchanged concept):

```
Line 1: ◌ $TIME12$ | <statusText>    ← header, simpler — no column composer needed
Line 2+: <app content, full width>
```

---

### 4b. ColumnComposer overflow fix

Even after switching the system dashboard to the hybrid layout (where only the 1-line header uses `ColumnComposer`), the overflow bug still affects third-party apps using `session.layouts.showDoubleTextWall()` / `session.display.showDoubleText()`. Fix it here since we're already in this code.

**Root cause:**

`rightColumnWidthPx` is calculated as `displayWidth - rightColumnStartPx` (260px on G1), assuming the right column content starts exactly at `rightColumnStartPx`. But `calculateSpacesForAlignment` uses `Math.ceil`, meaning the actual right content start is `rightColumnStartPx + 0 to (spaceWidth - 1)` pixels past the target. On G1, `spaceWidth = 6px`, so the right column can start up to 5px past `rightColumnStartPx`. The right column was wrapped for 260px but now has only 255–260px of actual room — up to 5px over budget — causing the last character to wrap onto the next line's left position.

```
cloud/packages/display-utils/src/composer/ColumnComposer.ts

// Current — rightColumnWidthPx doesn't account for ceil overshoot:
rightColumnWidthPx: displayWidth - Math.floor(displayWidth * 0.55)  // 260px

// Fix — subtract one spaceWidth as buffer:
rightColumnWidthPx: displayWidth - Math.floor(displayWidth * 0.55) - spaceWidthPx  // 254px
```

`spaceWidthPx` is not available at `getColumnConfig()` time (it's computed from the measurer after construction). Two clean options:

**Option A** — subtract a fixed buffer from `rightColumnWidthPx` in the defaults:

```typescript
rightColumnWidthPx: displayWidth - Math.floor(displayWidth * 0.55) - 6 // hardcode G1 space width
```

Simple, but hardcodes a constant. Fine for now — all supported glasses use 6px spaces.

**Option B** — change `Math.ceil` → `Math.floor` with minimum-1-space guarantee:

```typescript
// calculateSpacesForAlignment:
const spaces = Math.max(1, Math.floor(pixelsNeeded / this.spaceWidthPx))
```

This means spaces never overshoot the target — right content starts at or slightly left of `rightColumnStartPx`. The 1–5px gap is invisible on glasses. Right column keeps its full 260px.

**Recommendation: Option B.** It's the root fix (the overshoot is in the rounding, not the width calculation), costs nothing visually, and keeps the right column wider.

**Out of scope for this issue:** SDK API changes (`breakMode` option on `showText`, `session.display.wrap()` utility). That layer is tracked in `039-sdk-v3-api-surface §3b`. The two-layer wrapping model (SDK wraps with `"word"` for readability, `DisplayProcessor` uses `"character-no-hyphen"` as a safety net) is documented there.

---

### 5. Formatting functions — what moves in

These methods move from `apps/Dashboard/src/index.ts` into `DashboardManager` verbatim (with `AppSession` references replaced by `UserSession`/direct field access):

| Function                      | Lines | Notes                                                                                                              |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `formatTimeSection()`         | ~30   | Replace `sessionInfo.userTimezone` with `this.userSession.userTimezone`                                            |
| `formatBatterySection()`      | 1     | Returns `"$GBATT$"` — trivial                                                                                      |
| `formatStatusSection()`       | ~70   | Replace `sessionInfo.calendarEvent` with `this.calendarEvent`, `sessionInfo.weatherCache` with `this.weatherCache` |
| `formatCalendarEvent()`       | ~55   | Replace logger via `this.logger`                                                                                   |
| `formatNotificationSection()` | ~30   | Replace `sessionInfo.phoneNotificationRanking` with `this.notificationRanking`                                     |

These functions have no external dependencies beyond `Intl` and standard Date manipulation. Move is mechanical.

---

### 6. The `SYSTEM_DASHBOARD_PACKAGE_NAME` constant — phased removal

During the migration, `SYSTEM_DASHBOARD_PACKAGE_NAME` stays in `app.service.ts`. `DashboardManager` continues to use it as `packageName` when constructing `DisplayRequest` objects — `DisplayManager6.1.ts` uses this to route dashboard requests to `ViewType.DASHBOARD`.

After the migration is complete and the mini app is dead:

- Remove the `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` calls from `bun-websocket.ts` and `websocket-glasses.service.ts`
- Remove the `SYSTEM_DASHBOARD_PACKAGE_NAME` special-cases from `DisplayManager6.1.ts` (6 locations)
- Remove the settings-push special-case in `app-settings.routes.ts`
- Remove the constant from `app.service.ts`
- Remove the `SYSTEM_DASHBOARD_PACKAGE_NAME` env var from deployment configs

**Order matters:** Kill the mini app deployment first, then remove the special-cases. If you remove the special-cases first and the mini app is still running, `DisplayManager` will misroute its display requests.

---

### 7. What gets deleted

**In `apps/Dashboard/`:**

| Path                                           | Action                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                                 | Delete                                                                                                                                                                                                 |
| `src/agents/NotificationSummaryAgent.ts`       | Move to cloud (see §2b)                                                                                                                                                                                |
| `src/agents/*.ts` (all others)                 | Delete — `FunFactAgent`, `NewsAgent`, `FamousQuotesAgent`, `MiraAgent`, `ChineseWordAgent`, `GratitudePingAgent`, `TrashTalkAgent`, `AgentGateKeeper`, `AgentInterface` are not called from `index.ts` |
| `src/services/weather.service.ts`              | Move to cloud (see §2a)                                                                                                                                                                                |
| `src/dashboard-modules/WeatherModule.ts`       | Delete — unused stub                                                                                                                                                                                   |
| `src/LLMProvider.ts`                           | Move to cloud alongside `NotificationRankingAgent`, or use existing cloud LLM setup                                                                                                                    |
| `docker/`, `porter.yaml`, `package.json`, etc. | Delete entire repo directory once deployment is confirmed dead                                                                                                                                         |

**In `cloud/packages/cloud/src/`:**

| Symbol                                                                   | Action                                    |
| ------------------------------------------------------------------------ | ----------------------------------------- |
| `DashboardManager.systemContent` (the 4-field struct)                    | Delete                                    |
| `DashboardManager.handleDashboardSystemUpdate()`                         | Delete                                    |
| `DashboardManager.handleAppMessage()` (dashboard system message routing) | Delete — no external app sending messages |
| `DashboardManager.handleAppDisconnected()`                               | Delete                                    |
| `SYSTEM_DASHBOARD_PACKAGE_NAME` (after phase 2)                          | Delete                                    |
| `AppManager.startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` calls               | Delete                                    |
| `DisplayManager6.1.ts` dashboard package special-cases                   | Delete (phase 2)                          |

**What stays in `DashboardManager`:**

- All third-party app content management (`mainContent`, `expandedContent`, `alwaysOnContent` Maps)
- `handleDashboardContentUpdate()` — third-party apps still call `dashboard.setContent(...)`
- `handleDashboardModeChange()` — third-party apps still change mode
- `onHeadsUp()` — rotation logic
- `cleanupAppContent()` — called when a third-party app disconnects
- `getCurrentMode()`, `isAlwaysOnEnabled()`, `dispose()`

---

### 8. `UserSession` wiring changes

`UserSession` needs to call `dashboardManager` methods when events arrive. Specific changes:

```typescript
// In the location handler (wherever POST /api/client/location is processed):
this.dashboardManager.onLocationUpdate(lat, lng)

// In the notification handler:
this.dashboardManager.onNotification(notification)
this.dashboardManager.onNotificationDismissed(uuid) // on dismiss

// In the calendar event handler:
this.dashboardManager.onCalendarEvent(event)

// DashboardManager constructor no longer needs AppSession — remove that pattern.
// DashboardManager receives UserSession only (already the case).
```

No changes needed for battery (read at render time from `deviceManager`) or timezone (read at render time from `userSession.userTimezone`).

---

### 9. Environment variables

One env var needs to be added to the cloud deployment that the mini-app currently owns:

| Var                    | Used for                                           | Action                                                                                         |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `OPEN_WEATHER_API_KEY` | `WeatherService.getWeather()` → OpenWeatherMap API | **Add to cloud `.env` and deployment secrets** — copy value from Dashboard mini-app deployment |

Everything else the mini-app uses (`OPENAI_API_KEY`, `LLM_MODEL`, `LLM_PROVIDER`, `AZURE_OPENAI_*`, `ANTHROPIC_API_KEY`) is already present in the cloud's environment — the cloud uses the same LLM infrastructure for other features.

Vars that are **not** needed in the cloud (mini-app SDK bootstrap vars, irrelevant once the external process is gone):

- `PACKAGE_NAME`, `MENTRAOS_API_KEY`, `PORT` — SDK connection vars, meaningless for a cloud-internal service
- `SERPAPI_API_KEY` — only used by agents being deleted (`MiraAgent`, `NewsAgent`, etc.)

---

### 10. Deployment / kill sequence

1. **Deploy new `DashboardManager`** with all data sources wired in and the internal update cycle running. The mini app is still deployed and running — both systems write to `ViewType.DASHBOARD`. The internal manager wins (it runs on every session). Mini app updates are redundant but harmless.
2. **Verify** in BetterStack: dashboard error rate drops to zero. Dashboard content renders correctly for test users.
3. **Stop the Dashboard mini app deployment** (scale to 0 / remove from Porter). No `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` calls will complete — `AppManager` will fail to connect to the webhook, log an error, and move on.
4. **Remove `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` calls** from `bun-websocket.ts` and `websocket-glasses.service.ts`. The dead webhook call is now gone.
5. **Remove `SYSTEM_DASHBOARD_PACKAGE_NAME` special-cases** from `DisplayManager`, `app-settings.routes.ts`, and `app.service.ts`.
6. **Delete the `apps/Dashboard/` repo** once no rollback is needed (give it a week).

---

## Decision Log

| Decision                                                       | Alternatives considered                             | Why we chose this                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move to cloud-internal service                                 | Fix WS cleanup in mini app                          | Root cause is the external process itself. Better cleanup would reduce errors but not eliminate the architecture's fragility. Every dashboard update still takes 9 hops.                                                                                   |
| Event-driven updates + 60s heartbeat                           | Keep polling interval only                          | Event-driven means dashboard updates immediately when data changes (new notification, location, calendar). Heartbeat keeps the clock fresh.                                                                                                                |
| Hybrid layout: column-split header row + full-width body       | Keep `DoubleTextWall` for all rows                  | `DoubleTextWall` forces all 5 lines into two equal columns — notifications and app content get ~288px instead of 576px. Full-width rows nearly double usable space for content. Header row still looks visually split via `ColumnComposer` on 1 line only. |
| Fix `ColumnComposer` overflow (Option B: `Math.floor` + min-1) | Option A (reduce `rightColumnWidthPx`), or leave it | Root fix — the overshoot is in the rounding, not the width config. Costs nothing visually. Keeps right column at full width. Still needed for third-party apps using `showDoubleText` even after dashboard switches away from `DoubleTextWall`.            |
| SDK wrapping layer (`breakMode`, `wrap()`) out of scope        | Fix in this PR                                      | SDK API surface decisions belong in 039-sdk-v3-api-surface. The two-layer model (SDK `"word"` for readability, `DisplayProcessor` `"character-no-hyphen"` safety net) is documented in 039 §3b.                                                            |
| Keep `NotificationRankingAgent` (LLM)                          | Simplify to recency sort                            | The LLM ranking is a real user-facing feature — ranked notifications by importance is meaningfully better than "most recent." LangChain is already a cloud dep. Cost of moving it is low.                                                                  |
| Delete unused agents                                           | Move them to cloud                                  | 8 of the 9 agents in `apps/Dashboard/src/agents/` are not called from anywhere in `index.ts`. They are dead code. Confirmed by code search.                                                                                                                |
| Phase removal of `SYSTEM_DASHBOARD_PACKAGE_NAME`               | Remove it on day 1                                  | `DisplayManager` uses the package name to route requests to `ViewType.DASHBOARD`. The constant needs to stay until the routing logic is updated, which is a separate (safe) cleanup step.                                                                  |
| `WeatherService` moves as-is                                   | Rewrite                                             | It's well-written: singleton, per-user + shared geo-bucket cache, neighbor-bucket boundary fix, LRU eviction. Zero reason to change it. Just remove the `AppSession` logger dependency.                                                                    |
