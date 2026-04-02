# Dashboard Architecture

> Part of the MentraOS `.architecture` series. See also: `architecture.md` (full system), `auth.md` (auth flows).

## Overview

The MentraOS dashboard is a **gesture-activated contextual overlay** — users see it when they tilt their head up past a configurable angle. It shows time, battery, weather, notifications, and calendar events. It occupies `ViewType.DASHBOARD`, a separate display buffer from `ViewType.MAIN`.

This document covers:

- What the dashboard actually is and when it appears (not what was assumed)
- The two-buffer model — how main and dashboard views are maintained and switched
- The full display event pipeline: cloud → WS → mobile JS → native → BLE → glasses
- Where placeholder tokens are resolved (spoiler: twice, and native is the real source of truth)
- Content diffing — already implemented in native, not something we need to add
- How `DashboardManager` generates and sends content
- The current mini app architecture, its problems, and what changes in the refactor
- Optimization gaps: redundant sends, missing token usage

---

## What the Dashboard Actually Is

The dashboard is NOT "what you see when no foreground app is active." That framing is wrong.

The dashboard is a **head-tilt-activated overlay**, independent of whether any app is running:

```
User looks UP past headUpAngle (default: 30°)
  AND contextualDashboard setting = true (default: true)
  → glasses show dashboard view

User looks DOWN (or contextualDashboard = false)
  → glasses show main view
```

A foreground app can be actively pushing display content to the main view, and the user can still look up to see the dashboard, then look back down and the app content is exactly where they left it. The two views are maintained independently.

**The main view** (head down) shows one of:

- Active app display content (captions, navigation, whatever the foreground app is sending)
- Empty / blank if no app has an active display request
- `screenDisabled = true` → nothing at all (screen off mode)

---

## The View Switch: Native First, JS Second

This is the most important thing to get right. The glasses view switch happens **entirely in native before JavaScript knows about it.**

### Actual chain of events

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
  ├── socketComms.sendHeadPosition(isUp)     → cloud (for app content cycling only)
  └── useDisplayStore.getState().setView()   → phone React mirror display only
