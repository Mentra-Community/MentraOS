MentraOS/cloud/packages/cloud/src/api/client/docs/design-location-manager.md

# Design: LocationManager and REST Location API (Cloud-only)

This document specifies a session-scoped LocationManager and a REST-first location update API that mirrors the CalendarManager pattern. It replaces DB persistence for location with in-memory session state while preserving backward compatibility for legacy WebSocket (WS) flows and the SDK.

Scope

- Cloud-only changes (no SDK changes in this phase).
- Introduce a LocationManager attached to each UserSession.
- Add a REST endpoint for mobile clients to send location updates and poll responses.
- Keep legacy WebSocket behavior functional (device-originated updates and commands).
- Minimize database persistence: use DB only as a "cold cache" (read once on session init, write once on session dispose).

Non-goals

- Changing SDK contracts (Apps still receive `CloudToAppMessageType.DATA_STREAM` with `streamType="location_update"`).
- Live/continuous DB persistence during active sessions (location is only read/written at session boundaries).
- Rewriting App subscription semantics.

---

## 1) Current State (Summary)

Where location logic lives today:

- Device → Cloud (WebSocket): `LOCATION_UPDATE`
  - `websocket-glasses.service.ts` delegates to `location.service.ts::handleDeviceLocationUpdate(userSession, message)`.
  - Broadcast updates (no correlationId) are forwarded to subscribed Apps.
  - Poll responses (with `correlationId`) are targeted to the requesting App.
  - The last location is persisted to `User.location` in DB (to serve initial cached responses).
- App → Cloud (WebSocket) poll:
  - Apps send `AppToCloudMessageType.LOCATION_POLL_REQUEST` with `correlationId`, `accuracy`.
  - `location.service.ts` tracks pending polls (correlationId → packageName).
  - If location cache is fresh enough, respond immediately; otherwise request a single-fix from device via `REQUEST_SINGLE_LOCATION`.
- App → Cloud (WebSocket) subscriptions:
  - Apps subscribe to `StreamType.LOCATION_UPDATE` or `location_stream` with an accuracy tier.
  - Legacy code computes an “effective” tier (arbitration of all app rates), persists to DB, and sends `SET_LOCATION_TIER` to device.
- SDK:
  - `session.location.subscribeToStream({ accuracy }, handler)`
  - `await session.location.getLatestLocation({ accuracy })`
  - Poll is satisfied by a matching `"location_update"` with the same `correlationId`.

Pain points:

- Location data is persisted in DB and used as cache, which we want to avoid.
- Tier arbitration and state are split across services and DB.
- No REST-first path analogous to calendar.
- Location data persisted to DB on every update (unnecessary DB writes during active sessions).

---

## 2) Target Architecture (E2E Overview)

2.1 Session-scoped LocationManager

- Ownership:
  - Attach `locationManager` to `UserSession`.
- Responsibilities:
  - Maintain last known location in-memory (source of truth during active session).
  - Handle device-originating updates (WebSocket) and client-originating updates (REST API).
  - Manage pending poll requests (correlationId to packageName routing).
  - Handle subscription changes (compute an in-memory effective tier and notify device if WebSocket is connected).
  - Broadcast vs. targeted responses:
    - Broadcast (`no correlationId`): `userSession.relayMessageToApps({ type: location_update, ... })`.
    - Targeted (`correlationId present and pending`): send directly to the requesting App via `CloudToAppMessageType.DATA_STREAM`.
  - Seed initial location from DB "cold cache" on session init.
  - Persist final location to DB "cold cache" on session dispose.
- No live database writes during active session (only at session boundaries).

  2.2 REST Location API (client → cloud)

