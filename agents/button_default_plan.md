# Button Default Action System - Master Implementation Plan

## Overview

This document outlines the complete implementation plan for the "Default Button Action" system, which allows users to configure which app starts when they press the glasses button with no foreground app active.

## Problem Statement

**Current Issues:**

1. Camera app auto-starts aggressively when glasses connect, killing other foreground apps
2. Camera app auto-stops when glasses disconnect, against user intent
3. Behavior is "magical" and unpredictable - users don't understand why apps start/stop
4. No user control over button behavior when no app is active

**Desired Behavior:**

1. Camera app state controlled by user, persists across connect/disconnect
2. Camera only auto-starts if NO foreground app is running when camera glasses connect
3. User can configure which app starts when button pressed with no foreground app active
4. Predictable, transparent behavior that respects user's current state

---

## Architecture Overview

### Button Event Flow

```
Button pressed on glasses
  ↓
Android: K900CommandHandler → BLE → Phone
iOS: Handler → Phone
  ↓
Phone receives via BLE
  ↓
Native bridge forwards to React Native
  ↓
MantleBridge.parseDataFromCore() receives event
  ↓
NEW: Emit BUTTON_PRESS to GlobalEventEmitter
  ↓
Forward to SocketComms → WebSocket → Server → Apps
  ↓
NEW: AppletStatusProvider listens for BUTTON_PRESS
  ↓
Check: Is foreground app running?
  ├─ YES: Do nothing (server forwards to app)
  └─ NO: Check default action setting
      ├─ Disabled: Do nothing
      └─ Enabled: Check compatibility → Start configured app
```

### Data Flow

```
Button Press Event:
{
  "type": "button_press",
  "buttonId": "camera",
  "pressType": "short" | "long",
  "timestamp": 1234567890
}

Settings:
- default_button_action_enabled: boolean (default: true)
- default_button_action_app: string (default: "com.mentra.camera")

Glasses Capabilities:
- has_button: boolean (from glasses model config)
- has_camera: boolean (from glasses model config)
```

---

## Implementation Phases

### Phase 1: Fix Aggressive Auto-Start/Stop ✅ Priority

**Goal:** Remove unpredictable camera app behavior

**Files to Modify:**

- `mobile/src/contexts/AppletStatusProvider.tsx`

**Changes:**

1. **Remove aggressive auto-start (lines ~465-475)**

Current behavior:

```typescript
// Auto-start camera app when glasses with camera capability connect
if (hasCamera(glassesModelName)) {
  const cameraApp = appStatus.find(app => app.packageName === "com.mentra.camera")

  if (cameraApp && !cameraApp.is_running) {
    console.log(`📸 Glasses with camera connected - auto-starting camera app`)
    optimisticallyStartApp("com.mentra.camera", "standard")
  }
}
```

New behavior:

```typescript
// Only auto-start camera if NO foreground app is running
if (hasCamera(glassesModelName)) {
  const cameraApp = appStatus.find(app => app.packageName === "com.mentra.camera")
  const activeForegroundApp = appStatus.find(app => app.type === "standard" && app.is_running)

  if (cameraApp && !cameraApp.is_running && !activeForegroundApp) {
    console.log(`📸 No foreground app running - auto-starting camera app`)
    optimisticallyStartApp("com.mentra.camera", "standard")
  } else if (activeForegroundApp) {
    console.log(`📸 Foreground app already running (${activeForegroundApp.name}) - not auto-starting camera`)
  }
}
```

2. **Remove auto-stop on disconnect (lines ~477-488)**

Current behavior:

```typescript
} else {
  // Glasses disconnected - auto-close camera app
  const cameraApp = appStatus.find(app => app.packageName === "com.mentra.camera")

  if (cameraApp && cameraApp.is_running) {
    console.log("📸 Glasses disconnected - auto-stopping camera app")
    optimisticallyStopApp("com.mentra.camera")
  }
}
```

New behavior:

```typescript
} else {
  // Glasses disconnected - DO NOT auto-stop camera app
  // User controls camera app state manually
  console.log("📸 Glasses disconnected - camera app state unchanged")
}
```

**Testing:**