```

`useDisplayStore.setView()` controls the **phone's mirror display** (the React UI that shows a simulation of the glasses on-screen). It has zero effect on what the physical glasses display. The glasses have already switched by the time JS runs.

### `contextualDashboard` enforcement

`sendCurrentState()` in `CoreManager.swift`:

```swift
var currentViewState: ViewState!
if headUp {
    currentViewState = self.viewStates[1]  // dashboard buffer
} else {
    currentViewState = self.viewStates[0]  // main buffer
}
// Override: if head is up but contextual dashboard is off, stay on main
if headUp && !self.contextualDashboard {
    currentViewState = self.viewStates[0]
}
```

Default values (from `GlassesStore.swift`):

- `contextual_dashboard`: `true`
- `head_up_angle`: `30` degrees

---

## The Two-Buffer Model

Native `CoreManager.swift` maintains a `viewStates` array:

```swift
var viewStates: [ViewState] = [
    ViewState(text: ""),                                               // [0] main
    ViewState(text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"),   // [1] dashboard
    ViewState(text: ""),                                               // [2] purpose unclear
    ViewState(text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"),   // [3] purpose unclear
]
```

`sendCurrentState()` and `displayEvent()` only use indices 0 and 1. Indices 2 and 3 exist in the code but are not routed anywhere in the current implementation — likely legacy or reserved for a future alwaysOn mode.

**The dashboard buffer starts with a default value.** `viewStates[1]` is initialized with `"$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"`. On the very first head-up, before the cloud has sent any dashboard content, the user already sees current time, date, battery, and connection status. This is resolved live from native at display time.

### `screenDisabled`

When `screen_disabled = true`, `sendCurrentState()` returns immediately — nothing is sent to glasses. Setting this via `GlassesStore.apply()` also calls `sgc?.exit()` which sends an explicit "turn off display" command to the glasses hardware.

---

## Display Event Pipeline

### Cloud → Mobile

`DisplayManager.sendDisplay()` → `sendToWebSocket()` serializes the `DisplayRequest` as JSON and sends it over the mobile WebSocket:

```json
{
  "type": "display_event",
  "view": "dashboard",
  "packageName": "dev.augmentos.dashboard",
  "layout": {
    "layoutType": "text_wall",
    "text": "◌ $DATE$, $GBATT$"
  },
  "timestamp": "2026-03-12T23:00:00.000Z"
}
```

The `view` field is either `"dashboard"` or `"main"`. Nothing else is valid.

### Mobile JS processing

`SocketComms.handle_display_event(msg)`:

```
1. displayProcessor.processDisplayEvent(msg)
   ├── replacePlaceholders(text)     ← resolves $TOKEN$ in JS (see §Placeholder Tokens)
   └── wrapText(text)                ← fits text to device display profile

2. CoreModule.displayEvent(processedEvent)
   └── calls native CoreManager.displayEvent() — see below

3. useDisplayStore.getState().setDisplayEvent(JSON.stringify(processedEvent))
   └── updates dashboardEvent or mainEvent buffer in React state (phone mirror only)
```

### Native routing: `CoreManager.displayEvent()`

```swift
func displayEvent(_ event: [String: Any]) {
    let view = event["view"] as? String
    let isDashboard = view == "dashboard"
    let stateIndex = isDashboard ? 1 : 0

    // Parse layout from event
    let layout = event["layout"] as! [String: Any]
    // ... build ViewState ...

    // Content diffing — already implemented
    let currentState = cS.layoutType + cS.text + cS.topText + cS.bottomText + cS.title
    let newState     = nS.layoutType + nS.text + nS.topText + nS.bottomText + nS.title
    if currentState == newState { return }  // skip — content unchanged

    viewStates[stateIndex] = newViewState

    let hUp = headUp && contextualDashboard
    // Only send to glasses if this matches the currently active view
    if stateIndex == 0 && !hUp    { sendCurrentState() }  // main arriving while showing main
    if stateIndex == 1 && hUp     { sendCurrentState() }  // dashboard arriving while showing dashboard
}
```

**Key behaviour**: if a dashboard display event arrives while the user's head is down, the buffer is updated but nothing is sent to glasses. When the user looks up, `sendCurrentState()` sends the latest buffered content. The glasses always see fresh content on view switch.

### Native → glasses (BLE)

`sendCurrentState()` calls `sgc?.sendTextWall(text)` (or `sendDoubleTextWall`, `displayBitmap`, etc. depending on layout type) which sends the formatted content over BLE to the glasses hardware.

---

## Placeholder Token System

Placeholder tokens are resolved **in two passes**. Both passes read live device state.

### Pass 1 — JavaScript (`DisplayProcessor.ts`)

Runs before passing to `CoreModule.displayEvent()`. Reads from React Native stores.

| Token                 | Value                 | Source                         |
| --------------------- | --------------------- | ------------------------------ |
| `$TIME12$`            | `"3:45 PM"`           | `new Date()`                   |
| `$TIME24$`            | `"15:45"`             | `new Date()`                   |
| `$DATE$`              | `"3/12"`              | `new Date()`                   |
| `$GBATT$`             | `"85%"` or `""`       | `useGlassesStore.batteryLevel` |
| `$CONNECTION_STATUS$` | `"Connected"` or `""` | `useGlassesStore.connected`    |
| `$no_datetime$`       | `"3/12, 3:45 PM"`     | combined date + time           |

### Pass 2 — Native Swift (`CoreManager.parsePlaceholders()`)

Runs before sending BLE to glasses. Reads from native stores directly.

```swift
placeholders["$TIME12$"] = time12Format.string(from: Date())
placeholders["$DATE$"]   = dateFormat.string(from: Date())
placeholders["$GBATT$"]  = "\(sgc!.batteryLevel)%"  // direct from BLE hardware
placeholders["$CONNECTION_STATUS$"] = "Connected"   // TODO: implement
```

**The native pass is the source of truth** — it reads battery level directly from the SGC (smart glasses controller) hardware interface, not from React state. If the JS pass resolved `$GBATT$` to `"84%"` but the native pass reads `85%` from hardware, the glasses see `85%`.

**Implication for the dashboard refactor**: the cloud only needs to send `"$DATE$, $GBATT$"` as tokens in the layout. Both JS and native will resolve them fresh at display time. No clock-update sends needed at all — the native layer always shows the current time.

---

## Content Diffing — Already Implemented

The spec for the dashboard refactor originally listed "add content diffing before sending" as a to-do. **This already exists in native.** `CoreManager.displayEvent()` concatenates the full state of the current and new `ViewState` structs and returns early if they match (see code above).

The cloud sending duplicate content is wasteful over the wire but native silently drops it before the glasses see it. Content diffing at the cloud layer is still worth doing to reduce unnecessary WebSocket traffic, but it is not required for correctness.

---

## DisplayProcessor: Text Wrapping

After placeholder replacement, `DisplayProcessor` wraps text to fit the device display. Each device model has a `DisplayProfile` with pixel-width font metrics and max line counts.

```
DEVICE_PROFILES = {
  "g1":           G1_PROFILE,    // 576px wide, 5 lines, pixel-accurate glyph widths
  "g2":           G2_PROFILE,
  "z100":         Z100_PROFILE,
  "nex":          NEX_PROFILE,
  "mentra-live":  G1_PROFILE,    // camera glasses — no display, uses G1 as fallback
  "simulated":    G1_PROFILE,
}
```

Default break mode in `DisplayProcessor`: `"character-no-hyphen"` — breaks mid-character without hyphen. This is intentionally conservative: the DisplayProcessor is a **safety net**, not a formatter. It preserves intentional developer formatting (explicit `\n` breaks, pre-wrapped arrays) and only breaks what physically overflows.

See `039-sdk-v3-api-surface §3b` for the two-layer wrapping model (SDK wraps with `"word"` for readability, DisplayProcessor `"character-no-hyphen"` as safety net).

**`double_text_wall` handling**: `processDoubleTextWall()` takes `topText` (left column) and `bottomText` (right column), runs them through `ColumnComposer.composeDoubleTextWall()`, and converts the result to a single `text_wall` before passing to native. Despite the field names, on G1 these are rendered **left and right columns**, not top and bottom. The native layer never sees `double_text_wall` — it only sees the pre-composed `text_wall` string.

There is a known overflow bug in `ColumnComposer.mergeColumns()` where `Math.ceil` on space padding can push the right column start 1–5px past `rightColumnStartPx`, causing the rightmost character to wrap to the start of the next line. Fix tracked in `047-dashboard-refactor §4b`.

---

## DashboardManager (Cloud)

`DashboardManager` lives on `UserSession` — one instance per connected user. It is the single source of truth for what gets sent to `ViewType.DASHBOARD`.

### Responsibilities

1. **Receive system section updates** from the dashboard mini app (`handleDashboardSystemUpdate`) — stores to `systemContent.{topLeft, topRight, bottomLeft, bottomRight}`
2. **Receive third-party app widget content** (`handleDashboardContentUpdate`) — stores to `mainContent`, `expandedContent` Maps keyed by `packageName`
3. **Generate layouts** (`generateMainLayout`, `generateExpandedLayout`) — composes system content + rotating app widget into a layout
4. **Send display requests** to `userSession.displayManager.handleDisplayRequest()` → WS to mobile
5. **Handle head-up gestures** (`onHeadsUp`) — cycles `mainContentRotationIndex` and re-renders

### Layout Composition (Current, pre-refactor)

`topText` = left column, `bottomText` = right column (despite the field names):

```
MAIN mode → DoubleTextWall (rendered as left/right on G1):

  topText  = LEFT column:
    systemContent.topLeft                   ← "◌ 3/12, $GBATT$"   (time + battery token)
    [+ "\n" + systemContent.bottomLeft]     ← notification, if present

  bottomText = RIGHT column:
    systemContent.topRight                  ← "Sunny, 72°F"        (weather/calendar)
    [+ "\n" + getNextMainAppContent()]      ← rotating app widget

  → ColumnComposer merges into single pre-composed TextWall before mobile sends to glasses
```

The `systemContent` four-quadrant struct maps to the display like this:

| Field         | Column | Position       | Content            |
| ------------- | ------ | -------------- | ------------------ |
| `topLeft`     | Left   | Top            | Time + battery     |
| `bottomLeft`  | Left   | Below topLeft  | Notifications      |
| `topRight`    | Right  | Top            | Weather / calendar |
| `bottomRight` | Right  | Below topRight | (currently unused) |

### Display Request Path

```
DashboardManager.updateDashboard()
  └── generateMainLayout() → Layout
  └── sendDisplayRequest({
        packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
        view: ViewType.DASHBOARD,
        layout,
        timestamp: new Date()
      })
      └── userSession.displayManager.handleDisplayRequest(req)
            └── sendDisplay(req)       ← dashboard bypasses priority/boot logic
                  └── isDashboard check: skip 300ms throttle
                        └── sendToWebSocket() → mobile WS
```

**Dashboard requests bypass the 300ms throttle** entirely. Every `updateDashboard()` call results in an immediate WS send to mobile. Combined with 3 SDK calls per tick (see below), this means 3 unthrottled sends per update cycle.

---

## The Mini App Architecture (Current, Being Killed)

`system.augmentos.dashboard` (`dev.augmentos.dashboard` in dev) is a separate deployed Node.js process. It connects to the cloud exactly like any third-party SDK app — webhook + WebSocket.

### Startup

On phone/glasses connect (`bun-websocket.ts`, `websocket-glasses.service.ts`):

```
appManager.startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)
  └── POST /webhook → Dashboard mini app server
        └── creates AppSession
              └── subscribes to: location, notifications, battery, calendar, settings
              └── starts setInterval(60s) → updateDashboardSections()
```

### Per-Update Data Flow (the problem)

Every 60 seconds (plus on each data event):

```
Dashboard mini app: updateDashboardSections()
  ├── formatTimeSection()     → Intl.DateTimeFormat() server-side  ← WRONG: use $TIME12$
  ├── formatBatterySection()  → returns "$GBATT$"                  ← correct, uses token
  ├── formatStatusSection()   → calendar event OR weather string
  └── formatNotificationSection()

  Then — 3 SEPARATE SDK calls:
  session.dashboard.system.setTopLeft(topLeftText)   → SDK call 1
  session.dashboard.system.setTopRight(topRight)     → SDK call 2
  session.dashboard.system.setBottomLeft(bottomLeft) → SDK call 3

Each SDK call individually:
  mini app WS send
    → cloud: AppManager.handleAppMessage()
      → DashboardManager.handleDashboardSystemUpdate()
        → DashboardManager.updateDashboard()          ← full re-render per section
          → DisplayManager.sendDisplay()              ← immediate WS send (no throttle)
            → mobile WS → processDisplayEvent()
              → CoreModule.displayEvent()
                → native content-diff check
                  → BLE to glasses (if view matches and content changed)
```

**3 SDK calls → 3 full `updateDashboard()` → 3 WS sends to mobile per tick.**

The first two sends contain partial/stale content (only one section updated). The third is the first with all sections current. Mobile and native receive all 3; native's content-diff check will drop the first two if they're actually different from prior state.

### Error Pattern

```
service: app-server
message: ❌ [Session <userId>-system.augmentos.dashboard] Error:
err:     WebSocket not connected (current state: CLOSED)
stack:   at setTopLeft → updateDashboardSections (src/index.ts:440)
```

Rate: **~900–1,200 errors/minute** in production (>60% of all cloud errors). The 60s `setInterval` fires on a closed WS. `onStop` is not synchronously guaranteed to fire before the interval.

### Data Sources in the Mini App

| Data            | How mini app gets it                           | Cloud already has it?                                              |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Time/timezone   | `Intl.DateTimeFormat` + `session.settings`     | Yes — `userSession.userTimezone`. But use `$TIME12$` token instead |
| Battery level   | `session.events.onBatteryUpdate()`             | Yes — `DeviceManager.deviceState`                                  |
| Location        | `session.events.onLocationUpdate()`            | Yes — flows through `POST /api/client/location`                    |
| Weather         | `WeatherService.getWeather()` (OpenWeatherMap) | No — needs `OPEN_WEATHER_API_KEY` added to cloud env               |
| Notifications   | `session.events.onPhoneNotification()`         | Yes — flows through notification endpoint                          |
| Calendar events | `session.events.onCalendarEvent()`             | Yes — flows through calendar endpoint                              |
| Metric pref     | `session.settings.getMentraosSetting(...)`     | Yes — `userSession.userSettingsManager.snapshot`                   |

### Notification Ranking Agent

`NotificationSummaryAgent` — LangChain + OpenAI. Ranks incoming notifications by importance and generates ≤30-char summaries. LangChain and OpenAI are already cloud dependencies. Moving to cloud is low effort.

---

## The SYSTEM_DASHBOARD_PACKAGE_NAME Constant

```typescript
export const SYSTEM_DASHBOARD_PACKAGE_NAME = process.env.SYSTEM_DASHBOARD_PACKAGE_NAME || "dev.augmentos.dashboard"
```

Used as a sentinel in 6 files:

| File                           | Usage                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `DisplayManager6.1.ts`         | 6 special-cases: bypass priority/throttle, skip boot screen, route to DASHBOARD view |
| `bun-websocket.ts`             | `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` on phone connect                           |
| `websocket-glasses.service.ts` | `startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)` on glasses connect                         |
| `app-settings.routes.ts`       | Skip settings validation for dashboard package                                       |
| `DashboardManager.ts`          | `handleDashboardSystemUpdate`: only accepts from this package                        |
| `developer.service.ts`         | Commented-out `isSystemApp` check                                                    |

All of these are deleted in phase 2 of the kill sequence after the mini app is gone.

---

## Optimization Gaps (Current System)

### 1. Time not using placeholder tokens

Mini app computes `"◌ 3/12, 3:45pm"` server-side and sends it. Glasses show stale time for up to 60s. Should be `"◌ $DATE$, $TIME12$"` — native resolves it fresh on every render pass. Eliminates the 60s heartbeat send entirely for clock updates.

### 2. Three sends per tick instead of one

Each of `setTopLeft`, `setTopRight`, `setBottomLeft` independently triggers `updateDashboard()` → immediate WS send. Batching all three into a single `updateDashboard()` call reduces sends by 3×.

### 3. Redundant cloud-side sends

Even after batching, if the rendered content is identical to the last send (e.g. weather hasn't changed), the cloud still sends over the wire. Worth adding a diff at the cloud layer to reduce WS traffic, even though native's content-diff protects the glasses from redundant BLE writes.

---

## After the Refactor (Target State)

See `cloud/issues/047-dashboard-refactor/` for full spec. Summary:

```
Before:
  External mini app (separate deployment) → sends systemContent via WS
  UserSession.dashboardManager ← passive receiver of systemContent