- Path: `/api/client/user/location`
  - POST `{ location: { lat, lng, accuracy?, timestamp?, correlationId? } }`
  - Auth: Bearer JWT via `clientAuthWithUserSession` (requires active session).
  - Calls: `userSession.locationManager.updateFromAPI(location)`
  - Behavior:
    - Normalize and set timestamp if missing.
    - If `correlationId` matches a pending poll, resolve it and send a targeted response to the App.
    - Otherwise, set as lastLocation and broadcast to subscribed Apps.

      2.3 WebSocket behavior unchanged (back-compat)

- Device WebSocket `LOCATION_UPDATE` → `locationManager.updateFromWebsocket(message)`
- Device WebSocket `SET_LOCATION_TIER` and `REQUEST_SINGLE_LOCATION` remain the commands we send to devices when needed.
- On App subscription changes, compute effective tier in-memory and command the device as necessary.

---

## 3) LocationManager Responsibilities and API

State (session-scoped; in-memory):

- `lastLocation?: { lat: number; lng: number; timestamp: Date; accuracy?: number | null; altitude?: number | null; altitudeAccuracy?: number | null; heading?: number | null; speed?: number | null }`
  - Internally supports storing additional fields compatible with Expo LocationObjectCoords for future SDK expansion. Current SDK broadcast remains unchanged (lat/lng/accuracy/timestamp).
- `pendingPolls: Map<string /* correlationId */, string /* packageName */>`
- `effectiveTier?: string` — computed from current app subscriptions (e.g., `"realtime" | "high" | "standard" | "tenMeters" | "hundredMeters" | "kilometer" | "threeKilometers" | "reduced"`)

Public methods:

- `updateFromAPI(location: { lat; lng; accuracy?; timestamp?; correlationId? } | ExpoCoords): Promise<void>`
  - REST API entrypoint from mobile client; normalize location (including mapping from Expo LocationObjectCoords); set timestamp; if correlationId pending → targeted reply; else → update `lastLocation` and broadcast to subscribed Apps.
- `updateFromWebsocket(update: LocationUpdate): void`
  - WebSocket entrypoint for device-originating updates; handle targeted poll replies (correlationId) vs. broadcast; update `lastLocation` for broadcast updates.
- `getLastLocation(): { lat; lng; accuracy?; timestamp } | undefined`
  - Used for replay when an App newly subscribes to `location_update`.
- `handlePollRequestFromApp(accuracy: string, correlationId: string, packageName: string): Promise<void>`
  - If `lastLocation` meets freshness for requested accuracy → target reply immediately.
  - Else if device WebSocket is open → send `REQUEST_SINGLE_LOCATION` with correlationId and record a pending poll.
  - Else → leave pending; expect client REST to fulfill with matching correlationId.
- `onSubscriptionChange(appSubscriptions): void`
  - Compute in-memory effective tier across all Apps.
  - If device WebSocket is connected, send `SET_LOCATION_TIER` with the new tier.
- `setEffectiveTier(tier: string): void`
  - Update in-memory and optionally notify device.
- `dispose(): Promise<void>`
  - Persist final location to DB cold cache and clear in-memory state at session end.

Internal helpers:

- Tier definitions and freshness:
  - Define max cache age per tier (e.g., `realtime: 1s`, `high: 10s`, `standard: 30s`, `tenMeters: 30s`, `hundredMeters: 60s`, `kilometer: 5m`, `threeKilometers: 15m`, `reduced: 15m`).
  - A cached location is “fresh enough” if `now - lastLocation.timestamp <= maxCacheAge(tier)`.
- Broadcast:
  - `userSession.relayMessageToApps({ type: StreamType.LOCATION_UPDATE, ... })`.
- Targeted response:
  - Build `DataStream` with `streamType=StreamType.LOCATION_UPDATE` and `data: LocationUpdate` only for the requesting App websocket.
- Device commands:
  - `SET_LOCATION_TIER` and `REQUEST_SINGLE_LOCATION` via device WebSocket as needed.
- DB cold cache seeding:
  - On LocationManager construction, asynchronously seed `lastLocation` from `User.location` (one-time read).
