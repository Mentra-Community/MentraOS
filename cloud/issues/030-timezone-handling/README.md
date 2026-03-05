# Timezone Handling & Datetime Cleanup

Fix calendar time display and clean up the poorly-designed `userDatetime` + `custom_message` system.

## Documents

- **timezone-spec.md** - Problem analysis, what to remove, what to add
- **timezone-architecture.md** - Implementation details, migration plan

## Quick Context

**Current**: Mobile was supposed to send `userDatetime` via REST, cloud stores it, relays via `custom_message` to apps. Dashboard extracts timezone offset from ISO string (doesn't work). Calendar times display wrong. **CRITICAL: Nothing actually calls the endpoint - entire system is dead code!**

**Proposed**: Mobile sends `timezone` setting once (IANA name like "America/New_York"). Cloud stores in UserSettings, flows through existing settings system. Remove all the datetime/custom_message cruft.

## Key Context

The root issue is simple: we need to know the user's timezone to display times correctly. Someone "solved" this by designing a system to constantly send the user's current datetime, which is:

1. Immediately stale (time keeps ticking)
2. Wasteful (constant network traffic)
3. Architecturally wrong (invented `custom_message` instead of using settings)
4. Broken (extracting "+08:00" from ISO string doesn't work with `toLocaleString`)
5. **Never implemented** - no client actually calls the endpoint!

The fix: just send the timezone name once, use the existing settings system.

## Linear Issue

[OS-285: Dashboard Calendar Time Incorrect](https://linear.app/mentralabs/issue/OS-285/dashboard-calendar-time-incorrect)

## Status

- [x] Investigation complete
- [x] Root causes identified
- [x] Cleanup scope defined
- [x] Spec written
- [x] Architecture doc written
- [x] Confirmed: **Nothing calls set-datetime** - entire system is dead code
- [x] Cloud implementation complete
  - [x] Added `userTimezone` to UserSession
  - [x] Added timezone loading in UserSettingsManager
  - [x] Added `userTimezone` to mentraosSettings in CONNECTION_ACK
  - [x] Removed `userDatetime` property
  - [x] Deleted `routes/user-data.routes.ts` (express)
  - [x] Deleted `api/hono/routes/user-data.routes.ts` (hono)
  - [x] Removed route mounting from api/index.ts, hono-app.ts, legacy-express.ts
  - [x] Removed cached datetime relay from app-message-handler.ts
  - [x] Deprecated SDK types (CUSTOM_MESSAGE, onCustomMessage)
  - [x] Deleted API documentation for set-datetime
- [x] Dashboard app update
  - [x] Replaced `userDatetime` with `userTimezone` in session info
  - [x] Read timezone from `session.settings.getMentraOS("userTimezone")`
  - [x] Subscribe to timezone changes via `onMentraosChange`
  - [x] Removed `extractTimezoneFromISO()` function
  - [x] Removed `custom_message` event handler
  - [x] Fixed `formatTimeSection()` to use IANA timezone
  - [x] Fixed `formatStatusSection()` to use IANA timezone
  - [x] Fixed `formatCalendarEvent()` to use IANA timezone
- [x] Mobile implementation
  - [x] Added `syncTimezone()` to MantleManager
  - [x] Sends device timezone on app init via `writeUserSettings({ timezone })`
- [x] PR Review fix (PR #1986)
  - [x] Fixed settings broadcast to send full snapshot instead of single key
  - [x] Refactored UserSettingsManager to use single `broadcastSettingsUpdate()` method
  - [x] Added `buildMentraosSettings()` as single source of truth for key mapping
  - [x] Added `getAllAppsWithAugmentosSubscriptions()` to SubscriptionManager
  - [x] Updated AppManager to use shared `buildMentraosSettings()` method
- [x] PR Review fix (PR #1984 - base branch)
  - [x] Added `getIndexedSetting()` for device-indexed keys like `preferred_mic:<deviceId>`
  - [x] Added `waitForLoad()` to fix race condition where CONNECTION_ACK sent before settings loaded
  - [x] Updated `buildMentraosSettings()` to use `getIndexedSetting("preferred_mic")`
  - [x] Updated `UserSession.createOrReconnect()` to await settings load
- [ ] Testing

## Changes Summary

**Remove:**

- `userSession.userDatetime` property
- `POST /api/user-data/set-datetime` endpoint (both express and hono)
- `routes/user-data.routes.ts` file entirely
- `custom_message` relay for datetime in `app-message-handler.ts`
- Dashboard's `custom_message` handler and `extractTimezoneFromISO()`
- Separate bridge methods (`bridgeMetricSystemIfPresent`, `bridgeTimezoneIfPresent`)

**Add:**

- `userSession.userTimezone` property
- `UserSettingsManager.buildMentraosSettings()` - single source of truth for settings mapping
- `UserSettingsManager.broadcastSettingsUpdate()` - sends full snapshot to subscribed apps
- `UserSettingsManager.getIndexedSetting()` - handles device-indexed keys like `preferred_mic:<deviceId>`
- `UserSettingsManager.waitForLoad()` - ensures settings are loaded before use
- `SubscriptionManager.getAllAppsWithAugmentosSubscriptions()` - helper for broadcast
- `userTimezone` in `mentraosSettings` (CONNECTION_ACK)
- Dashboard reads timezone from settings system

**Deprecate (SDK):**

- `CloudToAppMessageType.CUSTOM_MESSAGE`
- `StreamType.CUSTOM_MESSAGE`
- `onCustomMessage()` in EventManager

## PR #1986 Review Fix

The PR review flagged a critical issue: the original implementation sent only the changed setting key in `augmentos_settings_update` messages:

```typescript
// BEFORE (broken): Only sends the single changed key
settings: {
  userTimezone: timezone
}
```

The SDK's `updateMentraosSettings()` replaces the entire settings object, so apps would lose all other settings (metricSystemEnabled, brightness, etc.) when receiving a partial update.

**Fix:** Refactored to always broadcast the **full settings snapshot**:

```typescript
// AFTER (fixed): Sends complete snapshot
settings: buildMentraosSettings() // All settings included
```

### Files Changed

| File                     | Change                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `UserSettingsManager.ts` | Added `buildMentraosSettings()`, replaced bridge methods with single `broadcastSettingsUpdate()` |
| `SubscriptionManager.ts` | Added `getAllAppsWithAugmentosSubscriptions()` helper                                            |
| `AppManager.ts`          | Now uses `userSettingsManager.buildMentraosSettings()` for CONNECTION_ACK                        |

### Key Benefits

1. **Single source of truth** - `buildMentraosSettings()` defines the snake_case → camelCase mapping once
2. **No data loss** - Apps always receive complete settings, SDK replace behavior is safe
3. **Simpler code** - One broadcast method instead of per-setting bridge methods
4. **Easier to extend** - Adding new settings only requires updating `buildMentraosSettings()`

## PR #1984 Review Fixes (Base Branch)

Additional fixes from the base settings-cleanup PR review:

### Fix 1: Indexed `preferred_mic` keys

Mobile stores `preferred_mic` with a device-specific indexer (e.g., `preferred_mic:G1` or `preferred_mic:Frame`). The plain `preferred_mic` key doesn't exist, so apps were always getting the default `"auto"`.

- Added `getIndexedSetting(key, indexer?)` method to `UserSettingsManager`
- Updated `buildMentraosSettings()` to use `getIndexedSetting("preferred_mic")`

### Fix 2: Race condition on settings load

`UserSettingsManager.load()` was async but not awaited, so CONNECTION_ACK could be sent before settings were loaded from the database.

- Added `loadPromise` and `waitForLoad()` method to `UserSettingsManager`
- Added `isLoaded()` method for checking load status
- Updated `UserSession.createOrReconnect()` to await `waitForLoad()` before returning
