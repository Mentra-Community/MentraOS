# K900 Recording LED Control Implementation

## Overview

This implementation adds recording LED control for K900 smart glasses using the native `libxydev.so` library provided by the ODM.

## Architecture

### JNI Layer (Required Package Structure)

The JNI native library `libxydev.so` requires specific package names:

- `com/dev/api/XyDev.java` - JNI wrapper class
- `com/dev/api/DevApi.java` - High-level API

These MUST remain in the `com.dev.api` package to match the native library signatures.

### Application Layer

- `com/augmentos/asg_client/hardware/K900LedController.java` - Singleton LED controller
- Integration in `MediaCaptureService.java` for automatic LED control during recording

## LED Behavior

### Video Recording

- **Start Recording**: LED turns ON (solid)
- **Stop Recording**: LED turns OFF
- **Recording Error**: LED turns OFF

### Buffer Recording

- **Buffer Active**: LED blinks (1s on, 2s off)
- **Buffer Stopped**: LED turns OFF
- **Buffer Error**: LED turns OFF

## Usage

### Automatic Control (Integrated)

The LED automatically turns on/off when video recording starts/stops through MediaCaptureService.

### Manual Control via SysControl

```java
// Turn LED on
SysControl.setRecordingLedOn(true);

// Turn LED off
SysControl.setRecordingLedOn(false);

// Start blinking
SysControl.setRecordingLedBlinking(true);

// Flash for 500ms
SysControl.flashRecordingLed(500);
```

### Direct Control via K900LedController

```java
K900LedController led = K900LedController.getInstance();

// Basic control
led.turnOn();
led.turnOff();

// Blinking
led.startBlinking(); // Default pattern
led.startBlinking(500, 1000); // Custom: 500ms on, 1000ms off
led.stopBlinking();

// Flash
led.flash(1000); // Flash for 1 second
```

## Testing

### Via ADB (when app is running)

```bash
# Turn LED on
adb shell am broadcast -a com.mentra.asg_client.TEST_LED --es command "on"

# Turn LED off
adb shell am broadcast -a com.mentra.asg_client.TEST_LED --es command "off"

# Start blinking
adb shell am broadcast -a com.mentra.asg_client.TEST_LED --es command "blink"
```

### Via Recording Commands

Simply start/stop video recording through the normal MentraOS commands - the LED will automatically activate.

## Error Handling

- If `libxydev.so` fails to load, the LED controller will log errors but won't crash the app
- All LED operations are wrapped in try-catch blocks to prevent crashes
- LED operations run on a dedicated thread to avoid blocking the main thread

## Files Modified

1. Created `com/dev/api/XyDev.java` - JNI wrapper
2. Created `com/dev/api/DevApi.java` - Device API
3. Created `com/augmentos/asg_client/hardware/K900LedController.java` - LED controller
4. Modified `MediaCaptureService.java` - Added LED control to recording callbacks
5. Modified `SysControl.java` - Added convenience methods for LED control

## Native Library

The `libxydev.so` library is already included in:

- `app/src/main/jniLibs/armeabi-v7a/libxydev.so`
- `app/src/main/jniLibs/arm64-v8a/libxydev.so`

## Notes

- The LED control is K900-specific and won't work on other glasses models
- The package structure for JNI classes cannot be changed
- LED state is not persisted across app restarts
- Buffer recording uses a blinking pattern to differentiate from normal recording