- DB cold cache persistence:
  - On `dispose()`, write `lastLocation` to `User.location` (one-time write).

---

## 4) SDK Usage (for reference; no changes required)

Developers use the SDK LocationManager via `session.location`:

- Subscribe to continuous stream:
  - `session.location.subscribeToStream({ accuracy }, handler)`
  - Cleanup: call the returned function or `session.location.unsubscribeFromStream()`

- One-time intelligent poll:
  - `await session.location.getLatestLocation({ accuracy })`
  - SDK sends `LOCATION_POLL_REQUEST`, listens for `location_update` with matching `correlationId`.

Example:

```/dev/null/sdk-location-usage.ts#L1-40
// Subscribe
const unsubscribe = session.location.subscribeToStream(
  { accuracy: "high" },
  (update) => {
    console.log("Streaming location:", update.lat, update.lng, update.accuracy);
  }
);

// Poll
try {
  const fix = await session.location.getLatestLocation({ accuracy: "hundredMeters" });
  console.log("Polled location:", fix.lat, fix.lng, fix.accuracy);
} catch (e) {
  console.error("Poll failed:", e);
}

// Cleanup
unsubscribe();
```

---

## 5) Message Contracts (Cloud↔App, Cloud↔Device)

Cloud→App (unchanged):

- Broadcast stream:
  - `type: CloudToAppMessageType.DATA_STREAM`
  - `streamType: StreamType.LOCATION_UPDATE`
  - `data: { type: "location_update", lat, lng, accuracy?, timestamp, correlationId? }`
- Targeted poll response:
  - Same shape as above, delivered only to the requesting App websocket, correlationId matches the request.

App→Cloud (unchanged):

- Poll request:
  - `type: AppToCloudMessageType.LOCATION_POLL_REQUEST`
  - `correlationId`, `accuracy`, `packageName`, `sessionId`

Cloud→Device:

- `SET_LOCATION_TIER` (when effective tier changes)
- `REQUEST_SINGLE_LOCATION` (when a poll needs a hardware fix)

---

## 6) REST API (Client→Cloud)

Base path: `/api/client/location`

- POST `/` (location update) // Full path: /api/client/location
  - Auth: Bearer JWT; requires an active `UserSession`.
  - Body (supports simple lat/lng and also Expo LocationObjectCoords mapping):
    - Basic: `{ location: { lat: number; lng: number; accuracy?: number; timestamp?: string | Date } }`
    - Expo: `{ location: { latitude: number; longitude: number; accuracy?: number | null; altitude?: number | null; altitudeAccuracy?: number | null; heading?: number | null; speed?: number | null; timestamp?: string | Date } }`
  - Behavior:
    - Normalize and map Expo fields to internal shape:
      - `latitude -> lat`, `longitude -> lng`
      - Preserve optional extras (accuracy, altitude, altitudeAccuracy, heading, speed) in memory for future SDK expansion.
    - Assign `timestamp` if missing.
    - Update `lastLocation` and broadcast to subscribed Apps (`location_update`).
  - Response:
    - `{ success: true, timestamp: <iso> }`

- POST `/poll-response/:correlationId` (location poll response) // Full path: /api/client/location/poll-response/:correlationId
  - Auth: Bearer JWT; requires an active `UserSession`.
  - Body (supports simple and Expo location payloads, same mapping as above)
  - Behavior:
    - Normalize input and map Expo fields.
    - If `:correlationId` matches a pending poll, send a targeted response to that App and clear the pending entry.
    - If no pending poll exists (stale/late), the manager may ignore or treat as a normal update (implementation choice; default: ignore).
  - Response:
    - `{ success: true, resolved: boolean, timestamp: <iso> }`

Notes:

- No DB writes during the request. All updates are in-memory only.
- If the device WebSocket is unavailable, the REST API path is the authoritative source of truth for in-session location.
- Expo LocationObjectCoords reference: https://docs.expo.dev/versions/latest/sdk/location/#locationobjectcoords