After:
  UserSession.dashboardManager ← active service, owns everything
    ├── weatherCache          ← WeatherService (moved from mini app)
    ├── notificationCache     ← wired to UserSession notification handler
    ├── notificationRanking   ← NotificationRankingAgent (moved from mini app)
    ├── calendarEvent         ← wired to UserSession calendar handler
    ├── heartbeatTimer        ← 60s, replaces mini app setInterval
    └── updateTimer           ← 500ms coalesce debounce, replaces 3-sends-per-tick

  External mini app → DELETED
  systemContent struct (topLeft/topRight/bottomLeft/bottomRight) → DELETED
  SYSTEM_DASHBOARD_PACKAGE_NAME special-cases → DELETED (phase 2)
```

Layout change — hybrid header row + full-width body:

```
G1 — new MAIN mode:
┌────────────────────────────────────────────────────────┐
│ ◌ $DATE$, $GBATT$              Sunny, 72°F             │  ← row 1: column-split via ColumnComposer (1 line)
│ Alex: let's sync tmr                                   │  ← row 2: full 576px width
│ Meeting @ 4pm                                          │  ← row 3: full width
│ [app widget — full width]                              │  ← row 4: full width
│                                                        │  ← row 5: spare
└────────────────────────────────────────────────────────┘
```

Row 1 uses `ColumnComposer` for 1 line only (short predictable content = near-zero overflow risk). Rows 2–4 are full-width TextWall — zero column math, ~2× more content space vs the current cramped 288px left column.

Expected impact: **elimination of ~900–1,200 errors/minute** in production.

---

## Reference: Message Types

### Cloud → Mobile (`display_event`)

```typescript
{
  type: "display_event",
  view: "main" | "dashboard",
  packageName: string,
  layout: Layout,           // text_wall, double_text_wall, reference_card, bitmap_view
  timestamp: Date,
  durationMs?: number,
  forceDisplay?: boolean,
}
```

### Mobile → Cloud (`head_position`)

```typescript
{
  type: "head_position",
  position: "up" | "down",
  timestamp: number,
}
```

Cloud receives `head_position` → `dashboardManager.onHeadsUp()` — cycles third-party app widget rotation only. Does NOT control what the glasses display (that's already handled in native before this message is even sent).

---

## Directory Map

```
cloud/packages/cloud/src/
  services/
    layout/
      DisplayManager6.1.ts             ← routes display requests, sends WS to mobile
    session/
      dashboard/
        DashboardManager.ts            ← generates dashboard content, sends to DisplayManager
  services/websocket/
    bun-websocket.ts                   ← starts dashboard mini app on connect (to be removed)
    websocket-glasses.service.ts       ← starts dashboard mini app on connect (to be removed)

mobile/src/
  services/
    DisplayProcessor.ts                ← placeholder replacement (pass 1) + text wrapping
    SocketComms.ts                     ← handle_display_event: process → CoreModule.displayEvent
    MantleManager.ts                   ← handle_head_up: sends to cloud + updates phone mirror
  stores/
    display.ts                         ← two-buffer React state (phone mirror only, not glasses)

mobile/modules/core/ios/Source/
  CoreManager.swift                    ← displayEvent(), sendCurrentState(), parsePlaceholders()
  GlassesStore.swift                   ← observable store; headUp change → sendCurrentState()
  sgcs/G1.swift                        ← BLE: HEAD_UP/HEAD_DOWN2 → GlassesStore.apply("glasses","headUp",...)

apps/Dashboard/src/
  index.ts                             ← DashboardServer (mini app, ~1200 lines) — TO BE DELETED
  agents/NotificationSummaryAgent.ts   ← LLM ranking — TO MOVE TO CLOUD
  services/weather.service.ts          ← WeatherService — TO MOVE TO CLOUD
```
