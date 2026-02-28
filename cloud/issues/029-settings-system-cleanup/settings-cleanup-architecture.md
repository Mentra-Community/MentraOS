# Settings System Cleanup Architecture

## Current System

### Data Flow (Broken)

```
Mobile App                    Cloud                           SDK App (Dashboard)
-----------                   -----                           -------------------
User toggles metric ──────►  POST /api/client/user/settings
                             { metric_system: true }
                                      │
                                      ▼
                             UserSettings model (persisted ✓)
                                      │
                                      ▼
                             UserSettingsManager.onSettingsUpdatedViaRest()
                                      │
                                      ▼
                             bridgeMetricSystemEnabledIfPresent()
                             checks for "metric_system_enabled"  ◄── WRONG KEY!
                                      │
                                      ▼
                             Key not found, returns early
                             No broadcast to apps                   ✗ No update received


App connects ─────────────►  AppManager.handleAppInit()
                                      │
                                      ▼
                             user.augmentosSettings              ◄── DEPRECATED, STALE!
                             (never written to anymore)
                                      │
                                      ▼
                             CONNECTION_ACK with:
                             - augmentosSettings: {...}          ◄── WRONG FIELD NAME!
                                      │
                                      ▼
                             SDK looks for mentraosSettings
                             Field not found! ──────────────────►  mentraosSettings: undefined
                                                                   (apps get nothing)
```

### Key Code Paths

**1. Mobile saves setting (works):**

```typescript
// mobile/src/stores/settings.ts
const SETTINGS = {
  metric_system: {
    key: "metric_system",  // <-- The actual key mobile uses
    saveOnServer: true,
  },
}

// mobile/src/services/RestComms.ts:358-365
public writeUserSettings(settings: any): AsyncResult<void, Error> {
  const config: RequestConfig = {
    method: "POST",
    endpoint: "/api/client/user/settings",
    data: {settings},  // { metric_system: true }
  }
  return this.makeRequest(config)
}
```

**2. Cloud persists to UserSettings (works):**

```typescript
// cloud/packages/cloud/src/api/client/user-settings.api.ts:64-74
const updatedSettings = await UserSettingsService.updateUserSettings(
  email,
  settings, // { metric_system: true }
)

const session = UserSession.getById(email)
if (session) {
  await session.userSettingsManager.onSettingsUpdatedViaRest(settings)
}
```

**3. Bridge looks for wrong key (BROKEN):**

```typescript
// cloud/packages/cloud/src/services/session/UserSettingsManager.ts:149-153
private async bridgeMetricSystemEnabledIfPresent(
  updated: Record<string, any>,
): Promise<void> {
  // WRONG: looks for "metric_system_enabled" but mobile sends "metric_system"
  if (!Object.prototype.hasOwnProperty.call(updated, "metric_system_enabled"))
    return;
  // ... rest never executes
}
```

**4. CONNECTION_ACK reads from deprecated field (BROKEN):**

```typescript
// cloud/packages/cloud/src/services/session/AppManager.ts:1212-1237
// NOTE: user.augmentosSettings is legacy - new settings go through UserSettings model
const userAugmentosSettings = user.augmentosSettings || {
  // ... hardcoded defaults that are always used
  metricSystemEnabled: false,
}

const ackMessage = {
  type: CloudToAppMessageType.CONNECTION_ACK,
  augmentosSettings: userAugmentosSettings, // Always stale!
}
```

**5. CONNECTION_ACK field name mismatch (BROKEN):**

Cloud sends `augmentosSettings` but SDK expects `mentraosSettings`:

```typescript
// SDK: cloud/packages/sdk/src/types/messages/cloud-to-app.ts
export interface AppConnectionAck extends BaseMessage {
  mentraosSettings?: Record<string, any> // SDK looks for this field
}

// SDK: cloud/packages/sdk/src/app/session/index.ts:1286-1293
if (message.mentraosSettings) {
  this.settings.updateMentraosSettings(message.mentraosSettings)
} else {
  this.logger.warn(`[AppSession] CONNECTION_ACK message missing mentraosSettings field`)
  // ^ This always fires because cloud sends "augmentosSettings", not "mentraosSettings"!
}
```

### Dead Code

| File            | Code                        | Lines | Impact                     |
| --------------- | --------------------------- | ----- | -------------------------- |
| `user.model.ts` | `augmentosSettings` schema  | ~40   | Dead schema, never written |
| `user.model.ts` | `updateAugmentosSettings()` | ~35   | Never called               |
| `user.model.ts` | `getAugmentosSettings()`    | ~5    | Returns stale/default data |

### Summary of All Issues

