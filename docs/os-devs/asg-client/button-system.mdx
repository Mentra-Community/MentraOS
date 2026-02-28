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

The ASG Client supports three configurable modes for handling button presses:

#### PHOTO Mode (Default)

- Button press triggers local photo/video capture only
- Photos are taken immediately on the device
- No communication with phone/cloud for the button press

```java
// Short press behavior in PHOTO mode
case "cs_pho":
    mMediaCaptureService.takePhotoLocally();
    break;
```

#### APPS Mode

- Button press events are sent to the phone/apps only
- No local photo capture
- Apps can decide what to do with the button press

```java
// Button press sent to phone in APPS mode
sendButtonPressToPhone(isLongPress);
```

#### BOTH Mode

- Combines PHOTO and APPS modes
- Takes photo locally AND sends event to apps
- Maximum flexibility for developers

### Implementation Details

The button handling is implemented in `AsgClientService.java`:

```java
private void handleConfigurableButtonPress(boolean isLongPress) {
    AsgSettings.ButtonPressMode mode = asgSettings.getButtonPressMode();
    String pressType = isLongPress ? "long" : "short";

    switch (mode) {
        case PHOTO:
            if (isLongPress) {
                // Video recording (TODO)
            } else {
                mMediaCaptureService.takePhotoLocally();
            }
            break;

        case APPS:
            sendButtonPressToPhone(isLongPress);
            break;

        case BOTH:
            // Do both actions
            break;
    }
}
```

### Button Press Message Format

When sending button press to phone (APPS or BOTH mode):

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

- **Use PHOTO mode** for simple camera glasses functionality
- **Use APPS mode** when apps need full control over button behavior
- **Use BOTH mode** for advanced scenarios where both local and remote actions are needed

## Photo Capture Process

When a photo is triggered (PHOTO or BOTH mode):

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
