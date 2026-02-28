# 005: Dead Code Cleanup (Core → Mantle Migration)

Remove dead WebSocket handlers and legacy settings code that's no longer used after the mobile client migrated from native "core" to React Native "mantle".

## Problem

When mobile moved from native Kotlin/Swift (core) to React Native TypeScript (mantle), several WebSocket message types stopped being sent. The cloud still has handlers for these messages that will never be called.

### Dead Message Types

| Message Type                       | Lines | Evidence                                |
| ---------------------------------- | ----- | --------------------------------------- |
| `CORE_STATUS_UPDATE`               | ~100  | Mobile `SocketComms.ts` doesn't send it |
| `REQUEST_SETTINGS`                 | ~30   | Mobile loads settings via REST now      |
| `MENTRAOS_SETTINGS_UPDATE_REQUEST` | ~35   | Mobile saves settings via REST now      |

### How We Know It's Dead

1. **Searched mobile codebase** - No references to these message types in `mobile/src/`
2. **Checked `SocketComms.ts`** - Lists all messages mobile sends, these aren't there
3. **Found REST replacement** - Mobile uses `GET/POST /api/client/user/settings` now
4. **SDK has TODOs** - Comments in `message-types.ts` say "Remove after moving to REST"

### Mobile's Actual Message Flow (mantle)

```
Mobile Settings:
  init → REST GET /api/client/user/settings → UserSettings model
  change → REST POST /api/client/user/settings → UserSettings model

Mobile WebSocket (what it actually sends):
  glasses_connection_state, VAD, head_position, touch_event,
  button_press, photo_response, audio_play_response,
  rtmp_stream_status, keep_alive_ack, rgb_led_control_response,
  local_transcription, location_update
```

### Legacy Path (now dead)

```
Old (core):
  Native settings change → CORE_STATUS_UPDATE WS → user.augmentosSettings

New (mantle):
  Settings change → REST API → UserSettings model → UserSettingsManager bridges to apps
```

## Files to Clean

### 1. `handlers/glasses-message-handler.ts`

**Remove:**

- `handleCoreStatusUpdate()` - ~100 lines of dead code
- `handleRequestSettings()` - ~30 lines
- `handleMentraOSSettingsUpdateRequest()` - ~35 lines
- `DEFAULT_AUGMENTOS_SETTINGS` constant
- Related imports (`CoreStatusUpdate`, `RequestSettings`, `MentraosSettingsUpdateRequest`)

**Update switch statement:**

```typescript
// REMOVE these cases:
case GlassesToCloudMessageType.REQUEST_SETTINGS:
case GlassesToCloudMessageType.MENTRAOS_SETTINGS_UPDATE_REQUEST:
case GlassesToCloudMessageType.CORE_STATUS_UPDATE:
```

### 2. `AppManager.ts`

**Remove:**

- `DEFAULT_AUGMENTOS_SETTINGS` constant (~15 lines)

**Keep (for now):**

- `user.augmentosSettings` in `handleAppInit` - Apps still receive this in connection ACK

### 3. SDK Types (optional, separate PR)

**Mark deprecated or remove:**

- `GlassesToCloudMessageType.CORE_STATUS_UPDATE`
- `GlassesToCloudMessageType.REQUEST_SETTINGS`
- `GlassesToCloudMessageType.MENTRAOS_SETTINGS_UPDATE_REQUEST`
- Related interfaces in `glasses-to-cloud.ts`

## What to Keep

### Still Used

| Code                                        | Reason                                         |
| ------------------------------------------- | ---------------------------------------------- |
| `user.augmentosSettings` in `handleAppInit` | Apps receive this on connection ACK            |
| `UserSettingsManager`                       | Bridges REST settings to legacy app broadcasts |
| `augmentos_settings_update` broadcasts      | Apps may subscribe to settings changes         |

### Backward Compatibility

The REST→WebSocket bridge in `UserSettingsManager.onSettingsUpdatedViaRest()` still broadcasts `augmentos_settings_update` to apps. This is correct - it just doesn't come from the old WS path anymore.

## Implementation

### Step 1: Remove Dead Handlers

Remove from `glasses-message-handler.ts`:

1. Delete `handleCoreStatusUpdate` function
2. Delete `handleRequestSettings` function
3. Delete `handleMentraOSSettingsUpdateRequest` function
4. Delete `DEFAULT_AUGMENTOS_SETTINGS` constant
5. Remove switch cases
6. Clean up imports

### Step 2: Clean Up AppManager

Remove `DEFAULT_AUGMENTOS_SETTINGS` from `AppManager.ts`

### Step 3: Update Tests (if any)

Check `cloud-client` package - it still sends `CORE_STATUS_UPDATE` for testing. Either:

- Remove those test helpers
- Or keep them but document they're for testing backwards compatibility

## Line Count Impact

| File                                  | Before | After | Change   |
| ------------------------------------- | ------ | ----- | -------- |
| `handlers/glasses-message-handler.ts` | 543    | 317   | **-226** |
| `AppManager.ts`                       | 1613   | 1610  | -3       |

**Total: ~229 lines removed**

## Implementation Summary (Completed)

**Removed:**

- `handleCoreStatusUpdate()` - ~100 lines of dead code
- `handleRequestSettings()` - ~30 lines
- `handleMentraOSSettingsUpdateRequest()` - ~35 lines
- `DEFAULT_AUGMENTOS_SETTINGS` constant from both files
- `getChangedKeys()` utility function
- Unused imports: `CoreStatusUpdate`, `RequestSettings`, `MentraosSettingsUpdateRequest`, `CloudToGlassesMessageType`, `User`

**Kept (for backward compatibility):**

- Inline fallback defaults in `handleAppInit()` for `user.augmentosSettings`
- Comment explaining these message types were removed and why

## Success Criteria

- [x] Dead handlers removed
- [x] No TypeScript errors
- [x] Lint passes (only pre-existing warnings)
- [ ] Settings still work via REST (manual test)
- [ ] Apps still receive `augmentos_settings_update` on REST changes

## Risk

**Low** - This is dead code removal. The message types are literally never sent by the mobile client anymore.

## Related

- **UserSettings model** - `models/user-settings.model.ts` is the new source of truth
- **REST API** - `/api/client/user/settings` endpoints
- **UserSettingsManager** - Bridges REST to legacy app broadcasts
