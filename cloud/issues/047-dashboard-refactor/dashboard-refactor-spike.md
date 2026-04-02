# Spike: Dashboard Mini App → Cloud OS Service

## Overview

**What this doc covers:** Investigation into killing the `system.augmentos.dashboard` mini app and moving all dashboard logic directly into the cloud's `DashboardManager`.
**Why this doc exists:** The Dashboard mini app is generating ~900–1,200 errors per minute in production — more than 60% of all cloud errors — because it constantly tries to send over a closed WebSocket. The fix is not to patch the reconnect logic; it's to eliminate the external process entirely.
**Who should read this:** Cloud engineers planning the refactor. Mobile engineers who need to understand how dashboard data flows change.

---

## Background

The MentraOS dashboard is a **head-tilt-activated contextual overlay** — users see it when they tilt their head up past a configurable angle (default 30°), provided the `contextualDashboard` setting is enabled (default: true). It shows time, battery, weather, notifications, and calendar events. It occupies `ViewType.DASHBOARD`, a separate display buffer from `ViewType.MAIN`.

**What the dashboard is not:** it is not "what you see when no foreground app is active." App activity is orthogonal — a foreground app can be actively pushing content to the main view while the user looks up to see the dashboard, then looks back down and the app content is exactly where they left it.

Currently the dashboard is implemented as a privileged SDK mini app (`system.augmentos.dashboard` / `dev.augmentos.dashboard`) that runs as a separate deployed service and communicates with the cloud via the same WebSocket protocol any third-party app uses. The cloud has a `DashboardManager` class that receives content from this mini app and assembles the final layout.

The relevant code lives in three places:

- **Mini app**: `apps/Dashboard/src/index.ts` (~1,200 lines) — the external process
- **Cloud**: `cloud/packages/cloud/src/services/session/dashboard/DashboardManager.ts` (894 lines) — the passive receiver/compositor
- **Native iOS**: `mobile/modules/core/ios/Source/CoreManager.swift` — where the actual view switching and display routing happens

---

## Findings

### 1. The error pattern and its root cause

BetterStack shows ~900–1,200 `app-server` errors per minute, all identical:

```
service: app-server
message: ❌ [Session <userId>-system.augmentos.dashboard] Error:
err.message: WebSocket not connected (current state: CLOSED)
stack: at send (sdk/dist/app/session/index.js:1216)
       at updateSystemSection (sdk/dist/app/session/dashboard.js:60)
       at setTopLeft (sdk/dist/app/session/dashboard.js:30)
       at updateDashboardSections (src/index.ts:440)
```

The mini app runs a `setInterval(() => updateDashboardSections(...), 60000)` per session. When the WebSocket closes (reconnect cycle, Cloudflare proxy timeout, pod restart), the interval keeps firing and tries to call `session.dashboard.system.setTopLeft()` — which internally calls `ws.send()` on a closed socket. The interval is only cleared in `onStop`, but `onStop` is not always called synchronously with the WS close event. When the WS reconnects, `onSession` fires again and creates a new interval — the old one may still be running.

This is not a bug to fix with better cleanup — the entire pattern (SDK call → WS → cloud → DashboardManager) is the problem. Every dashboard update is 4 hops for what is fundamentally an internal cloud operation.

### 2. How the display system actually works (verified from native source)

Before describing what to change, it's important to understand what the system actually does. Several assumptions commonly made about this system are wrong. The following is verified from reading `CoreManager.swift`, `GlassesStore.swift`, and `G1.swift`.

#### The view switch happens in native, before JS runs

The glasses view switch is not driven by JavaScript. The actual chain of events:

```
G1 glasses BLE packet (HEAD_UP / HEAD_DOWN2 device order)
  ↓
G1.swift: GlassesStore.shared.apply("glasses", "headUp", true/false)
  ↓
GlassesStore.apply() — synchronous side effects in order:
  1. CoreManager.shared.sendCurrentState()   ← glasses receive new view NOW
  2. Bridge.sendHeadUp(headUp)               ← fires JS "head_up" event AFTER
  ↓
JS: CoreModule.addListener("head_up") → MantleManager.handle_head_up(isUp)
  ├── socketComms.sendHeadPosition(isUp)     → cloud (for content cycling only)
  └── useDisplayStore.getState().setView()   → phone React mirror display only
```