---

## 7) Wiring and Refactor Plan

1. Create `services/session/LocationManager.ts`

- Implement state, methods, and tier freshness logic.
- Use `userSession.relayMessageToApps` for broadcast; direct App WS for targeted replies.
- Implement device command helpers (`SET_LOCATION_TIER`, `REQUEST_SINGLE_LOCATION`) if device WebSocket is connected.
- Add DB cold cache seeding in constructor: read `User.location` once and populate `lastLocation`.
- Add DB cold cache persistence in `dispose()`: write `lastLocation` to `User.location` once.

2. Attach to `UserSession`

- `userSession.locationManager = new LocationManager(this)`

3. Update WebSocket handling:

- In `websocket-glasses.service.ts`, route `LOCATION_UPDATE` to `locationManager.updateFromWebsocket(update)`.

4. App subscription replay:

- In `websocket-app.service.ts`, when an App newly subscribes to `LOCATION_UPDATE`, if `userSession.locationManager.getLastLocation()` exists, send a `DATA_STREAM` with that value immediately.

5. Add REST route:

- `/api/client/user/location`
- Auth via `clientAuthWithUserSession`.
- Call `userSession.locationManager.updateFromAPI(location)`.

6. Subscription changes:

- On subscription updates (where location stream rates change), call `locationManager.onSubscriptionChange(...)`.
- Compute an in-memory effective tier. If device WebSocket is present, send `SET_LOCATION_TIER` to the device.

7. Update DB interaction pattern (cold cache only):

- **Read once**: On LocationManager construction, seed `lastLocation` from `User.location` if it exists.
- **Write once**: On session dispose, persist `lastLocation` to `User.location` for next session's cold start.
- **Deprecate fields**: Remove `User.locationSubscriptions` and `User.effectiveLocationTier` entirely (no longer needed).
- **No live writes**: During active session, all location updates are in-memory only.

---

## 8) Backward Compatibility

- SDK: unchanged; Apps continue to subscribe to `location_update` and poll via `getLatestLocation`.
- Legacy WebSocket devices:
  - `LOCATION_UPDATE` WebSocket messages still work; LocationManager handles them via `updateFromWebsocket()`.
  - Device commands `SET_LOCATION_TIER` and `REQUEST_SINGLE_LOCATION` are issued when needed (session-scoped decision).
- Cached replay:
  - Replaying last location on new subscriptions is sourced from in-memory `lastLocation`; behavior is the same for Apps.
  - Initial cold-start cache comes from DB (seeded once at session init), then all subsequent updates are in-memory.

---

## 9) Security, Validation, and Limits

- Auth:
  - REST endpoint requires Bearer JWT and an active session; use the same middleware as calendar.
- Validation:
  - Normalize lat/lng to numbers; coerce timestamp to ISO.
- Limits:
  - Consider rate-limiting REST updates to prevent spam or coordinate with device WS updates to reduce flapping.
- Freshness:
  - Per-tier max age policy determines whether a cached location can satisfy a poll request.

---

## 10) Observability

- Structured logs:
  - Pending poll add/remove (correlationId, packageName).
  - Broadcast vs targeted responses (counts, packageName).
  - Effective tier changes and device commands.
- Metrics (future):
  - Poll request count and fulfillment source (cache vs device vs client REST).
  - Stream vs rest update balance.

---

## 11) Testing Plan

- Unit:
  - Poll handling with/without fresh `lastLocation`.
  - CorrelationId path resolution and pending poll cleanup.
  - Effective tier computation for mixed subscriptions.
- Integration:
  - WS (device) + REST (client) mixed updates converge to same App-facing behavior.
  - Replay last location on new subscription.
  - Device commands are sent when effective tier changes.
- Session lifecycle:
  - DB cold cache is seeded on session init (one read).
  - DB cold cache is persisted on session dispose (one write).

