# Timezone & Datetime Cleanup Architecture

## Current System

### Data Flow (Broken)

```
Mobile                         Cloud                              Dashboard App
------                         -----                              -------------
POST /set-datetime ──────────► userSession.userDatetime = "..."
{ datetime: ISO string }                │
                                        ▼
                               custom_message relay ──────────────► on("custom_message")
                               { action: "update_datetime" }        if action === "update_datetime"
                                                                    sessionInfo.userDatetime = ...
                                                                            │
                                                                            ▼
                                                                    extractTimezoneFromISO("+08:00")
                                                                            │
                                                                            ▼
                                                                    toLocaleString({ timeZone: "+08:00" })
                                                                    ❌ FAILS - not a valid IANA timezone
```

### Key Code Paths

**1. Mobile sends datetime (constant polling)**

```typescript
// cloud/src/api/hono/routes/user-data.routes.ts:35-91
POST /api/user-data/set-datetime
{ coreToken: string, datetime: "2025-08-01T15:05:00+08:00" }

// Stores on session
userSession.userDatetime = datetime;

// Relays to apps subscribed to CUSTOM_MESSAGE
const customMessage = {
  type: CloudToAppMessageType.CUSTOM_MESSAGE,
  action: "update_datetime",
  payload: { datetime, section: "topLeft" },
};
```

**2. Dashboard receives and stores**

```typescript
// apps/Dashboard/src/index.ts:179-192
session.events.on("custom_message", (message: any) => {
  if (message.action === "update_datetime") {
    sessionInfo.userDatetime = message.payload.datetime;
  }
});
```

**3. Dashboard tries to extract timezone (broken)**

```typescript
// apps/Dashboard/src/index.ts:31-45
function extractTimezoneFromISO(isoString: string): string | null {
  const timezoneMatch = isoString.match(/([+-]\d{2}:?\d{0,2}|Z)$/);
  // Returns "+08:00" - NOT a valid IANA timezone name!
}

// apps/Dashboard/src/index.ts:673-677
const userTimezone = sessionInfo.userDatetime
  ? extractTimezoneFromISO(sessionInfo.userDatetime) // Returns "+08:00"
  : null;

// apps/Dashboard/src/index.ts:684-688
const localized = new Date(event.dtStart).toLocaleString("en-US", {
  timeZone: timezone, // "+08:00" doesn't work here!
});
```

### Problems

1. **Offset ≠ Timezone**: `"+08:00"` is not accepted by `toLocaleString()`. Need IANA names like `"Asia/Singapore"`.

2. **Stale data**: `userDatetime` is outdated the moment it's received.

