# Settings System Cleanup Spec

## Overview

Fix broken settings flow between mobile client, cloud, and SDK apps. The migration from legacy WebSocket-based settings (`user.augmentosSettings`) to REST-based settings (`UserSettings` model) was incomplete, leaving apps with stale/default values and broken live updates.

## Problem

### 1. Key Mismatch - Live Updates Never Broadcast

Mobile client saves settings with key `metric_system`:

```typescript
// mobile/src/stores/settings.ts:224-230
metric_system: {
  key: "metric_system",
  defaultValue: () => false,
  writable: true,
  saveOnServer: true,
  persist: true,
},
```

But `UserSettingsManager` bridge looks for `metric_system_enabled`:

```typescript
// cloud/packages/cloud/src/services/session/UserSettingsManager.ts:152-153
if (!Object.prototype.hasOwnProperty.call(updated, "metric_system_enabled")) return
```

**Result**: When user toggles metric system, the bridge code never fires. Apps subscribed to `metricSystemEnabled` never receive updates.

### 2. CONNECTION_ACK Uses Deprecated Data

When apps connect, `AppManager.handleAppInit()` sends settings from the deprecated `user.augmentosSettings` field:

```typescript
// cloud/packages/cloud/src/services/session/AppManager.ts:1215-1237
// NOTE: user.augmentosSettings is legacy - new settings go through UserSettings model
// This fallback is kept for backward compatibility...
const userAugmentosSettings = user.augmentosSettings || {
  useOnboardMic: false,
  contextualDashboard: true,
  // ... hardcoded defaults
  metricSystemEnabled: false,
}

const ackMessage = {
  type: CloudToAppMessageType.CONNECTION_ACK,
  // ...
  augmentosSettings: userAugmentosSettings, // <-- Always stale/default!
}
```

**Problem**: Mobile never writes to `user.augmentosSettings` anymore. It writes to `UserSettings` model via REST. Apps always receive default values on connection.

### 3. CONNECTION_ACK Field Name Mismatch

The cloud sends `augmentosSettings` but the SDK expects `mentraosSettings`:

**Cloud sends** (`AppManager.ts`):

```typescript
const ackMessage = {
  augmentosSettings: userAugmentosSettings, // <-- Wrong field name!
}
```

**SDK expects** (`cloud-to-app.ts`):

```typescript
export interface AppConnectionAck extends BaseMessage {
  mentraosSettings?: Record<string, any> // <-- SDK looks for this!
}
```

**SDK reads** (`AppSession.handleMessage()`):

```typescript
if (message.mentraosSettings) {
  this.settings.updateMentraosSettings(message.mentraosSettings)
} else {
  this.logger.warn(`[AppSession] CONNECTION_ACK message missing mentraosSettings field`)
  // ^ This always fires because cloud sends augmentosSettings, not mentraosSettings!
}
```

**Result**: Apps never receive initial settings because the field name doesn't match.

### 4. Dead Code in User Model

The entire `augmentosSettings` field and related methods are dead code:

| Code                               | Lines | Status             |
| ---------------------------------- | ----- | ------------------ |
| `augmentosSettings` schema field   | ~40   | Never written to   |
| `updateAugmentosSettings()` method | ~35   | Never called       |
| `getAugmentosSettings()` method    | ~5    | Returns stale data |

### Evidence

**Dashboard never receives correct initial metric setting:**

```typescript
// apps/Dashboard/src/index.ts:235-240
const useMetric = session.settings.getMentraosSetting("metricSystemEnabled") // Get from session settings
logger.info(`[Dashboard] Metric system enabled: ${useMetric}`)
// ^ Always logs 'false' regardless of user's actual setting
```

**Dashboard subscribes to live updates but never receives them:**

```typescript
// apps/Dashboard/src/index.ts:264-272
session.settings.onMentraosSettingChange("metricSystemEnabled", (newValue, oldValue) => {
  logger.info(`AugmentOS metricSystemEnabled changed from ${oldValue} to ${newValue}`)
  // ^ This never fires because of key mismatch
})
```

## Constraints

1. **Backward compatibility**: SDK apps expect `metricSystemEnabled` (camelCase) - cannot change SDK API
2. **No mobile changes**: Mobile uses `metric_system` consistently - fix should be cloud-side
3. **Existing UserSettings model**: Already working for persistence, just not wired to apps correctly
4. **Multiple key formats**: Mobile uses `snake_case`, SDK uses `camelCase`

## Goals

1. **Fix live updates**: When mobile changes `metric_system`, apps receive `metricSystemEnabled` update
2. **Fix field name**: CONNECTION_ACK sends `mentraosSettings` (not `augmentosSettings`) to match SDK
3. **Fix initial values**: CONNECTION_ACK loads settings from `UserSettings` model (not deprecated `user.augmentosSettings`)
4. **Remove dead code**: Clean up deprecated `augmentosSettings` from User model
5. **Document key mapping**: Clear mapping between REST keys and SDK keys

## Non-Goals

- Changing mobile client key names (would break existing persisted settings)
- Changing SDK API (would break apps)
- Adding new settings in this PR (separate scope)
- Migrating historical data from `user.augmentosSettings` (already stale)

## Key Mapping

| Mobile REST Key        | SDK/App Key                | Notes             |
| ---------------------- | -------------------------- | ----------------- |
| `metric_system`        | `metricSystemEnabled`      | Temperature units |
| `default_wearable`     | (handled by DeviceManager) | Glasses model     |
| `contextual_dashboard` | `contextualDashboard`      | Future            |
| `brightness`           | `brightness`               | Future            |
| `head_up_angle`        | `headUpAngle`              | Future            |

## Open Questions

1. **Should we bridge all settings or just metric_system?**
   - Current: Only `metric_system` bridged
   - Alternative: Bridge all settings listed above
   - **Recommendation**: Start with `metric_system`, add others as needed

2. **Should we keep augmentosSettings schema for migration period?**
   - Option A: Remove entirely (clean break)
   - Option B: Keep read-only for 1 release (safety)
   - **Recommendation**: Option A - data is already stale, no value in keeping

3. **What about apps that directly read CONNECTION_ACK augmentosSettings?**
   - Need to ensure CONNECTION_ACK still sends the field with correct data
   - Map from UserSettings → augmentosSettings format for backward compat

## Success Criteria

- [ ] Dashboard displays correct temperature unit on connection
- [ ] Dashboard updates temperature unit in real-time when user toggles setting
- [ ] Logs show `metric_system` → `metricSystemEnabled` bridge firing
- [ ] No TypeScript errors after removing dead code
- [ ] No regressions in other settings (app settings, capabilities, etc.)