- [ ] Connect camera glasses with no app running → Camera starts
- [ ] Connect camera glasses with navigation app running → Navigation keeps running
- [ ] Disconnect glasses with camera app running → Camera stays running
- [ ] Manually stop camera app → It stops
- [ ] Manually start camera app → It starts

---

### Phase 2: Add Settings Infrastructure

**Goal:** Create settings for default button action

**Files to Modify:**

- `mobile/src/stores/settings.ts`

**Changes:**

Add new settings keys:

```typescript
export const SETTINGS_KEYS = {
  // ... existing keys

  // Button action settings
  default_button_action_enabled: "default_button_action_enabled",
  default_button_action_app: "default_button_action_app",
}
```

Add default values:

```typescript
const DEFAULT_SETTINGS = {
  // ... existing defaults

  // Button action defaults
  default_button_action_enabled: true,
  default_button_action_app: "com.mentra.camera",
}
```

**Testing:**

- [ ] Settings load with correct defaults
- [ ] Settings persist across app restart
- [ ] Can read/write settings successfully

---

### Phase 3: Intercept Button Events in React Native

**Goal:** Capture button events before they go to server

**Files to Modify:**

- `mobile/src/bridge/MantleBridge.tsx`
- `mobile/src/contexts/AppletStatusProvider.tsx`

#### Step 3A: Add Button Event Emission in MantleBridge

**File:** `mobile/src/bridge/MantleBridge.tsx` (around line 361)

Add case to switch statement in `parseDataFromCore()`:

```typescript
switch (data.type) {
  case "button_press":
    // Emit for React Native handling
    console.log("📱 Button press received:", data.buttonId, data.pressType)
    GlobalEventEmitter.emit("BUTTON_PRESS", {
      buttonId: data.buttonId,
      pressType: data.pressType,
      timestamp: data.timestamp,
    })

    // Still forward to server for active apps
    socketComms.sendButtonPress(data.buttonId, data.pressType)
    break

  case "app_started":
    // ... existing cases
```

#### Step 3B: Add Button Press Handler in AppletStatusProvider

**File:** `mobile/src/contexts/AppletStatusProvider.tsx`

Add new useEffect hook (after existing effects, around line 490):

```typescript
// Handle button press events for default action
useEffect(() => {
  const handleButtonPress = async (event: {buttonId: string; pressType: string; timestamp: number}) => {
    console.log("📱 Button press event:", event.pressType, event.buttonId)

    // Only handle short press for V1
    if (event.pressType !== "short") {
      console.log("📱 Long press - forwarding to active app only")
      return
    }

    // Check if a foreground app is running
    const activeForegroundApp = appStatus.find(app => app.type === "standard" && app.is_running)

    if (activeForegroundApp) {
      // App running - server will forward button event
      console.log(`📱 Foreground app running (${activeForegroundApp.name}) - server will forward button press`)
      return
    }

    console.log("📱 No foreground app running - checking default action")

    // No foreground app - check default action setting
    const enabled = await useSettingsStore.getState().getSetting(SETTINGS_KEYS.default_button_action_enabled)

    if (!enabled) {
      console.log("📱 Default button action disabled")
      return
    }

    const appPackage = await useSettingsStore.getState().getSetting(SETTINGS_KEYS.default_button_action_app)

    if (!appPackage) {
      console.log("📱 No default app configured")
      return
    }

    const app = appStatus.find(a => a.packageName === appPackage)

    if (!app) {
      console.log(`📱 Default app ${appPackage} not found in app list`)
      return
    }

    // Check compatibility
    if (app.compatibility && !app.compatibility.isCompatible) {
      console.log(`📱 Default app ${appPackage} is incompatible with current glasses`)
      return
    }

    // Start the app!
    console.log(`📱 Starting default button app: ${app.name} (${appPackage})`)
    optimisticallyStartApp(appPackage, app.type)
  }

  GlobalEventEmitter.on("BUTTON_PRESS", handleButtonPress)

  return () => {
    GlobalEventEmitter.off("BUTTON_PRESS", handleButtonPress)
  }
}, [appStatus]) // Re-subscribe when app status changes
```

