# Button Press System

The button press system in ASG Client handles physical button interactions on the smart glasses and determines what actions to take.

## How It Works

### Button Press Flow

1. **Physical Press**: User presses the camera button on the glasses
2. **MCU Detection**: The glasses' microcontroller detects the press
3. **Command Generation**: MCU sends a command to ASG Client:
   - `cs_pho` - Short press (photo)
   - `cs_vdo` - Long press (video)
4. **ASG Client Processing**: The service receives and processes the command
5. **Action Execution**: Based on configuration, takes appropriate action

### Button Press Modes

The ASG Client supports two configurable modes for handling button presses:

**IMPORTANT**: As of the latest update, **ALL button presses are now forwarded to phone/apps regardless of mode**. The mode now only controls additional local actions.

#### PHOTO Mode (Default)

- Button press is **ALWAYS forwarded** to phone/apps
- Additionally triggers local photo/video capture
- Apps receive the button press event AND local capture occurs

```java
// Universal forwarding + local capture in PHOTO mode
sendButtonPressToPhone(isLongPress); // Always forwarded
mMediaCaptureService.takePhotoLocally(); // Local action
```

#### APPS Mode

- Button press events are sent to the phone/apps only
- No additional local photo capture
- Apps receive the button press event and decide what to do

```java
// Universal forwarding in APPS mode
sendButtonPressToPhone(isLongPress); // Always forwarded
// No local actions
```

### Implementation Details

The button handling is implemented in `K900CommandHandler.java`:

```java
private void handleConfigurableButtonPress(boolean isLongPress) {
    AsgSettings.ButtonPressMode mode = serviceManager.getAsgSettings().getButtonPressMode();
    String pressType = isLongPress ? "long" : "short";
    Log.d(TAG, "Handling " + pressType + " button press with mode: " + mode.getValue());

    // ALWAYS send button press to phone/apps regardless of mode
    Log.d(TAG, "📱 ALWAYS forwarding button press to phone/apps (universal forwarding)");
    sendButtonPressToPhone(isLongPress);

    // Then handle mode-specific local actions
    switch (mode) {
        case PHOTO:
            handlePhotoMode(isLongPress); // Local capture + forwarding
            break;

        case APPS:
            // APPS mode: only forwarding (already done above)
            Log.d(TAG, "📱 APPS mode: button press forwarded, no local action");
            break;
    }
}
```

### Button Press Message Format

When sending button press to phone (now **ALL modes**):

```json
{
  "type": "button_press",
  "buttonId": "camera",
  "pressType": "short", // or "long"
  "timestamp": 1234567890
}
```

### Other Button Commands

Besides camera button, the system also handles:

- **Swipe gestures**: `cs_swst` commands from arm swipes
- **Battery status**: `hm_batv` with battery percentage and voltage
- **Hotspot control**: `hm_htsp`/`mh_htsp` for WiFi hotspot

## Configuration

### Setting Button Mode

The button mode can be configured via:

1. Settings in the MentraOS app
2. Direct configuration through AsgSettings
3. Debug commands during development

### Mode Selection Guidelines

- **Use PHOTO mode** for camera glasses functionality with universal app forwarding
- **Use APPS mode** when apps need full control over button behavior (no local capture)

**Note**: Both modes now forward button presses to apps. The mode only controls whether local photo/video capture also occurs.

## Photo Capture Process

When a photo is triggered (PHOTO mode):

1. **Capture**: CameraNeo takes the photo
2. **Save**: Photo saved to device storage
3. **Queue**: Added to upload queue if online
4. **Upload**: Sent to cloud when connection available
5. **Cleanup**: Local copy managed based on settings

## Video Recording

Video recording on long press is currently in development. The infrastructure is in place but the full implementation is pending.

## Troubleshooting

### Button Press Not Working

1. **Check logs**: Look for `cs_pho` or `cs_vdo` in logcat
2. **Verify mode**: Ensure correct button mode is set
3. **Service status**: Confirm AsgClientService is running
4. **Permissions**: Check camera and storage permissions

### Common Issues

- **No MCU commands**: Check hardware connection to microcontroller
- **Service not responding**: May need to restart AsgClientService
- **Wrong mode active**: Verify configuration in settings

## Future Enhancements

- Full video recording implementation
- Custom button mappings
- Gesture combinations
- Multi-button support