---

## 12) Open Questions

- Should we implement a dedicated REST endpoint for poll responses? Current design relies on including `correlationId` in normal REST updates.
- Should we add response-level permissions for targeted replies (e.g., ensure the target App is still connected and authorized)?
- Any need to include altitude/speed/bearing in the new location payload shape?

---

## 13) Summary

This design introduces a session-scoped LocationManager that mirrors the CalendarManager pattern: in-memory state with a REST-first path for mobile clients and WebSocket compatibility for legacy devices. It consolidates location streaming, polling, and tier management logic under the session while minimizing database interaction to session boundaries only (cold cache pattern). The SDK and App-facing message contracts remain unchanged, ensuring backward compatibility and a smooth transition to a cleaner, more testable architecture.

---

## 14) Manager-Owned Relay Pattern (websocket-app.service.ts Simplification)

### Philosophy: Managers Own Their Domain Logic

Previously, `websocket-app.service.ts` contained domain-specific logic for detecting new subscriptions and relaying cached data to apps. This violated separation of concerns - the WebSocket service shouldn't know about location tiers, calendar event formats, or when to relay data.

### The Problem (Before)

**websocket-app.service.ts was doing too much:**

- ❌ Detected new location subscriptions (`isNewLocationSubscription` logic)
- ❌ Detected new calendar subscriptions (`isNewCalendarSubscription` logic)
- ❌ Built DataStream messages with location/calendar data
- ❌ Directly accessed app WebSockets to send data
- ❌ Knew about domain-specific replay policies (~115 lines of domain logic)

### The Solution (After)

**Each manager owns its relay logic:**

```typescript
// websocket-app.service.ts - SIMPLIFIED
private async handleSubscriptionUpdate(message) {
  await userSession.subscriptionManager.updateSubscriptions(
    message.packageName,
    message.subscriptions
  );
  // Done! Managers handle relay internally via SubscriptionManager.syncManagers()
}
```

```typescript
// SubscriptionManager.syncManagers() - COORDINATOR
private async syncManagers(): Promise<void> {
  // Location: pass subscription data for tier computation + relay
  const locationSubs = this.getLocationSubscriptions();
  this.userSession.locationManager.handleSubscriptionUpdate(locationSubs);

  // Calendar: pass list of subscribed apps for relay
  const calendarSubs = this.getCalendarSubscriptions();
  this.userSession.calendarManager.handleSubscriptionUpdate(calendarSubs);
}
```

```typescript
// LocationManager - OWNS RELAY LOGIC
private subscribedApps: Set<string> = new Set();

public handleSubscriptionUpdate(
  subs: Array<{ packageName: string; rate: string }>
): void {
  // Detect newly subscribed apps
  const newPackages = subs.filter(s => !this.subscribedApps.has(s.packageName));

  // Relay to new subscribers
  for (const sub of newPackages) {
    this.relayToApp(sub.packageName);
    this.subscribedApps.add(sub.packageName);
  }

  // Compute tier (existing logic)
  const rates = subs.map(s => s.rate);
  const newTier = this.computeEffectiveTier(rates);
  if (this.effectiveTier !== newTier) {
    this.onSubscriptionChange(newTier);
  }
}

private relayToApp(packageName: string): void {
  if (!this.lastLocation) return;

  const appWebsocket = this.userSession.appWebsockets.get(packageName);
  if (!appWebsocket || appWebsocket.readyState !== WebSocket.OPEN) return;

  const dataStream: DataStream = {
    type: CloudToAppMessageType.DATA_STREAM,
    sessionId: `${this.userSession.userId}-${packageName}`,
    streamType: StreamType.LOCATION_UPDATE,
    data: this.toSdkLocationUpdate(this.lastLocation),
    timestamp: new Date(),
  };

  appWebsocket.send(JSON.stringify(dataStream));
}
```