**Testing:**

- [ ] Button press with foreground app running → No action in RN, server forwards
- [ ] Button press with no app running → Default app starts
- [ ] Button press with disabled setting → No action
- [ ] Button press with incompatible default app → No action, logs warning

---

### Phase 4: Create App Picker Component

**Goal:** Reusable component for selecting apps

**New File:** `mobile/src/components/misc/AppPicker.tsx`

```typescript
import React, {useState, useMemo} from "react"
import {View, Modal, FlatList, TouchableOpacity, TextInput, ViewStyle, TextStyle} from "react-native"
import {Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {AppletInterface} from "@/types/AppletTypes"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

interface AppPickerProps {
  visible: boolean
  apps: AppletInterface[] // All available apps
  selectedAppPackage: string
  onSelect: (packageName: string) => void
  onClose: () => void
  filterType?: "standard" | "background" // Default "standard"
  title?: string
}

export const AppPicker: React.FC<AppPickerProps> = ({
  visible,
  apps,
  selectedAppPackage,
  onSelect,
  onClose,
  filterType = "standard",
  title = "Select App",
}) => {
  const {themed, theme} = useAppTheme()
  const [searchQuery, setSearchQuery] = useState("")

  // Filter apps by type and search query
  const filteredApps = useMemo(() => {
    let filtered = apps.filter(app => app.type === filterType)

    if (searchQuery) {
      filtered = filtered.filter(app =>
        app.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    }

    // Sort alphabetically
    return filtered.sort((a, b) => a.name.localeCompare(b.name))
  }, [apps, filterType, searchQuery])

  const renderAppItem = ({item}: {item: AppletInterface}) => {
    const isSelected = item.packageName === selectedAppPackage
    const isIncompatible = item.compatibility && !item.compatibility.isCompatible

    return (
      <TouchableOpacity
        style={themed($appItem)}
        onPress={() => {
          onSelect(item.packageName)
          onClose()
        }}
        disabled={isIncompatible}
        activeOpacity={0.7}>
        <View style={themed($appItemContent)}>
          <AppIcon app={item as any} style={themed($appIcon)} />
          <View style={themed($appInfo)}>
            <Text
              text={item.name}
              style={[
                themed($appName),
                isIncompatible && themed($incompatibleText),
              ]}
              numberOfLines={1}
            />
            {isIncompatible && (
              <Text
                text="Incompatible with current glasses"
                style={themed($incompatibleSubtext)}
                numberOfLines={1}
              />
            )}
          </View>
        </View>
        {isSelected && (
          <MaterialCommunityIcons
            name="check-circle"
            size={24}
            color={theme.colors.tint}
          />
        )}
      </TouchableOpacity>
    )
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={themed($container)}>
        {/* Header */}
        <View style={themed($header)}>
          <Text text={title} style={themed($headerTitle)} />
          <TouchableOpacity onPress={onClose} style={themed($closeButton)}>
            <MaterialCommunityIcons name="close" size={24} color={theme.colors.text} />
          </TouchableOpacity>
        </View>

        {/* Search Bar */}
        <View style={themed($searchContainer)}>
          <MaterialCommunityIcons name="magnify" size={20} color={theme.colors.textDim} />
          <TextInput
            style={themed($searchInput)}
            placeholder="Search apps..."
            placeholderTextColor={theme.colors.textDim}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        {/* App List */}
        <FlatList
          data={filteredApps}
          renderItem={renderAppItem}
          keyExtractor={item => item.packageName}
          contentContainerStyle={themed($listContent)}
          ListEmptyComponent={
            <View style={themed($emptyContainer)}>
              <Text text="No apps found" style={themed($emptyText)} />
            </View>
          }
        />
      </View>
    </Modal>
  )
}

// Styles
const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $header: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  paddingHorizontal: spacing.lg,
  paddingVertical: spacing.md,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
})

const $headerTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
})

const $closeButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.xs,
})

const $searchContainer: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  marginHorizontal: spacing.lg,
  marginVertical: spacing.md,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm,
  backgroundColor: colors.palette.neutral200,
  borderRadius: spacing.sm,
  gap: spacing.sm,
})

const $searchInput: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 15,
  color: colors.text,
})

const $listContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.lg,
  paddingBottom: spacing.lg,
})

const $appItem: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  paddingVertical: spacing.md,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
})

const $appItemContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  flex: 1,
  gap: spacing.md,
})

const $appIcon: ThemedStyle<ViewStyle> = () => ({
  width: 48,
  height: 48,
})

const $appInfo: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $appName: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
})

const $incompatibleText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  opacity: 0.7,
})

const $incompatibleSubtext: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.error,
  marginTop: 2,
})

const $emptyContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: spacing.xxxl,
})

const $emptyText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.textDim,
})
```

