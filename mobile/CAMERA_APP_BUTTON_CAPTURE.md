# Camera App Button Capture System

## Overview

The button capture system now responds to the camera app's running state. Button presses are ALWAYS forwarded to apps, but local photo/video capture only happens when the camera app is active.

## How It Works

### State Tracking

The mobile app watches the camera app (`com.augmentos.camera`) running state and automatically sends updates to the glasses:

```
Camera App Started → is_running: true  → Send: save_in_gallery_mode = true
Camera App Stopped → is_running: false → Send: save_in_gallery_mode = false
```

### Button Press Behavior

**When Camera App is RUNNING:**

- Button press → Forward to apps + Capture locally ✅

**When Camera App is STOPPED:**

- Button press → Forward to apps only (no capture) ✅

## Implementation

### Mobile App (React Native)

**Location**: `mobile/src/contexts/AppletStatusProvider.tsx`

```typescript
// Watch camera app state and send gallery mode updates to glasses (Android only)
useEffect(() => {
  if (Platform.OS !== "android") return

  const cameraApp = appStatus.find(app => app.packageName === "com.augmentos.camera")

  if (cameraApp) {
    const isRunning = cameraApp.is_running ?? false
    console.log(`Camera app state changed: is_running = ${isRunning}`)
    bridge.sendGalleryModeActive(isRunning)
  }
}, [appStatus])
```

**Location**: `mobile/src/bridge/MantleBridge.tsx`

```typescript
async sendGalleryModeActive(active: boolean) {
  return await this.sendData({
    command: "send_gallery_mode_active",
    params: {
      active: active,
    },
  })
}
```

### Android Core (AugmentOS Service)

**Command Parsing**: `android_core/app/src/main/java/.../AugmentOsManagerMessageParser.java`

```java
case "send_gallery_mode_active":
    boolean active = commandObject.getJSONObject("params").getBoolean("active");
    callback.sendGalleryModeActive(active);
    break;
```

**Service Handler**: `android_core/app/src/main/java/.../AugmentosService.java`

```java
@Override
public void sendGalleryModeActive(boolean active) {
    Log.d("AugmentOsService", "📸 Sending gallery mode active to glasses: " + active);

    if (smartGlassesManager != null && smartGlassesManagerBound) {
        smartGlassesManager.sendGalleryModeActive(active);
    }
}
```

**SGC Communication**: `android_core/app/src/main/java/.../MentraLiveSGC.java`

```java
@Override
public void sendGalleryModeActive(boolean active) {
    Log.d(TAG, "📸 Sending gallery mode active to glasses: " + active);

    if (!isConnected) {
        Log.w(TAG, "Cannot send gallery mode - not connected");
        return;
    }

    try {
        JSONObject json = new JSONObject();
        json.put("type", "save_in_gallery_mode");
        json.put("active", active);
        json.put("timestamp", System.currentTimeMillis());
        sendJson(json);
    } catch (JSONException e) {
        Log.e(TAG, "Error creating gallery mode message", e);
    }
}
```

### ASG Client (Mentra Live Glasses)

**Command Handler**: `asg_client/app/src/main/java/.../GalleryModeCommandHandler.java`

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

**State Storage**: `asg_client/app/src/main/java/.../AsgSettings.java`

```java
private volatile boolean saveInGalleryMode = false;

public boolean isSaveInGalleryMode() {
    return saveInGalleryMode;
}

public void setSaveInGalleryMode(boolean inGalleryMode) {
    Log.d(TAG, "📸 Gallery mode state changed: " + (inGalleryMode ? "ACTIVE" : "INACTIVE"));
    this.saveInGalleryMode = inGalleryMode;
}
```

**Button Handler**: `asg_client/app/src/main/java/.../K900CommandHandler.java`

```java
private void handlePhotoCapture(boolean isLongPress) {
    // Check if gallery/camera app is active
    boolean isSaveInGalleryMode = serviceManager.getAsgSettings().isSaveInGalleryMode();

    if (!isSaveInGalleryMode) {
        Log.d(TAG, "📸 Camera app not active - skipping local capture");
        return;
    }

    // Proceed with capture...
}
```