`useDisplayStore.setView()` in JS controls the **phone's mirror display** (the React UI simulating glasses on screen). It has zero effect on what the physical glasses show. The glasses have already switched before JS runs.

#### Native two-buffer model (`viewStates`)

`CoreManager.swift` maintains a `viewStates` array:

```swift
var viewStates: [ViewState] = [
    ViewState(text: ""),                                              // [0] main
    ViewState(text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"), // [1] dashboard
    ViewState(text: ""),                                              // [2] unused
    ViewState(text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"), // [3] unused
]
```

`sendCurrentState()` and `displayEvent()` use only indices 0 and 1. Indices 2 and 3 exist but are not routed anywhere — likely legacy or reserved for a future always-on mode.

**The dashboard buffer starts with a default.** `viewStates[1]` is initialised with `"$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"`. On the very first head-up, before the cloud has sent any dashboard content, the user already sees current time, date, battery, and connection status — resolved live from native hardware.

#### `CoreManager.displayEvent()` — native routing

When `CoreModule.displayEvent(event)` is called from JS:

```swift
func displayEvent(_ event: [String: Any]) {
    let stateIndex = (event["view"] as? String == "dashboard") ? 1 : 0

    // Content diffing — already implemented in native
    let currentState = cS.layoutType + cS.text + cS.topText + cS.bottomText + cS.title
    let newState     = nS.layoutType + nS.text + nS.topText + nS.bottomText + nS.title
    if currentState == newState { return }  // skip — content unchanged

    viewStates[stateIndex] = newViewState

    let hUp = headUp && contextualDashboard
    if stateIndex == 0 && !hUp { sendCurrentState() }  // main arriving while showing main
    if stateIndex == 1 && hUp  { sendCurrentState() }  // dashboard arriving while showing dashboard
}
```

Key behaviour: if a dashboard display event arrives while the user's head is down, the buffer is updated but **nothing is sent to glasses**. When the user looks up, `sendCurrentState()` sends the latest buffered content — always fresh.

#### Content diffing already exists in native

If the cloud sends identical content twice, `CoreManager.displayEvent()` detects it (string comparison of full state) and returns early — no BLE send. This already protects the glasses from redundant writes. Adding diffing at the cloud layer is still worthwhile to reduce WS traffic, but it is not required for correctness.

#### Placeholder tokens are resolved twice

Token resolution (`$TIME12$`, `$DATE$`, `$GBATT$`, etc.) happens in two passes:

1. **JS pass** — `DisplayProcessor.ts` runs `replacePlaceholders()` before calling `CoreModule.displayEvent()`. Reads from React Native stores (`useGlassesStore.batteryLevel`, `new Date()`).
2. **Native pass** — `CoreManager.parsePlaceholders()` runs before BLE send to glasses. Reads battery directly from the SGC hardware interface (`sgc?.batteryLevel`).

**The native pass is the real source of truth.** If JS resolved `$GBATT$` to `"84%"` but native reads `85%` from hardware, the glasses see `85%`. The cloud only needs to send token strings — both layers will resolve them fresh.

#### `contextualDashboard` and `headUpAngle`

`sendCurrentState()` in native:

```swift
var currentViewState: ViewState!
if headUp {
    currentViewState = viewStates[1]
} else {
    currentViewState = viewStates[0]
}
// Even if head is up, stay on main if contextual dashboard is disabled
if headUp && !contextualDashboard {
    currentViewState = viewStates[0]
}
```

Default values (from `GlassesStore.swift`):

- `contextual_dashboard`: `true`
- `head_up_angle`: `30` degrees

#### `screenDisabled`

When `screen_disabled = true`, `sendCurrentState()` returns immediately — nothing sent to glasses. The `GlassesStore.apply()` side effect also calls `sgc?.exit()` which sends an explicit "turn off display" command to glasses hardware.

### 3. Current data flow (full picture)