**Testing:**

- [ ] Modal opens/closes correctly
- [ ] Search filters apps by name
- [ ] Selected app shows checkmark
- [ ] Incompatible apps are grayed out and show warning
- [ ] Tapping app selects it and closes modal

---

### Phase 5: Add Settings UI in DeviceSettings

**Goal:** User interface to configure default button action

**File to Modify:** `mobile/src/app/settings/device-settings.tsx`

**Changes:**

1. Import dependencies at top:

```typescript
import {AppPicker} from "@/components/misc/AppPicker"
import {useAppStatus} from "@/contexts/AppletStatusProvider"
```

2. Add state for app picker:

```typescript
const [showAppPicker, setShowAppPicker] = useState(false)
const {appStatus} = useAppStatus()
```

3. Add settings hooks:

```typescript
const [defaultButtonActionEnabled, setDefaultButtonActionEnabled] = useSetting(
  SETTINGS_KEYS.default_button_action_enabled,
)
const [defaultButtonActionApp, setDefaultButtonActionApp] = useSetting(SETTINGS_KEYS.default_button_action_app)
```

4. Add helper to get selected app:

```typescript
const selectedApp = useMemo(() => {
  return appStatus.find(app => app.packageName === defaultButtonActionApp)
}, [appStatus, defaultButtonActionApp])
```

5. Check if glasses have button:

```typescript
const glassesHasButton = useMemo(() => {
  const modelName = status.glasses_info?.model_name
  if (!modelName) return false

  // K900/Mentra Live/Mentra Nex have buttons
  // Even Reals G1 does not
  return modelName.includes("K900") || modelName.includes("Mentra Live") || modelName.includes("Mentra Nex")
}, [status.glasses_info?.model_name])
```

6. Add section in render (after existing sections):

```tsx
{
  /* Button Settings - Only show if glasses have button */
}
{
  glassesHasButton && (
    <>
      <Text style={themed($sectionHeader)}>Button Settings</Text>
      <View style={themed($section)}>
        {/* Enable/Disable Toggle */}
        <View style={themed($settingRow)}>
          <View style={themed($settingInfo)}>
            <Text text="Default Button Action" style={themed($settingLabel)} />
            <Text text="Start an app when button pressed with no app active" style={themed($settingDescription)} />
          </View>
          <Switch value={defaultButtonActionEnabled} onValueChange={setDefaultButtonActionEnabled} />
        </View>

        <Divider />

        {/* App Selection */}
        <TouchableOpacity
          style={themed($settingRow)}
          onPress={() => setShowAppPicker(true)}
          disabled={!defaultButtonActionEnabled}
          activeOpacity={0.7}>
          <View style={themed($settingInfo)}>
            <Text text="Selected App" style={themed($settingLabel)} />
            {selectedApp ? (
              <View style={themed($selectedAppContainer)}>
                <AppIcon app={selectedApp as any} style={themed($smallAppIcon)} />
                <Text text={selectedApp.name} style={themed($selectedAppName)} />
                {selectedApp.compatibility && !selectedApp.compatibility.isCompatible && (
                  <View style={themed($warningBadge)}>
                    <MaterialCommunityIcons name="alert" size={14} color={theme.colors.error} />
                    <Text
                      text={`Not available on ${status.glasses_info?.model_name || "current glasses"}`}
                      style={themed($warningText)}
                    />
                  </View>
                )}
              </View>
            ) : (
              <Text text="No app selected" style={themed($settingDescription)} />
            )}
          </View>
          <ChevronRight color={theme.colors.textDim} />
        </TouchableOpacity>
      </View>
    </>
  )
}

{
  /* App Picker Modal */
}
;<AppPicker
  visible={showAppPicker}
  apps={appStatus}
  selectedAppPackage={defaultButtonActionApp || ""}
  onSelect={setDefaultButtonActionApp}
  onClose={() => setShowAppPicker(false)}
  filterType="standard"
  title="Select Default App"
/>
```