```typescript
// CalendarManager - SAME PATTERN
private subscribedApps: Set<string> = new Set();

public handleSubscriptionUpdate(packageNames: string[]): void {
  const newPackages = packageNames.filter(p => !this.subscribedApps.has(p));

  for (const packageName of newPackages) {
    this.relayToApp(packageName);
    this.subscribedApps.add(packageName);
  }
}

private relayToApp(packageName: string): void {
  const cachedEvents = this.getCachedEvents();
  if (cachedEvents.length === 0) return;

  const appWebsocket = this.userSession.appWebsockets.get(packageName);
  if (!appWebsocket || appWebsocket.readyState !== WebSocket.OPEN) return;

  // Send each event as a DataStream message
  for (const event of cachedEvents) {
    const dataStream: DataStream = {
      type: CloudToAppMessageType.DATA_STREAM,
      streamType: StreamType.CALENDAR_EVENT,
      sessionId: `${this.userSession.userId}-${packageName}`,
      data: event,
      timestamp: new Date(),
    };
    appWebsocket.send(JSON.stringify(dataStream));
  }
}
```

### Unsubscribe Handling

```typescript
// SubscriptionManager.removeSubscriptions()
async removeSubscriptions(packageName: string): Promise<void> {
  // ... existing logic

  // Notify managers about unsubscribe
  this.userSession.locationManager.handleUnsubscribe(packageName);
  this.userSession.calendarManager.handleUnsubscribe(packageName);
}
```

```typescript
// LocationManager & CalendarManager
public handleUnsubscribe(packageName: string): void {
  this.subscribedApps.delete(packageName);
}
```

### Benefits

| Aspect                         | Before                 | After                             |
| ------------------------------ | ---------------------- | --------------------------------- |
| websocket-app.service.ts LOC   | ~1200 lines            | ~1085 lines (-115)                |
| Domain knowledge in WS service | Location + Calendar ❌ | None ✅                           |
| LocationManager self-contained | No ❌                  | Yes ✅                            |
| CalendarManager self-contained | No ❌                  | Yes ✅                            |
| Easy to add new managers       | No (modify WS service) | Yes (just notify in syncManagers) |
| Relay policy location          | Scattered ❌           | With the data ✅                  |

### What Was Removed from websocket-app.service.ts

- ❌ `isNewLocationSubscription` detection logic (40 lines)
- ❌ Location relay logic (25 lines)
- ❌ `isNewCalendarSubscription` detection logic (20 lines)
- ❌ Calendar relay logic (30 lines)
- ❌ DataStream message building for location/calendar
- ❌ Direct WebSocket access for relay

**Total removal: ~115 lines of domain-specific code!**

### Architecture Flow

```
App Subscription Update
  ↓
websocket-app.service.ts (domain-agnostic router)
  ↓
SubscriptionManager.updateSubscriptions()
  ↓
SubscriptionManager.syncManagers()
  ↓
├─ LocationManager.handleSubscriptionUpdate()
│    ├─ Detect new subscriptions
│    ├─ relayToApp() for each new subscriber
│    └─ Compute tier
│
└─ CalendarManager.handleSubscriptionUpdate()
     ├─ Detect new subscriptions
     └─ relayToApp() for each new subscriber
```

---

## 15) Database Cold Cache Architecture

### Philosophy: DB as "Between-Sessions" Storage Only

During an active UserSession, `locationManager.lastLocation` is the **source of truth**. The database serves only as a "deep freeze" cache to preserve location between sessions.