1. **Key mismatch**: Mobile sends `metric_system`, bridge looks for `metric_system_enabled`
2. **Field name mismatch**: Cloud sends `augmentosSettings`, SDK expects `mentraosSettings`
3. **Stale data source**: CONNECTION_ACK reads from deprecated `user.augmentosSettings`
4. **Dead code**: ~95 lines in User model never used

## Proposed System

### Data Flow (Fixed)

```
Mobile App                    Cloud                           SDK App (Dashboard)
-----------                   -----                           -------------------
User toggles metric ──────►  POST /api/client/user/settings
                             { metric_system: true }
                                      │
                                      ▼
                             UserSettings model (persisted ✓)
                                      │
                                      ▼
                             UserSettingsManager.onSettingsUpdatedViaRest()
                                      │
                                      ▼
                             bridgeMetricSystemIfPresent()
                             checks for "metric_system"        ◄── FIXED KEY!
                                      │
                                      ▼
                             Maps to "metricSystemEnabled"
                             Broadcasts augmentos_settings_update ───►  metricSystemEnabled: true ✓


App connects ─────────────►  AppManager.handleAppInit()
                                      │
                                      ▼
                             Load from UserSettings model      ◄── FIXED SOURCE!
                             Map keys: metric_system → metricSystemEnabled
                                      │
                                      ▼
                             CONNECTION_ACK with:
                             - mentraosSettings: {...}          ◄── FIXED FIELD NAME!
                                      │
                                      ▼
                             SDK finds mentraosSettings ───────►  metricSystemEnabled: true ✓
```

## Implementation Plan

### Phase 1: Fix Key Mismatch in UserSettingsManager

**File**: `cloud/packages/cloud/src/services/session/UserSettingsManager.ts`

**Change**: Update `bridgeMetricSystemEnabledIfPresent()` to check for `metric_system` instead of `metric_system_enabled`

```typescript
// Before:
private async bridgeMetricSystemEnabledIfPresent(
  updated: Record<string, any>,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(updated, "metric_system_enabled"))
    return;
  const raw = updated["metric_system_enabled"];
  // ...
}

// After:
private async bridgeMetricSystemIfPresent(
  updated: Record<string, any>,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(updated, "metric_system"))
    return;
  const raw = updated["metric_system"];
  // ... rest unchanged (maps to metricSystemEnabled for SDK)
}
```

**Impact**: Live updates will now reach apps when mobile changes the metric setting.

### Phase 2: Fix CONNECTION_ACK Field Name and Data Source

**File**: `cloud/packages/cloud/src/services/session/AppManager.ts`

**Changes**:

1. Rename field from `augmentosSettings` to `mentraosSettings` to match SDK
2. Load settings from `UserSettings` model instead of deprecated `user.augmentosSettings`

```typescript
// Before:
const userAugmentosSettings =
  user.augmentosSettings ||
  {
    // ... hardcoded defaults
  }

const ackMessage = {
  augmentosSettings: userAugmentosSettings, // Wrong name + stale data
}

// After:
// Load from UserSettings model and map keys for SDK compatibility
const userSettingsDoc = await UserSettings.findOne({email: this.userSession.userId})
const rawSettings = userSettingsDoc?.getSettings() || {}

const mentraosSettings = {
  // Map REST keys (snake_case) to SDK keys (camelCase)
  metricSystemEnabled: rawSettings.metric_system ?? false,
  contextualDashboard: rawSettings.contextual_dashboard ?? true,
  brightness: rawSettings.brightness ?? 50,
  headUpAngle: rawSettings.head_up_angle ?? 20,
  // Keep defaults for settings not in UserSettings
  useOnboardMic: false,
  autoBrightness: false,
  sensingEnabled: true,
  alwaysOnStatusBar: false,
  bypassVad: false,
  bypassAudioEncoding: false,
}

const ackMessage = {
  type: CloudToAppMessageType.CONNECTION_ACK,
  sessionId: sessionId,
  settings: userSettings,
  mentraosSettings: mentraosSettings, // Fixed name + real data!
  capabilities: this.userSession.getCapabilities(),
  timestamp: new Date(),
}
```

**Alternative**: Use `userSettingsManager.getSnapshot()` if session already has it loaded:

```typescript
const snapshot = this.userSession.userSettingsManager.getSnapshot()
const mentraosSettings = {
  metricSystemEnabled: snapshot.metric_system ?? false,
  // ...
}
```

**Impact**: Apps will receive correct initial values on connection.

### Phase 3: Remove Dead Code from User Model

**File**: `cloud/packages/cloud/src/models/user.model.ts`

**Changes**:

1. Remove `augmentosSettings` from `UserI` interface (~15 lines)
2. Remove `augmentosSettings` from schema (~40 lines)
3. Remove `updateAugmentosSettings()` method (~35 lines)
4. Remove `getAugmentosSettings()` method (~5 lines)