7. Add styles:

```typescript
const $selectedAppContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "column",
  gap: spacing.xs,
  marginTop: spacing.xs,
})

const $smallAppIcon: ThemedStyle<ViewStyle> = () => ({
  width: 32,
  height: 32,
})

const $selectedAppName: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.text,
  fontWeight: "500",
})

const $warningBadge: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.xs,
  marginTop: spacing.xxs,
})

const $warningText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.error,
})
```

**Testing:**

- [ ] Section only shows if glasses have button
- [ ] Section hidden for Even Reals G1
- [ ] Toggle enables/disables feature
- [ ] Tapping "Selected App" opens picker
- [ ] Picker is disabled when toggle is off
- [ ] Selected app shows with icon and name
- [ ] Warning shows for incompatible apps
- [ ] Settings persist across app restart

---

### Phase 6: Testing & Validation

**Integration Tests:**

1. **Basic Flow**
   - [ ] No app running, press button → Default app starts
   - [ ] Foreground app running, press button → Server forwards to app
   - [ ] Change default app, press button → New app starts
   - [ ] Disable feature, press button → Nothing happens

2. **Compatibility**
   - [ ] Select camera app, disconnect camera glasses → Press button does nothing
   - [ ] Select camera app, connect camera glasses → Press button starts camera
   - [ ] Connect Even Reals G1 → Button settings section hidden

3. **Edge Cases**
   - [ ] Default app is uninstalled → Press button does nothing, logs error
   - [ ] Default app becomes incompatible → Warning shows in UI
   - [ ] Multiple rapid button presses → Only one app starts
   - [ ] Button press during app startup → Queues properly

4. **Persistence**
   - [ ] Set default app, restart phone → Setting preserved
   - [ ] Set default app, reinstall app → Setting preserved
   - [ ] Toggle off, restart phone → Setting preserved

5. **Auto-Start Changes**
   - [ ] Connect glasses with no app → Camera auto-starts (if default)
   - [ ] Connect glasses with nav running → Nav keeps running
   - [ ] Disconnect glasses with camera running → Camera keeps running

**Performance Tests:**

- [ ] Button press latency < 100ms from glasses to app start
- [ ] No memory leaks from event listeners
- [ ] Settings load quickly (< 50ms)

---

## Future Enhancements (Post-V1)

### V2: Long Press Actions

- Add `default_button_long_press_action_app` setting
- Support different apps for short vs long press
- UI shows both short and long press options

### V3: Action Types

- Add `default_button_action_type` enum: "start_app" | "take_screenshot" | "toggle_recording"
- Support non-app actions
- UI dropdown for action type selection

### V4: Per-Glasses Profiles

- Store settings per glasses model
- Different defaults for different glasses
- Automatic switching when glasses change

### V5: Context-Aware Actions

- Time-based rules (different app at night)
- Location-based rules (gym app at gym)
- Smart suggestions based on usage patterns

---

## Migration & Rollout

### Rollout Strategy

**Phase 1 - Internal Testing:**

- Deploy to dev build only
- Test with K900 and Mentra Live glasses
- Validate no regressions in existing button functionality

**Phase 2 - Beta Release:**

- Include in TestFlight/Beta builds
- Gather user feedback on UI/UX
- Monitor for crashes or unexpected behavior

**Phase 3 - Production Release:**

- Roll out to 10% of users
- Monitor analytics for adoption rate
- Full rollout after 1 week with no issues

### Monitoring

**Metrics to Track:**

- Button press events received
- Default action triggers (success/failure)
- Setting change frequency
- Compatibility check failures
- User engagement with settings UI

**Error Tracking:**

- Failed app starts from button press
- Incompatible app selections
- Missing app errors
- Event listener memory leaks