## Complete Data Flow

```
┌─────────────────────────────────────────────┐
│  Mobile App (React Native)                  │
├─────────────────────────────────────────────┤
│  User starts Camera app                     │
│    ↓                                        │
│  AppletStatusProvider                       │
│    ├─ Detects: camera app is_running = true│
│    └─ Calls: bridge.sendGalleryModeActive(true)│
└──────────────────┬──────────────────────────┘
                   │
                   ↓ (Native Bridge)
┌─────────────────────────────────────────────┐
│  Android Core (AugmentOS Service)           │
├─────────────────────────────────────────────┤
│  AugmentOsManagerMessageParser              │
│    ↓                                        │
│  AugmentosService.sendGalleryModeActive()  │
│    ↓                                        │
│  SmartGlassesManager.sendGalleryModeActive()│
│    ↓                                        │
│  MentraLiveSGC.sendGalleryModeActive()     │
└──────────────────┬──────────────────────────┘
                   │
                   ↓ (Bluetooth)
┌─────────────────────────────────────────────┐
│  ASG Client (Mentra Live Glasses)           │
├─────────────────────────────────────────────┤
│  K900BluetoothManager.onDataReceived()     │
│    ↓                                        │
│  CommandProcessor.processCommand()          │
│    ↓                                        │
│  GalleryModeCommandHandler.handleCommand() │
│    ↓                                        │
│  AsgSettings.setSaveInGalleryMode(true)    │
│    ↓                                        │
│  [STATE STORED: saveInGalleryMode = true]  │
└─────────────────────────────────────────────┘

...Later, when button pressed...

┌─────────────────────────────────────────────┐
│  Physical Button Press on Glasses           │
│    ↓                                        │
│  MCU → cs_pho command                       │
│    ↓                                        │
│  K900CommandHandler                         │
│    ├─ ALWAYS: sendButtonPressToPhone()     │
│    └─ handlePhotoCapture()                 │
│         ├─ CHECK: isSaveInGalleryMode?     │
│         ├─ YES → Capture photo/video       │
│         └─ NO  → Skip capture              │
└─────────────────────────────────────────────┘
```

## Message Format

```json
{
  "type": "save_in_gallery_mode",
  "active": true,
  "timestamp": 1696352400000
}
```

## Benefits

1. **Automatic**: No manual mode switching required
2. **Intent-based**: Captures only when camera app is active
3. **Clean UX**: User doesn't see confusing mode options
4. **Storage efficient**: No unwanted captures
5. **App flexibility**: Apps always receive button events

## Testing

### Test Case 1: Camera App Active

1. Start camera app from home screen
2. App state changes to `is_running: true`
3. Gallery mode message sent: `active: true`
4. Press button on glasses
5. **Expected**: Photo captured + button event forwarded

### Test Case 2: Camera App Inactive

1. Stop camera app or navigate away
2. App state changes to `is_running: false`
3. Gallery mode message sent: `active: false`
4. Press button on glasses
5. **Expected**: No photo captured, only button event forwarded

### Test Case 3: App Switch

1. Start camera app → gallery mode = true
2. Stop camera app → gallery mode = false
3. Start another app
4. Press button
5. **Expected**: No photo captured

### Test Case 4: Connection State

1. Disconnect glasses
2. Start camera app
3. Reconnect glasses
4. **Expected**: State resets to false, needs new activation

## Troubleshooting

**Issue**: Button not capturing when camera app is running

- Check logs for "Camera app state changed: is_running = true"
- Verify message sent: "Gallery mode active message sent"
- Check ASG Client logs for "Gallery mode state changed: ACTIVE"
- Verify `saveInGalleryMode` flag is set

**Issue**: Button capturing when camera app is stopped

- Check if stop event was sent
- Verify `saveInGalleryMode` flag is cleared
- Check for stale state after reconnection

**Issue**: Message not reaching glasses

- Verify Bluetooth connection is active
- Check Android Core service is running
- Verify SmartGlassesManager is bound
- Check command handler registration
