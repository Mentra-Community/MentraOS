# Settings System Cleanup

Fix broken settings flow between mobile client, cloud, and apps after migration from legacy WebSocket-based settings to REST-based UserSettings model.

## Documents

- **settings-cleanup-spec.md** - Problem analysis, broken code paths, goals
- **settings-cleanup-architecture.md** - Current vs proposed system, implementation plan

## Quick Context

**Current**: Mobile saves settings via REST to `UserSettings` model, but apps receive stale data from deprecated `user.augmentosSettings` field. Key mismatch prevents live updates from reaching apps.

**Proposed**: Fix key mismatch, load CONNECTION_ACK settings from new model, remove dead code.

## Key Context

The mobile client migrated from native "core" (WebSocket-based settings) to React Native "mantle" (REST-based settings). The cloud was partially updated but has broken code paths:

1. Mobile sends `metric_system` but bridge looks for `metric_system_enabled` - **updates never broadcast**
2. Cloud sends `augmentosSettings` but SDK expects `mentraosSettings` - **field name mismatch, apps get nothing**
3. CONNECTION_ACK reads from deprecated `user.augmentosSettings` - **apps get stale/default values**
4. ~95 lines of dead code in User model that's never written to

## Status

- [x] Investigation complete
- [x] Key mismatch identified (`metric_system` vs `metric_system_enabled`)
- [x] Field name mismatch identified (`augmentosSettings` vs `mentraosSettings`)
- [x] Broken CONNECTION_ACK flow identified
- [x] Spec written
- [x] Architecture doc written
- [x] Phase 1: Fix key mismatch in UserSettingsManager
- [x] Phase 2: Fix CONNECTION_ACK field name and data source
- [x] Phase 3: Remove dead code from User model
- [x] Phase 4: PR review fixes
  - [x] Fix indexed `preferred_mic` keys (stored as `preferred_mic:<deviceId>`)
  - [x] Fix race condition where CONNECTION_ACK could be sent before settings loaded
- [ ] Testing

## Changes Made

### Phase 1: `UserSettingsManager.ts`

- Renamed `bridgeMetricSystemEnabledIfPresent()` → `bridgeMetricSystemIfPresent()`
- Changed key check from `metric_system_enabled` to `metric_system` (matches what mobile actually sends)

### Phase 2: `AppManager.ts`

- Changed field name from `augmentosSettings` to `mentraosSettings` (matches SDK expectation)
- Now loads settings from `userSettingsManager.getSnapshot()` instead of deprecated `user.augmentosSettings`
- Maps REST keys (snake_case) to SDK keys (camelCase)

### Phase 3: `user.model.ts`

- Removed `augmentosSettings` from `UserI` interface (~15 lines)
- Removed `augmentosSettings` schema definition (~34 lines)
- Removed `updateAugmentosSettings()` method (~25 lines)
- Removed `getAugmentosSettings()` method (~5 lines)
- Total: ~95 lines of dead code removed

### Phase 4: PR Review Fixes

**Fix 1: Indexed `preferred_mic` keys**

Mobile stores `preferred_mic` with a device-specific indexer (e.g., `preferred_mic:G1` or `preferred_mic:Frame`). The plain `preferred_mic` key doesn't exist, so apps were always getting the default `"auto"`.

- Added `getIndexedSetting(key, indexer?)` method to `UserSettingsManager`
- Updated `AppManager` to use `getIndexedSetting("preferred_mic")` instead of `snapshot.preferred_mic`

**Fix 2: Race condition on settings load**

`UserSettingsManager.load()` was async but not awaited, so CONNECTION_ACK could be sent before settings were loaded from the database.

- Added `loadPromise` and `waitForLoad()` method to `UserSettingsManager`
- Added `isLoaded()` method for checking load status
- Updated `UserSession.createOrReconnect()` to await `waitForLoad()` before returning
