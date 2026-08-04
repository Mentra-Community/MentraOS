# `session.navigation`

Turn-by-turn navigation for miniapps. The miniapp calls
`session.navigation.start({stops: [...]})` to kick off a trip; updates stream
in via `onUpdate` / `onRoute` / `onPivot`.

The phone-side daemon (NavigationService → Crust → Google Nav SDK) owns the
trip lifecycle. The SDK module is a thin pass-through over the bridge.

> **Platform:** Android only. iOS calls return `ok: false` at the native
> layer.

Source: [mobile/modules/miniapp/src/modules/navigation.ts](../../mobile/modules/miniapp/src/modules/navigation.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Optional: surface the Google Nav T&C dialog up front.
await session.navigation.requestPermission()

const unsubUpdate = session.navigation.onUpdate((update) => {
  switch (update.kind) {
    case "maneuver":
      console.log(`In ${update.distanceMeters}m: ${update.maneuverType}`)
      break
    case "off_route":
      console.log("user wandered off")
      break
    case "rerouting":
      console.log("recomputing…")
      break
    case "arrived":
      console.log("done")
      break
    case "error":
      console.error(update.message)
      break
  }
})

const unsubRoute = session.navigation.onRoute((route) => {
  drawPolyline(route.points)
})

await session.navigation.start({
  stops: [{lat: 37.7749, lng: -122.4194}],
  mode: "walking",
})

// later
session.navigation.stop()
unsubUpdate()
unsubRoute()
```

---

## Manifest

Navigation requires `LOCATION` in the miniapp manifest. Every gated method
on this module throws synchronously when it's missing:

```json
{
  "permissions": ["LOCATION"]
}
```

---

## API

### `hasPermission` — `boolean`

True iff `LOCATION` is declared in the miniapp's manifest. Synchronous;
reads the cached manifest record populated at `CONNECT_ACK`.

```ts
if (!session.navigation.hasPermission) {
  // navigation features won't work — prompt the user to update the manifest
}
```

---

### `requestPermission()` — `Promise<NavPermissionResult>`

Triggers the Google Nav SDK Terms & Conditions dialog up front. Call this
once when a navigation-aware miniapp mounts so the dialog is out of the way
before the user hits "start". Idempotent — resolves immediately with
`{accepted: true}` when the user has already accepted (cached in-process /
on-disk).

**Throws synchronously:**
- `{code: "PERMISSION_NOT_DECLARED"}` — manifest is missing `LOCATION`.

**Returns:** `NavPermissionResult`

```ts
type NavPermissionResult = {
  /** True if the request reached the host. False on platforms with no nav backend (e.g. iOS). */
  ok: boolean
  /**
   * True if the user has accepted the Google Nav SDK Terms & Conditions.
   * On platforms that don't gate navigation behind a T&C dialog, this is
   * always true when `ok` is true.
   */
  accepted: boolean
  error?: string
}
```

---

### `start(opts)` — `Promise<{ok: boolean; error?: string}>`

Starts a turn-by-turn trip. Pass either `{lat, lng}` for a single
destination (v1 shorthand, rewritten to a single-element `stops` array on
the wire), or `{stops: [...]}` for a multi-stop trip — last entry is the
final destination.

**Throws synchronously:**
- `{code: "PERMISSION_NOT_DECLARED"}` — manifest is missing `LOCATION`.

**Parameters:** `StartNavigationOptions`

```ts
type StartNavigationOptions = {
  /** Single-destination shorthand. Internally rewritten to `stops: [{lat, lng}]`. */
  lat?: number
  lng?: number

  /** Ordered list of stops. Must have ≥1 entry. Last entry is the destination. */
  stops?: LatLng[]

  /** Defaults to "driving" for backwards-compat with v1 starts. */
  mode?: TravelMode  // "walking" | "driving" | "cycling" | "two_wheeler"

  avoid?: {
    highways?: boolean
    tolls?: boolean
    ferries?: boolean
  }

  /** Dev/testing only — fake walking along the route at speedMultiplier×. */
  simulate?: boolean
  speedMultiplier?: number  // default 5

  /** Override mode-aware pivot-detection radii for this trip. */
  pivots?: {
    radiusMeters?: number
    approachThresholdMeters?: number
  }
}
```

**Returns:** `{ok: boolean; error?: string}` — the phone-side ack.

> ⚠️ `ok: true` means the daemon **accepted** the request, not that a route
> was successfully built. Listen via `onUpdate` for the actual nav events —
> a failed route build surfaces as `{kind: "error"}`.

**Side effects:**
- Starts pivot tracking for the trip (see [Pivots](#pivots)).
- Cancels any previously-active pivot subscriptions.

---

### `stop()` — `void`

Stops the active trip (if any). Fire-and-forget — no ack.

**Side effects:**
- Detaches pivot tracking; clears the pivot list.
- Sends `NAVIGATION_STOP` to the daemon as a one-shot (no `requestId`).

---

### `deviate(offsetMeters?)` — `void`

**Dev-only.** Nudges the simulator perpendicular to the route by
~`offsetMeters` so the Nav SDK detects an off-route condition and reroutes.
Useful for testing the reroute pipeline without physically walking off-path.

- Default `offsetMeters`: `20`.
- Android (simulated trips) only — iOS / real GPS is a no-op.
- Fire-and-forget.

---

### `onUpdate(handler)` — `UnsubscribeFn`

Subscribes to the live nav event stream. Maneuvers, off-route, rerouting,
arrival, and errors all arrive through this single stream — discriminate by
`update.kind`.

**Handler signature:** `(update: NavUpdate) => void`

```ts
type NavUpdate = NavManeuver | NavOffRoute | NavRerouting | NavArrived | NavError

type NavManeuver = {
  kind: "maneuver"
  /** One of: STRAIGHT, SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT,
   *  SHARP_LEFT, SHARP_RIGHT, U_TURN, ARRIVE. */
  maneuverType: string
  /** Meters to that maneuver. -1 if unknown. */
  distanceMeters: number
  /** Road the user is currently on. Null if unnamed / pre-first-NavInfo. */
  fromRoad?: string | null
  /** Legacy alias for `fromRoad` — prefer `nextStepRoad` for "next street" UIs. */
  toRoad?: string | null
  /** Road the user will be on AFTER the upcoming maneuver. Null if unavailable. */
  nextStepRoad?: string | null
  /** Total remaining distance to destination, meters. -1 if unknown. */
  distanceToDestinationMeters?: number
  /** Remaining travel time, seconds. -1 if unknown. */
  timeToDestinationSeconds?: number
  /** Current speed, m/s. Null if unavailable. */
  currentSpeedMps?: number | null
  /** Speed limit on the current road segment, m/s. Null if unknown / not regulated. */
  speedLimitMps?: number | null
  /** Bearing along the route at the user's position, 0–360. Null if unknown. */
  routeHeadingDeg?: number | null
}

type NavOffRoute = {
  kind: "off_route"
  /** Approximate perpendicular distance from the route, meters. */
  offRouteDistanceMeters: number
}

type NavRerouting = {kind: "rerouting"}
type NavArrived = {kind: "arrived"}
type NavError = {kind: "error"; message: string}
```

**Ordering guarantees:**
- `off_route` always fires once before the matching `rerouting`.
- `arrived` is terminal — `stop()` is implied; the pivot list is cleared.

**Returns:** `UnsubscribeFn` — call to detach.

---

### `onRoute(handler)` — `UnsubscribeFn`

Subscribes to the active route polyline. Fires once per route build — the
**full** path is delivered each time, not a diff. Fires on initial start and
on every reroute.

**Handler signature:** `(route: NavRoute) => void`

```ts
type NavRoute = {
  points: LatLng[]
  /** Total length, meters. Optional for backwards compat. */
  totalDistanceMeters?: number
  /** Engine's estimate of total travel time at trip start, seconds. */
  totalDurationSeconds?: number
  /** Ordered step list — see NavStep below. May be omitted by older hosts. */
  steps?: NavStep[]
}

type NavStep = {
  lat: number
  lng: number
  /** Index into `NavRoute.points[]` where this step starts. */
  routeIndex: number
  /** Road traversed during this step. Null when unnamed / unavailable. */
  road?: string | null
  /** Maneuver performed at the END of this step. Vocabulary == NavManeuver.maneuverType. */
  maneuver: string
  /** Length of this step in meters. */
  distanceMeters: number
}
```

**Returns:** `UnsubscribeFn`.

---

### `getState()` — `Promise<NavState | null>`

Snapshot of the active trip. Resolves to `null` when no trip is running.
Use this on mount to hydrate state for a miniapp opening mid-trip; the
streaming events take over from the next tick.

**Returns:** `NavState | null`

```ts
type NavState = {
  active: boolean
  mode?: TravelMode
  stops?: LatLng[]
  /** Index of the stop currently being navigated to (0 = first). */
  currentStopIndex?: number
  /** Last route delivered (full polyline + totals). */
  route?: NavRoute
  /** Last maneuver event observed. */
  maneuver?: NavManeuver
  /** Mirror of NavManeuver progress fields, freshened on every NavInfo tick. */
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
}
```

---

### `computeRoute(opts)` — `Promise<ComputeRouteResult>`

Computes a route **without** starting a trip. Useful for previewing a route,
showing ETA, or letting the user pick between alternates before committing.

**Throws synchronously:**
- `{code: "PERMISSION_NOT_DECLARED"}` — manifest is missing `LOCATION`.

**Parameters:** `ComputeRouteOptions`

```ts
type ComputeRouteOptions = {
  origin: LatLng
  /** ≥1 entry; last is the final destination. */
  stops: LatLng[]
  mode?: TravelMode  // default "driving"
  avoid?: RouteAvoidances
  /** Up to N alternates (engine-permitting). Default 1. */
  alternatives?: number
}
```

**Returns:** `ComputeRouteResult`

```ts
type ComputeRouteResult = {
  ok: boolean
  error?: string
  /** Primary route first, alternates after. */
  routes?: ComputedRoute[]
}

type ComputedRoute = {
  points: LatLng[]
  totalDistanceMeters: number
  totalDurationSeconds: number
  /** Polyline-aligned road labels, when supplied by the engine. */
  summary?: string
  steps?: ComputedRouteStep[]
}

type ComputedRouteStep = {
  lat: number
  lng: number
  endLat: number
  endLng: number
  distanceMeters: number
  /** Routes API maneuver enum (e.g. "TURN_LEFT", "DEPART", "DESTINATION"). */
  maneuver?: string
  /** Full natural-language instruction (e.g. "Turn left onto Fell St"). */
  instruction?: string
}
```

---

## Pivots

Pivots are **real turns** along the active route. The SDK derives them once
per route (re-derived on every reroute) from the polyline + step list. As
GPS ticks in, the SDK fires `approaching` / `entered` / `exited` events for
each pivot — backed by a per-trip radius (default 7m walking, 15m cycling,
40m driving).

This is the **recommended primary abstraction** for building turn-by-turn
UIs: resilient to the SDK's noisy `maneuverType` flicker and to GPS jitter.

The pivot list lives only while a trip is active. It's cleared on `start()`,
rebuilt on the first `onRoute` event, replaced on every reroute, and cleared
on `stop()` or arrival.

### `onPivot(handler)` — `UnsubscribeFn`

Subscribes to pivot events. Each pivot fires (in order):
1. `approaching` — once, when the user crosses the approach threshold ahead
   of the pivot.
2. `entered` — once, when the user crosses into the pivot's `radiusMeters`.
3. `exited` — once, when the user leaves the radius after entering. The
   cursor then advances to the next pivot.

Passed pivots are not re-evaluated. If the user walks back into a pivot's
radius after exiting, **no further events fire** for it.

**Handler signature:** `(event: PivotEvent) => void`

```ts
type PivotEvent =
  | {kind: "approaching"; pivot: Pivot; distanceMeters: number}
  | {kind: "entered"; pivot: Pivot}
  | {kind: "exited"; pivot: Pivot}

type Pivot = {
  /** 0-based ordinal along the route. Stable until the next `onRoute`. */
  index: number
  lat: number
  lng: number
  /** Only real turns produce pivots — STRAIGHT / NAME_CHANGE / DEPART are filtered. */
  direction: "left" | "right"
  /** Road the user approaches on. Null if unnamed / no step metadata. */
  fromRoad: string | null
  /** Road the user exits onto. Same null semantics. */
  toRoad: string | null
  /** Engine's categorical maneuver. Vocabulary == NavManeuver.maneuverType. */
  maneuver: string
  /** Meters from trip start to this pivot, along the route. */
  distanceAlongRouteMeters: number
  /** "You are turning now" radius for this pivot, meters. */
  radiusMeters: number
}
```

```ts
session.navigation.onPivot((event) => {
  if (event.kind === "entered") {
    showInstruction(`Turn ${event.pivot.direction} onto ${event.pivot.toRoad}`)
  }
})
```

### `getPivots()` — `Pivot[]`

Full pivot list for the active route. Empty when no trip is running or the
first `onRoute` hasn't arrived yet. Stable across the lifetime of one route
build — only a reroute replaces it.

### `getActivePivot()` — `Pivot | null`

The pivot the user is **currently inside the radius of**, or `null` when
they aren't actively in a turn. Defined as: a pivot is "active" between its
`entered` and `exited` events. Use this to render the "you are turning now"
UI state.

### `getUpcomingPivot()` — `Pivot | null`

The next pivot ahead of the user along the route, regardless of distance.
`null` when the user has passed every pivot (final approach to destination).
Use this to render the "approaching <road>" countdown UI.

### Pivot tuning

Override the mode-aware defaults via `StartNavigationOptions.pivots`:

```ts
session.navigation.start({
  stops: [{lat, lng}],
  mode: "walking",
  pivots: {
    radiusMeters: 5,          // tighter "turning now" radius
    approachThresholdMeters: 60,
  },
})
```

| Mode | Default `radiusMeters` | Default `approachThresholdMeters` |
| --- | --- | --- |
| `walking` | 7 | 100 |
| `cycling` | 15 | 300 |
| `driving` | 40 | 800 |
| `two_wheeler` | — falls back to driving / cycling defaults — | |

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | `start`, `requestPermission`, `computeRoute` (sync throw) | `LOCATION` missing from miniapp manifest. |
| `NavError` `{kind: "error", message}` | `onUpdate` stream | Host-side failure during the trip (e.g. route build failed, GPS lost permanently, T&C declined). |

`PERMISSION_NOT_DECLARED` is thrown **synchronously**, not via a rejected
Promise — wrap the call site, not just `await`:

```ts
try {
  await session.navigation.start({lat, lng})
} catch (e) {
  // PERMISSION_NOT_DECLARED is thrown before the Promise is created,
  // so it's caught here too — but only because the try/catch surrounds
  // the call, not the await.
}
```

---

## Platform notes

- **Android:** Full support via Google Nav SDK. T&C dialog handled by
  `requestPermission()`.
- **iOS:** All methods return `ok: false` at the native layer.
  `requestPermission()` resolves with `{ok: false, accepted: false}`. The
  pivot APIs still work in-process if you feed them a route via mock
  transport, but no real GPS-driven trip will run.

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `requestPermission` | `NAVIGATION_REQUEST_PERMISSION` | `REQUEST_RESULT` with `data: NavPermissionResult` |
| `start` | `NAVIGATION_START` (`{lat, lng, stops, mode, avoid, simulate, speedMultiplier}`) | `REQUEST_RESULT` with `data: {ok, error?}` |
| `stop` | `NAVIGATION_STOP` (one-shot, no `requestId`) | — |
| `deviate` | `NAVIGATION_DEVIATE` (`{offsetMeters}`, one-shot) | — |
| `getState` | `NAVIGATION_GET_STATE` | `REQUEST_RESULT` with `data: {ok, state?: NavState \| null}` |
| `computeRoute` | `NAVIGATION_COMPUTE_ROUTE` (`{origin, stops, mode, avoid, alternatives}`) | `REQUEST_RESULT` with `data: ComputeRouteResult` |

Streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onUpdate` | `NAVIGATION_UPDATE` | `NavUpdate` |
| `onRoute` | `NAVIGATION_ROUTE` | `NavRoute` |

Pivot events (`onPivot`) are **SDK-local** — derived from `onRoute` +
`session.location` ticks. They are not sourced from a phone-side stream.

---

## Tests

Integration tests for this module live at
[sdk/Navigation/src/test/navigation.test.ts](../Navigation/src/test/navigation.test.ts).
Run with `bun test` from `sdk/Navigation/`.