```
Mobile client (phone)
  ├── POST /api/client/location      → cloud routes to AppSession events
  ├── POST /api/client/notifications → cloud routes to AppSession events
  ├── WS: glasses_battery_update     → DeviceManager.deviceState.battery
  ├── WS: calendar_event             → cloud routes to AppSession events
  └── settings (timezone, metric)    → UserSettingsManager.snapshot

Cloud AppManager
  └── startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)
        └── HTTP POST /webhook → Dashboard mini app (external process)

Dashboard mini app (external process, separate deployment)
  └── AppSession
        ├── subscribes: location, notifications, battery, calendar, settings
        ├── every 60s: setTopLeft() + setTopRight() + setBottomLeft()  ← 3 separate WS calls
        └── WS → cloud → DashboardManager.handleDashboardSystemUpdate()

Cloud DashboardManager
  └── assembles systemContent → generateMainLayout() → DoubleTextWall
        └── DisplayManager.handleDisplayRequest()
              └── WS → mobile JS → CoreModule.displayEvent() → native buffer
                    → BLE → glasses (only if matching current view and content changed)
```

Total hops for a time update: mobile → cloud → HTTP → mini app → WS → cloud → WS → mobile → native → BLE → glasses. **11 hops for what could be 3.**

The 3-call-per-tick problem: each of `setTopLeft`, `setTopRight`, `setBottomLeft` independently triggers a full `updateDashboard()` → immediate WS send (dashboard bypasses the 300ms throttle). 3 sends per tick, first two contain partially stale content.

### 4. What the cloud already has

Every piece of data the dashboard needs already flows through `UserSession`:

| Data                | Where it already lives in cloud                                 |
| ------------------- | --------------------------------------------------------------- |
| Time / timezone     | `userSession.userTimezone` (set by `UserSettingsManager`)       |
| Glasses battery     | `DeviceManager.deviceState.batteryLevel`                        |
| Location (lat/lng)  | Flows through `POST /api/client/location` → session events      |
| Phone notifications | Flows through `POST /api/client/notifications` → session events |
| Calendar events     | Flows through WS/REST calendar event → session events           |
| Metric system pref  | `userSession.userSettingsManager.snapshot.metric_system`        |
| Timezone pref       | `userSession.userSettingsManager.snapshot.timezone`             |

Nothing the dashboard needs is exclusive to the mini app. The mini app is subscribing to events the cloud already owns, via a roundtrip that costs 11 hops.

### 5. What is inside the mini app that needs to move

**Simple formatting logic — trivial to move:**

- `formatTimeSection()` — `Intl.DateTimeFormat` with user timezone. ~30 lines. Note: the entire function becomes unnecessary — just send `"◌ $DATE$, $TIME12$"` as a token and let native resolve it.
- `formatBatterySection()` — already returns `"$GBATT$"` token. 1 line. Keep as-is.
- `formatStatusSection()` — picks between calendar event and weather. ~70 lines.
- `formatCalendarEvent()` — formats a calendar event for display. ~55 lines.
- `formatNotificationSection()` — formats top 2 notifications. ~30 lines.

**Weather service — well-written, move directly:**

- `services/weather.service.ts` (~200 lines) — calls OpenWeatherMap API. Has per-user and shared geo-bucket caching (5km proximity buckets, 10-min TTL, LRU eviction). Already a singleton.
- Move to `cloud/packages/cloud/src/services/core/WeatherService.ts` as-is.
- `OPEN_WEATHER_API_KEY` env var: **not currently on cloud** — must be added. All other LLM-related env vars (`OPENAI_API_KEY`, `LLM_MODEL`, etc.) are already present on the cloud deployment.

**LLM notification ranking agent:**

- `agents/NotificationSummaryAgent.ts` (~160 lines) — LangChain + OpenAI. Ranks notifications by importance, generates ≤30-char summaries. Has fallback (title truncation) on LLM failure.
- LangChain and OpenAI are already cloud dependencies. Move to `cloud/packages/cloud/src/services/session/dashboard/NotificationRankingAgent.ts`.
- Remove the `AppSession` logger dependency — replace with pino logger.

**What is dead code in the mini app and gets deleted:**

- `agents/FunFactAgent.ts`, `NewsAgent.ts`, `FamousQuotesAgent.ts`, `MiraAgent.ts`, `ChineseWordAgent.ts`, `GratitudePingAgent.ts`, `TrashTalkAgent.ts`, `AgentGateKeeper.ts`, `AgentInterface.ts` — none are called from `index.ts`. Confirmed dead by code search.
- `dashboard-modules/WeatherModule.ts` — unused stub.
- `agents/tools/SearchToolForAgents.ts` — uses `SERPAPI_API_KEY`, only referenced by dead agents.