### Session Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ Session Start (UserSession constructor)                     │
├─────────────────────────────────────────────────────────────┤
│ 1. Create LocationManager                                   │
│ 2. Async: Read User.location from DB (one-time read)       │
│ 3. Seed locationManager.lastLocation with cached value     │
│ 4. LocationManager now owns state (memory is source of truth)│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Active Session (all updates in-memory only)                 │
├─────────────────────────────────────────────────────────────┤
│ • locationManager.updateFromAPI() → memory only             │
│ • locationManager.updateFromWebsocket() → memory only       │
│ • Apps subscribe → replay from lastLocation (memory)        │
│ • Zero DB writes during this phase                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Session End (UserSession.dispose)                           │
├─────────────────────────────────────────────────────────────┤
│ 1. Persist locationManager.lastLocation → User.location    │
│    (one-time write to "deep freeze" cache)                  │
│ 2. locationManager.dispose() clears in-memory state         │
│ 3. Next session will read this cached value on cold start   │
└─────────────────────────────────────────────────────────────┘
```

### Benefits

- ✅ **Zero DB writes during active session** (performance win)
- ✅ **Apps get instant replay** from in-memory cache when subscribing mid-session
- ✅ **Cold start support** for new sessions (apps subscribing immediately get last known location)
- ✅ **Database is purely "between-sessions" storage** (not a live data store)

### Implementation Notes

**LocationManager Constructor:**

```typescript
constructor(userSession: UserSession) {
  this.userSession = userSession;
  this.logger = userSession.logger.child({ service: "LocationManager" });

  // Seed from DB cold cache (async, non-blocking)
  this.seedFromDatabaseCache().catch(err =>
    this.logger.warn(err, "Could not seed location from DB cold cache")
  );

  this.logger.info({ userId: userSession.userId }, "LocationManager initialized");
}

private async seedFromDatabaseCache(): Promise<void> {
  try {
    const user = await User.findOne({ email: this.userSession.userId });
    if (user?.location?.lat && user?.location?.lng) {
      this.lastLocation = {
        lat: user.location.lat,
        lng: user.location.lng,
        accuracy: user.location.accuracy ?? null,
        timestamp: user.location.timestamp instanceof Date
          ? user.location.timestamp
          : new Date(),
      };
      this.logger.info("Seeded lastLocation from DB cold cache");
    }
  } catch (error) {
    this.logger.warn(error, "Failed to seed location from DB cold cache");
  }
}
```

**LocationManager.dispose():**

```typescript
async dispose(): Promise<void> {
  // Persist to DB cold cache for next session
  if (this.lastLocation) {
    try {
      const user = await User.findOne({ email: this.userSession.userId });
      if (user) {
        user.location = {
          lat: this.lastLocation.lat,
          lng: this.lastLocation.lng,
          accuracy: this.lastLocation.accuracy ?? undefined,
          timestamp: this.lastLocation.timestamp,
        };
        await user.save();
        this.logger.info("Persisted lastLocation to DB cold cache");
      }
    } catch (error) {
      this.logger.warn(error, "Failed to persist location to DB cold cache");
    }
  }

  // Clear in-memory state
  this.pendingPolls.clear();
  this.lastLocation = undefined;
  this.effectiveTier = undefined;

  this.logger.info({ userId: this.userSession.userId }, "LocationManager disposed");
}
```

**UserSession.dispose():**

```typescript
async dispose() {
  // Persist location manager state to cold cache
  await this.locationManager.dispose();

  // ... other manager cleanup
  this.calendarManager.dispose();
  // etc.
}
```

### Deprecated User Model Fields

After this refactor, the following fields are **no longer used** and should be removed:

- ❌ `User.locationSubscriptions` - subscriptions are tracked in-memory by SubscriptionManager
- ❌ `User.effectiveLocationTier` - tier is computed in-memory only

Fields that remain (cold cache only):

- ✅ `User.location` - read once on session init, written once on session dispose

### Migration Strategy

1. **Phase 1**: Wire up LocationManager with cold cache pattern (this refactor)
2. **Phase 2**: Remove DB writes from old location.service.ts code paths
3. **Phase 3**: Delete deprecated fields (`locationSubscriptions`, `effectiveLocationTier`) from User schema
4. **Phase 4**: Remove location.service.ts entirely once all references are migrated
