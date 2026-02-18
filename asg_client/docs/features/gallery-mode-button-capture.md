# Gallery Mode Button Capture System

## Overview

The gallery mode button capture system allows conditional photo/video capture based on whether the phone's gallery view is currently active. This prevents unwanted local captures when the user is not in the gallery/camera interface.

## How It Works

### State Synchronization

The mobile app sends gallery mode state updates to the glasses via Bluetooth:

```json
{
  "type": "save_in_gallery_mode",
  "active": true,
  "timestamp": 1234567890
}
```

### Button Press Behavior

**When Gallery Mode is ACTIVE:**

- Button press is forwarded to apps (always)
- Local photo/video capture is triggered
- LED flash operates normally

**When Gallery Mode is INACTIVE:**

- Button press is forwarded to apps (always)
- Local photo/video capture is skipped
- No local storage used

## Implementation

### ASG Client Components

#### 1. State Storage (`AsgSettings.java`)

```java
// Transient state - not persisted, resets on restart
private volatile boolean saveInGalleryMode = false;

public boolean isSaveInGalleryMode() {
    return saveInGalleryMode;
}

public void setSaveInGalleryMode(boolean inGalleryMode) {
    Log.d(TAG, "📸 Gallery mode state changed: " + (inGalleryMode ? "ACTIVE" : "INACTIVE"));
    this.saveInGalleryMode = inGalleryMode;
}
```

**Key Points:**

- Uses `volatile` for thread safety
- NOT persisted to SharedPreferences (transient state)
- Defaults to `false` on service startup
- Resets to `false` on service restart

#### 2. Command Handler (`GalleryModeCommandHandler.java`)

Processes `save_in_gallery_mode` messages from the phone:

```java
public class GalleryModeCommandHandler implements ICommandHandler {
    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("save_in_gallery_mode");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        boolean active = data.optBoolean("active", false);
        serviceManager.getAsgSettings().setSaveInGalleryMode(active);
        return true;
    }
}
```

#### 3. Button Handler (`K900CommandHandler.java`)

Modified `handlePhotoMode()` to check gallery mode state:

```java
private void handlePhotoMode(boolean isLongPress) {
    // Check if gallery mode is active before capturing
    boolean isSaveInGalleryMode = serviceManager
        .getAsgSettings()
        .isSaveInGalleryMode();

    if (!isSaveInGalleryMode) {
        Log.d(TAG, "📸 Gallery mode not active - skipping local capture");
        return; // Button press already forwarded to apps
    }

    // Proceed with normal capture logic...
}
```

### Mobile App Components

#### Gallery View Integration

The gallery screen uses `useFocusEffect` to detect when it's active:

```typescript
import {useFocusEffect} from "@react-navigation/native"
import {bridge} from "@/bridge/MantleBridge"

export default function GalleryScreen() {
  useFocusEffect(
    useCallback(() => {
      // Gallery view focused - enable local capture
      bridge.sendGalleryModeActive(true)

      return () => {
        // Gallery view unfocused - disable local capture
        bridge.sendGalleryModeActive(false)
      }
    }, []),
  )

  // ... rest of component ...
}
```

#### Bridge Communication

**TypeScript (MantleBridge):**

```typescript
async sendGalleryModeActive(active: boolean) {
  return await this.sendData({
    command: "send_gallery_mode_active",
    params: { active }
  })
}
```

**iOS (Bridge.swift):**

```swift
static func sendGalleryModeActive(active: Bool) {
    let message: [String: Any] = [
        "type": "save_in_gallery_mode",
        "active": active,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000),
    ]
    MentraManager.shared.sgc?.sendJson(message)
}
```

## Data Flow

```
Mobile Gallery Screen
  ↓
useFocusEffect (focus/blur)
  ↓
Bridge.sendGalleryModeActive(true/false)
  ↓
Bluetooth → Mentra Live Glasses
  ↓
K900BluetoothManager.onDataReceived()
  ↓
CommandProcessor
  ↓
GalleryModeCommandHandler
  ↓
AsgSettings.setSaveInGalleryMode(active)
  ↓
[STATE STORED]

...Later, when button pressed...

Physical Button Press
  ↓
MCU → cs_pho/cs_vdo command
  ↓
K900CommandHandler.handleConfigurableButtonPress()
  ↓
ALWAYS: sendButtonPressToPhone() ← Universal forwarding
  ↓
IF PHOTO mode:
  ↓
handlePhotoMode()
  ├─ CHECK: isSaveInGalleryMode()?
  ├─ YES → capture photo/video
  └─ NO  → skip capture, return early
```

## Configuration

### Button Mode Interaction

Gallery mode state works with existing button modes:

| Button Mode | Gallery Mode | Behavior          |
| ----------- | ------------ | ----------------- |
| PHOTO       | ACTIVE       | Forward + Capture |
| PHOTO       | INACTIVE     | Forward only      |
| APPS        | ACTIVE       | Forward only      |
| APPS        | INACTIVE     | Forward only      |

**Note:** APPS mode never captures locally regardless of gallery mode state.

## Benefits

1. **Storage Efficiency**: No unwanted captures when not in gallery view
2. **User Intent**: Respects user's current context
3. **App Flexibility**: Apps always receive button events
4. **Clean UX**: Captures only when viewing/managing photos

## Troubleshooting

### Button Not Capturing in Gallery

1. **Check logs** for "Gallery mode not active" message
2. **Verify** gallery screen is sending state updates
3. **Test** navigation: focus/blur should toggle state
4. **Confirm** button mode is set to PHOTO

### Unwanted Captures Outside Gallery

1. **Check logs** for gallery mode state changes
2. **Verify** unfocus event is firing when leaving gallery
3. **Test** app switching and backgrounding

### State Not Syncing

1. **Verify** Bluetooth connection is active
2. **Check** command handler registration in logs
3. **Test** manual state toggle from debug interface

## Testing Checklist

- [ ] Navigate to gallery → state = ACTIVE
- [ ] Press button in gallery → should capture
- [ ] Navigate away → state = INACTIVE
- [ ] Press button outside gallery → should NOT capture
- [ ] Button press always forwards to apps (both cases)
- [ ] Disconnect/reconnect → state resets to INACTIVE
- [ ] App backgrounding → verify state handling
- [ ] Mode change (PHOTO ↔ APPS) → verify interaction

## Future Enhancements

- [ ] Persist gallery mode preference across sessions (if needed)
- [ ] Add UI indicator showing gallery mode state
- [ ] Support multiple offline apps with capture capability
- [ ] Add manual override toggle in settings