---

## Success Criteria

### Must Have (V1)

- ✅ Camera app no longer auto-starts aggressively
- ✅ Camera app no longer auto-stops on disconnect
- ✅ Button press with no app starts default app
- ✅ Button press with active app forwards to that app
- ✅ Settings UI functional and intuitive
- ✅ Works on K900 and Mentra Live glasses
- ✅ No regressions in existing button functionality

### Nice to Have (V1)

- 🎯 Analytics show 50%+ users customize default app
- 🎯 < 0.1% error rate on button press handling
- 🎯 User feedback positive on predictability

### Future (V2+)

- 🔮 Support for long press actions
- 🔮 Non-app action types (screenshots, etc.)
- 🔮 Per-glasses profiles
- 🔮 Context-aware smart actions

---

## Technical Debt & Cleanup

### Items to Address Post-Launch

1. **Event Listener Optimization**
   - Consider debouncing button press events
   - Add rate limiting to prevent spam

2. **Settings Validation**
   - Add schema validation for settings
   - Migrate old settings format if needed

3. **Documentation**
   - Add JSDoc comments to new functions
   - Update architecture diagrams
   - Create user-facing help docs

4. **Code Quality**
   - Add unit tests for button press logic
   - Add integration tests for settings UI
   - Improve error handling and logging

---

## Timeline Estimate

| Phase                            | Duration     | Dependencies |
| -------------------------------- | ------------ | ------------ |
| Phase 1: Fix Auto-Start          | 2 hours      | None         |
| Phase 2: Settings Infrastructure | 1 hour       | Phase 1      |
| Phase 3: Button Event Handling   | 3 hours      | Phase 2      |
| Phase 4: App Picker Component    | 4 hours      | Phase 2      |
| Phase 5: Settings UI             | 3 hours      | Phase 3, 4   |
| Phase 6: Testing                 | 4 hours      | All phases   |
| **Total**                        | **17 hours** | -            |

_Assumes full-time focused work. Add 50% buffer for interruptions and unexpected issues._

---

## Open Questions

1. **Should we limit which apps can be default?**
   - Only foreground apps? (current plan)
   - Or allow background apps too?

2. **What about glasses with multiple buttons?**
   - G1 Pro has 2 buttons
   - Different defaults per button?
   - Future enhancement or V1 consideration?

3. **Should we show tutorial on first use?**
   - Explain button behavior to new users
   - One-time tooltip or help screen

4. **Analytics events to track?**
   - Button press success/failure rates
   - Default app change frequency
   - Most popular default apps

5. **Backward compatibility with old app versions?**
   - What if server doesn't support new button format?
   - Graceful degradation strategy?

---

## Dependencies

### External Dependencies

- None (all internal code changes)

### Internal Dependencies

- `GlobalEventEmitter` - event bus system
- `useSettingsStore` - settings persistence
- `AppletStatusProvider` - app state management
- `MantleBridge` - native bridge communication
- Glasses compatibility system

### Platform Requirements

- React Native >= 0.70
- iOS >= 14.0
- Android >= 8.0
- Glasses firmware supporting button events

---

## Risks & Mitigations

| Risk                                    | Impact | Probability | Mitigation                             |
| --------------------------------------- | ------ | ----------- | -------------------------------------- |
| Breaking existing button functionality  | High   | Low         | Comprehensive testing, staged rollout  |
| Users confused by new behavior          | Medium | Medium      | Clear UI, tutorial, documentation      |
| Performance impact from event listeners | Low    | Low         | Proper cleanup, performance monitoring |
| Incompatible apps cause crashes         | Medium | Low         | Compatibility checks, error handling   |
| Settings don't persist                  | High   | Low         | Settings tests, backup/restore         |

---

## Conclusion

This system provides a foundation for intelligent, user-controlled button behavior that can scale to future features while fixing the immediate problems with aggressive auto-start/stop behavior. The phased approach allows for incremental testing and validation, reducing risk of breaking existing functionality.

The key insight is intercepting button events in React Native BEFORE they go to the server, giving us full control while maintaining backward compatibility with existing app button handling.