3. **Wasteful**: Constant network traffic for something that changes ~never (user's timezone).

4. **Wrong abstraction**: `custom_message` was invented just for this. No other usage.

5. **SDK pollution**: Added types/streams/handlers that only serve this one bad use case.

## Proposed System

### Data Flow (Fixed)

```
Mobile                         Cloud                              Dashboard App
------                         -----                              -------------
POST /user/settings ─────────► UserSettings.timezone = "America/New_York"
{ timezone: "America/New_York" }        │
(sent once on login)                    ▼
                               UserSettingsManager.onSettingsUpdatedViaRest()
                                        │
                                        ▼
                               1. Update snapshot
                               2. Set userSession.userTimezone
                               3. broadcastSettingsUpdate()
                                        │
                                        ▼
                               buildMentraosSettings() ──────────► Full snapshot sent
                               { metricSystemEnabled, brightness,   to all subscribed apps
                                 userTimezone, ... }                      │
                                                                          ▼
                                                                   settings.onMentraosChange()
                                                                          │
                                                                          ▼
                                                                   userTimezone = "America/New_York"
                                                                          │
                                                                          ▼
                                                                   toLocaleString({ timeZone: "America/New_York" })
                                                                   ✅ WORKS
```

### Key Changes

1. **Add `timezone` to UserSettings** - Stored in DB, loaded on session start
2. **Single broadcast method** - `broadcastSettingsUpdate()` sends full snapshot to all subscribed apps
3. **Single source of truth** - `buildMentraosSettings()` defines snake_case → camelCase mapping once
4. **Include in CONNECTION_ACK** - Apps get timezone on connect (uses same `buildMentraosSettings()`)
5. **Remove all datetime cruft** - userDatetime, set-datetime endpoint, custom_message relay

## Implementation Details

### Phase 1: Add timezone to cloud

**UserSession.ts** - Add property

```typescript
// cloud/src/services/session/UserSession.ts
export class UserSession {
  // ... existing properties ...

  // Remove this:
  // public userDatetime?: string;

  // Add this:
  public userTimezone?: string;
}
```

**UserSettingsManager.ts** - Load timezone and broadcast full snapshot

```typescript
// cloud/src/services/session/UserSettingsManager.ts

/**
 * Build the full mentraosSettings object for SDK apps.
 * Maps from REST keys (snake_case) to SDK keys (camelCase).
 * This is the SINGLE SOURCE OF TRUTH for settings mapping.
 */
buildMentraosSettings(): Record<string, any> {
  return {
    metricSystemEnabled: this.snapshot.metric_system ?? false,
    contextualDashboard: this.snapshot.contextual_dashboard ?? true,
    headUpAngle: this.snapshot.head_up_angle ?? 45,
    brightness: this.snapshot.brightness ?? 50,
    autoBrightness: this.snapshot.auto_brightness ?? true,
    sensingEnabled: this.snapshot.sensing_enabled ?? true,
    alwaysOnStatusBar: this.snapshot.always_on_status_bar ?? false,
    bypassVad: this.snapshot.bypass_vad_for_debugging ?? false,
    bypassAudioEncoding: this.snapshot.bypass_audio_encoding_for_debugging ?? false,
    preferredMic: this.snapshot.preferred_mic ?? "auto",
    useOnboardMic: this.snapshot.preferred_mic === "glasses",
    userTimezone: this.userSession.userTimezone || this.snapshot.timezone || null,
  };
}

async load(): Promise<void> {
  // ... existing code ...

  // Load timezone if present
  if (this.snapshot.timezone) {
    this.userSession.userTimezone = this.snapshot.timezone;
    this.logger.info({ timezone: this.snapshot.timezone }, "User timezone loaded");
  }
}

async onSettingsUpdatedViaRest(updated: Record<string, any>): Promise<void> {
  // Update snapshot...

  // Handle special settings
  if (Object.prototype.hasOwnProperty.call(updated, "timezone")) {
    const timezone = updated["timezone"];
    if (typeof timezone === "string" && timezone) {
      this.userSession.userTimezone = timezone;
    }
  }

  // Broadcast FULL snapshot to all connected apps
  await this.broadcastSettingsUpdate();
}

/**
 * Broadcast the full mentraosSettings snapshot to all connected apps.
 * Sends to any app that has subscribed to any augmentos setting.
 *
 * IMPORTANT: Always sends the FULL snapshot, not partial updates.
 * This is required because the SDK replaces the entire settings object.
 */
private async broadcastSettingsUpdate(): Promise<void> {
  const subscribedApps = this.userSession.subscriptionManager.getAllAppsWithAugmentosSubscriptions();
  if (!subscribedApps || subscribedApps.length === 0) return;

  const mentraosSettings = this.buildMentraosSettings();  // Full snapshot!
  const timestamp = new Date();

  for (const packageName of subscribedApps) {
    const ws = this.userSession.appWebsockets.get(packageName);
    if (!ws || ws.readyState !== WebSocketReadyState.OPEN) continue;

    ws.send(JSON.stringify({
      type: "augmentos_settings_update",
      sessionId: `${this.userSession.sessionId}-${packageName}`,
      settings: mentraosSettings,
      timestamp,
    }));
  }

  this.logger.info({ appCount: subscribedApps.length }, "Broadcast settings update to apps");
}
```

**SubscriptionManager.ts** - Add helper for broadcast

```typescript
// cloud/src/services/session/SubscriptionManager.ts

/**
 * Get all apps that have any AugmentOS setting subscription
 * Used for broadcasting full settings snapshots
 */
getAllAppsWithAugmentosSubscriptions(): string[] {
  const subscribed: string[] = [];

  for (const [packageName, appSession] of this.getAppSessionEntries()) {
    for (const sub of appSession.subscriptions) {
      if (typeof sub === "string" && sub.startsWith("augmentos:")) {
        subscribed.push(packageName);
        break;
      }
    }
  }
  return subscribed;
}
```

**AppManager.ts** - Use shared method for CONNECTION_ACK

```typescript
// cloud/src/services/session/AppManager.ts
// Uses the same buildMentraosSettings() for consistency
const mentraosSettings = this.userSession.userSettingsManager.buildMentraosSettings();
```

### Phase 2: Remove datetime cruft from cloud

**UserSession.ts** - Remove property

```typescript
// Remove this line:
public userDatetime?: string;
```

**user-data.routes.ts (hono)** - Remove endpoint

```typescript
// cloud/src/api/hono/routes/user-data.routes.ts
// Remove entire setDatetime function and route
// If file becomes empty, delete it
```

**user-data.routes.ts (express)** - Remove endpoint

```typescript
// cloud/src/routes/user-data.routes.ts
// Remove entire file if only set-datetime exists
```

**app-message-handler.ts** - Remove cached datetime relay

```typescript
// cloud/src/services/session/handlers/app-message-handler.ts:235-248
// Remove this block:
// const isNewCustomMessageSubscription = message.subscriptions.includes(StreamType.CUSTOM_MESSAGE as any);
// if (isNewCustomMessageSubscription && userSession.userDatetime) { ... }
```

### Phase 3: Fix Dashboard app

**Remove datetime handling**

```typescript
// apps/Dashboard/src/index.ts

// Remove function (lines 31-45):
// function extractTimezoneFromISO(isoString: string): string | null { ... }

// Remove from session info interface (line 111):
// userDatetime?: string;

// Remove custom_message handler (lines 179-192):
// session.events.on("custom_message", (message: any) => {
//   if (message.action === "update_datetime") { ... }
// });
```

**Add timezone from settings**

```typescript
// apps/Dashboard/src/index.ts

// In session info interface:
interface SessionInfo {
  // ... existing fields ...
  userTimezone?: string;  // IANA timezone name
}

// On session start:
protected async onSession(session: AppSession, sessionId: string) {
  // Get timezone from settings
  const userTimezone = session.settings.getMentraOS<string>("userTimezone");

  const sessionInfo = {
    // ... existing fields ...
    userTimezone,
  };

  // Subscribe to timezone changes
  session.settings.onMentraosChange<string>("userTimezone", (newTz) => {
    const info = this._activeSessions.get(sessionId);
    if (info) {
      info.userTimezone = newTz;
      this.updateDashboardSections(session, sessionId);
    }
  });
}
```

**Fix time formatting**

```typescript
// apps/Dashboard/src/index.ts - formatCalendarEvent()

private formatCalendarEvent(
  session: AppSession,
  event: any,
  sessionInfo: any,
  isTomorrow: boolean = false,
): string {
  // Get user's timezone (priority order)
  const userTimezone =
    sessionInfo.userTimezone ||              // From settings (preferred)
    sessionInfo.latestLocation?.timezone ||  // From GPS via tz-lookup
    undefined;                               // Let JS use system default

  // Parse event time (ISO string already encodes absolute time)
  const eventStart = new Date(event.dtStart);

  // Format in user's timezone
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  };
  if (userTimezone) {
    options.timeZone = userTimezone;
  }

  const formattedTime = eventStart
    .toLocaleTimeString("en-US", options)
    .replace(" ", "");

  const title = event.title.length > 10
    ? event.title.substring(0, 7).trim() + "..."
    : event.title;

  const timePrefix = isTomorrow ? "tmr @ " : "@ ";
  return `${title} ${timePrefix}${formattedTime}`;
}
```

**Fix formatStatusSection() similarly**

```typescript
// apps/Dashboard/src/index.ts - formatStatusSection()

private formatStatusSection(session: AppSession, sessionInfo: any): string {
  if (!sessionInfo.calendarEvent) {
    return sessionInfo.weatherCache?.data || "";
  }

  const event = sessionInfo.calendarEvent;
  const userTimezone = sessionInfo.userTimezone || sessionInfo.latestLocation?.timezone;

  // Get "now" in user's timezone
  const now = new Date();
  const eventStart = new Date(event.dtStart);
  const eventEnd = event.dtEnd ? new Date(event.dtEnd) : null;

  // Compare dates in user's timezone
  const nowInTz = userTimezone
    ? new Date(now.toLocaleString("en-US", { timeZone: userTimezone }))
    : now;
  const startInTz = userTimezone
    ? new Date(eventStart.toLocaleString("en-US", { timeZone: userTimezone }))
    : eventStart;

  // Check if today or tomorrow
  const isToday =
    nowInTz.getFullYear() === startInTz.getFullYear() &&
    nowInTz.getMonth() === startInTz.getMonth() &&
    nowInTz.getDate() === startInTz.getDate();

  const tomorrow = new Date(nowInTz);
  tomorrow.setDate(nowInTz.getDate() + 1);
  const isTomorrow =
    tomorrow.getFullYear() === startInTz.getFullYear() &&
    tomorrow.getMonth() === startInTz.getMonth() &&
    tomorrow.getDate() === startInTz.getDate();

  if (!isToday && !isTomorrow) {
    return sessionInfo.weatherCache?.data || "";
  }

  // Check if event is expired
  if (eventEnd && now > eventEnd) {
    return sessionInfo.weatherCache?.data || "";
  }
  if (now > eventStart) {
    return sessionInfo.weatherCache?.data || "";
  }

  return this.formatCalendarEvent(session, event, sessionInfo, isTomorrow);
}
```

### Phase 4: Deprecate SDK types (don't remove)

**types/message-types.ts**

```typescript
// cloud/packages/sdk/src/types/message-types.ts

export enum CloudToAppMessageType {
  // ... other types ...

  /**
   * @deprecated Use settings system instead. Will be removed in future version.
   */
  CUSTOM_MESSAGE = "custom_message",
}
```

**types/streams.ts**

```typescript
// cloud/packages/sdk/src/types/streams.ts

export enum StreamType {
  // ... other types ...

  /**
   * @deprecated Use settings system instead. Will be removed in future version.
   */
  CUSTOM_MESSAGE = "custom_message",
}
```

**app/session/events.ts**

```typescript
// cloud/packages/sdk/src/app/session/events.ts

/**
 * @deprecated Use settings.onMentraosChange() instead. Will be removed in future version.
 */
onCustomMessage(action: string, handler: (payload: any) => void): () => void {
  // ... existing implementation ...
}
```

## Migration Strategy

### Rollout Order

1. **Deploy cloud changes first** (Phase 1)
   - Add timezone property and bridging
   - Apps start receiving timezone in CONNECTION_ACK
   - Old apps still work (ignore new field)

2. **Deploy Dashboard fix** (Phase 3)
   - Dashboard uses timezone from settings
   - Falls back to GPS-derived timezone if not set
   - Calendar times display correctly

3. **Mobile team sends timezone setting**
   - On login: `POST /api/client/user/settings { timezone: "..." }`
   - Dashboard immediately gets correct timezone

4. **Remove datetime cruft** (Phase 2)
   - After confirming Dashboard works
   - Remove endpoints, properties, relay logic

5. **Deprecate SDK types** (Phase 4)
   - Add @deprecated JSDoc
   - Log warning if apps use custom_message
   - Remove in future major version

### Backward Compatibility

- **Old mobile (no timezone setting)**: Dashboard falls back to GPS timezone
- **Old Dashboard (uses userDatetime)**: Still works until we remove it
- **Third-party apps using custom_message**: Still works, just deprecated

## Files Changed Summary

### Cloud - Remove

| File                                  | Lines | Change                                       |
| ------------------------------------- | ----- | -------------------------------------------- |
| `UserSession.ts`                      | ~3    | Remove `userDatetime` property               |
| `api/hono/routes/user-data.routes.ts` | ~60   | Remove `setDatetime` function or delete file |
| `routes/user-data.routes.ts`          | ~80   | Delete file (only had set-datetime)          |
| `handlers/app-message-handler.ts`     | ~15   | Remove cached datetime relay block           |

### Cloud - Add/Modify

| File                     | Lines | Change                                     |
| ------------------------ | ----- | ------------------------------------------ |
| `UserSession.ts`         | ~3    | Add `userTimezone` property                |
| `UserSettingsManager.ts` | ~40   | Add timezone loading and bridging          |
| `AppManager.ts`          | ~2    | Include `userTimezone` in mentraosSettings |

### Dashboard - Modify

| File                          | Lines | Change                               |
| ----------------------------- | ----- | ------------------------------------ |
| `apps/Dashboard/src/index.ts` | ~100  | Replace datetime logic with timezone |

### SDK - Modify

| File                     | Lines | Change                             |
| ------------------------ | ----- | ---------------------------------- |
| `types/message-types.ts` | ~3    | Add @deprecated to CUSTOM_MESSAGE  |
| `types/streams.ts`       | ~3    | Add @deprecated to CUSTOM_MESSAGE  |
| `app/session/events.ts`  | ~3    | Add @deprecated to onCustomMessage |

## Testing Plan

1. **No timezone set**: Dashboard falls back to GPS timezone, displays correctly
2. **Timezone set**: Dashboard uses setting, displays correctly
3. **Cross-timezone event**: SF creates event, NY user sees correct local time
4. **Timezone change**: User updates setting, Dashboard updates display
5. **Old mobile**: No timezone sent, GPS fallback works
6. **CONNECTION_ACK**: New app receives `userTimezone` in mentraosSettings

## Open Questions

1. **Delete express routes file?**
   - `routes/user-data.routes.ts` only has set-datetime ✅ confirmed
   - Mounted in 3 places:
     - `api/index.ts:117` - `app.use("/api/user-data", userDataRoutes)`
     - `hono-app.ts:323` - `app.route("/api/user-data", userDataRoutes)` (hono version)
     - `legacy-express.ts:146` - `expressApp.use("/api/user-data", userDataRoutes)`
   - **Decision**: Delete file, remove all 3 mount points

2. **DashboardTestHarness.ts**
   - Has mock `userDatetime: '2025-05-26T05:35:40.141Z'`
   - Update to use `userTimezone: 'America/New_York'` instead

3. **dashboard-manager-skeleton.ts**
   - Has timezone handling via `latestLocation?.timezone`
   - May need updates if it's still used