### 6. The `SYSTEM_DASHBOARD_PACKAGE_NAME` surface area

| File                               | Usage                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `app.service.ts:30`                | Defines the constant                                                                       |
| `bun-websocket.ts:323`             | `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` on phone connect                                 |
| `websocket-glasses.service.ts:178` | `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` on glasses connect                               |
| `DisplayManager6.1.ts`             | 6 special-cases: bypass priority, skip throttle, skip boot screen, route to DASHBOARD view |
| `app-settings.routes.ts`           | Skip settings validation for dashboard package                                             |
| `developer.service.ts:79`          | Commented-out `isSystemApp` check                                                          |

After migration, `DashboardManager` is a cloud-internal service — no package name, no WebSocket, doesn't go through `AppManager`. All special cases deleted in phase 2.

### 7. The layout problem: `DoubleTextWall` forces all rows into two narrow columns

`generateMainLayout()` currently returns `LayoutType.DOUBLE_TEXT_WALL`. Despite the field names `topText`/`bottomText`, these are the **left column** and **right column** on G1 — rendered side by side at 288px each.

This forces notifications and app widget content into a cramped 288px half-column. Full-width text would give nearly 2× more usable space for content that benefits from it.

**New layout:** hybrid header + full-width body:

- **Row 1**: column-split via `ColumnComposer` for just one line — time+battery left, weather/status right. Short predictable text means near-zero overflow risk.
- **Rows 2–4**: full 576px `TextWall` — notifications, app widget content.

This also sidesteps the known overflow bug in `ColumnComposer.mergeColumns()` where `Math.ceil` on space padding can push the right column start 1–5px past `rightColumnStartPx`, causing the rightmost character to wrap to the start of the next line. The bug is being fixed separately (spec §4b), but the new layout limits `ColumnComposer` to one line of short content where it's least likely to trigger.

### 8. What is NOT in scope

- Third-party app dashboard content (`mainContent`, `expandedContent` Maps in `DashboardManager`) — mini apps still call `dashboard.setContent(...)` to contribute to the rotating widget column. Protocol stays.
- `DashboardMode` handling (MAIN/EXPANDED) — stays.
- `DisplayManager` redesign (040-reliability §1) — separate issue.
- `onHeadsUp()` rotation logic — stays.
- SDK API changes (`breakMode` option on `showText`, `session.display.wrap()`) — tracked in 039-sdk-v3-api-surface.

---

## Conclusions

| Finding                          | Verdict                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Root cause of 900+/min errors    | Timer fires on closed WS — structural, not patchable                                                                 |
| View switching mechanism         | Native (CoreManager.swift), not JS — JS only drives phone mirror                                                     |
| Default dashboard content        | Always visible from first head-up — `viewStates[1]` initialized with time/battery tokens                             |
| Content diffing                  | Already in native (CoreManager.displayEvent string comparison) — cloud diffing is a nice-to-have for WS traffic only |
| Placeholder tokens               | Resolved twice — JS pass then native pass; native is source of truth                                                 |
| Data availability in cloud       | All dashboard data already in `UserSession`                                                                          |
| Weather service                  | Move directly, no changes needed except removing AppSession logger dep                                               |
| Notification ranking agent       | Move to cloud, LangChain already a dep                                                                               |
| Other agents in mini app         | Dead code, delete                                                                                                    |
| `OPEN_WEATHER_API_KEY`           | Only env var missing from cloud — must be added to deployment                                                        |
| `SYSTEM_DASHBOARD_PACKAGE_NAME`  | Remove entirely after migration                                                                                      |
| `DashboardManager` rewrite scope | Moderate — replace `systemContent` seam with direct data access, add update timer, move formatting logic in          |
| Layout change                    | Hybrid header row (ColumnComposer, 1 line) + full-width body (TextWall, rows 2–4)                                    |
| Risk                             | Low — `DashboardManager` is per-session, isolated, already tested via `DashboardTestHarness`                         |

The migration eliminates ~900–1,200 prod errors/minute, removes a separate deployment, cuts 11-hop latency to 3, and simplifies display priority logic in `DisplayManager`.

---

## Next Steps

See `dashboard-refactor-spec.md` for the full specification of the new `DashboardManager` design, data sources, and deletion checklist.