**Note**: MongoDB documents may still have the field, but Mongoose will ignore it. No migration needed.

### Phase 4: Update SDK Types (Optional)

**File**: `cloud/packages/sdk/src/types/messages/cloud-to-app.ts`

**Change**: Rename `augmentosSettings` to `mentraosSettings` in `AppConnectionAck` interface (already done, just needs verification)

```typescript
export interface AppConnectionAck extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ACK
  settings?: AppSettings
  mentraosSettings?: Record<string, any> // Already renamed in SDK
  // ...
}
```

## Key Mapping Reference

Central location for REST → SDK key mapping:

```typescript
// Could add to cloud/packages/cloud/src/services/session/UserSettingsManager.ts

const SETTINGS_KEY_MAP: Record<string, string> = {
  // REST key (mobile) → SDK key (apps)
  metric_system: "metricSystemEnabled",
  contextual_dashboard: "contextualDashboard",
  head_up_angle: "headUpAngle",
  brightness: "brightness", // same
  auto_brightness: "autoBrightness",
  sensing_enabled: "sensingEnabled",
  always_on_status_bar: "alwaysOnStatusBar",
  bypass_vad: "bypassVad",
  bypass_audio_encoding: "bypassAudioEncoding",
}

function mapToSdkKeys(restSettings: Record<string, any>): Record<string, any> {
  const sdkSettings: Record<string, any> = {}
  for (const [restKey, value] of Object.entries(restSettings)) {
    const sdkKey = SETTINGS_KEY_MAP[restKey] || restKey
    sdkSettings[sdkKey] = value
  }
  return sdkSettings
}
```

## Testing Plan

### Manual Testing

1. **Initial value test**:
   - Set `metric_system: true` via REST API
   - Start Dashboard app
   - Verify logs show `metricSystemEnabled: true` in CONNECTION_ACK
   - Verify weather displays in Celsius

2. **Live update test**:
   - Dashboard running
   - Toggle metric system in mobile app
   - Verify Dashboard logs show settings update received
   - Verify weather unit changes without restart

3. **Backward compatibility test**:
   - Verify other apps still receive CONNECTION_ACK correctly
   - Verify app-specific settings still work
   - Verify capabilities still work

### Automated Testing

```typescript
// Test cases to add
describe("UserSettingsManager", () => {
  it("bridges metric_system to metricSystemEnabled", async () => {
    const manager = new UserSettingsManager(mockSession)
    await manager.onSettingsUpdatedViaRest({metric_system: true})
    // Verify broadcast was sent with { metricSystemEnabled: true }
  })
})

describe("AppManager.handleAppInit", () => {
  it("loads mentraosSettings from UserSettings model", async () => {
    // Set up UserSettings with metric_system: true
    // Connect app
    // Verify CONNECTION_ACK contains metricSystemEnabled: true
  })
})
```

## Migration Strategy

1. **No data migration needed**: `UserSettings` is already the source of truth
2. **No client changes needed**: Mobile already uses correct REST endpoints
3. **No SDK changes needed**: SDK already handles `mentraosSettings` in CONNECTION_ACK

**Rollout**:

1. Deploy Phase 1 fix (key mismatch) - live updates start working
2. Deploy Phase 2 fix (CONNECTION_ACK) - initial values correct
3. Deploy Phase 3 (dead code removal) - cleanup

Each phase can be deployed independently and is backward compatible.

## Files Changed

| File                     | Change Type | Description                                                                               |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| `UserSettingsManager.ts` | Modify      | Fix key from `metric_system_enabled` to `metric_system`                                   |
| `AppManager.ts`          | Modify      | 1) Rename field `augmentosSettings` → `mentraosSettings`, 2) Load from UserSettings model |
| `user.model.ts`          | Remove      | Delete augmentosSettings schema and methods (~95 lines)                                   |
| Docs (various)           | Update      | Update references to deprecated augmentosSettings                                         |

## Open Questions

1. **Should UserSettingsManager bridge all keys or just metric_system?**
   - Currently only metric_system is bridged
   - Other settings (brightness, head_up_angle) could be bridged later
   - **Decision**: Start with metric_system only, add others when apps need them

2. **Should we add a helper method for key mapping?**
   - Could centralize in UserSettingsManager
   - Or keep inline for simplicity
   - **Decision**: Add `mapToSdkKeys()` helper for reuse

3. **What about UserSettingsManager.load() on session start?**
   - Currently loads snapshot from UserSettings
   - Should it also populate mentraosSettings for CONNECTION_ACK?
   - **Decision**: Yes, ensure snapshot is loaded before CONNECTION_ACK is sent
