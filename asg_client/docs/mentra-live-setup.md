# Mentra Live Setup Guide

This guide covers setting up and working with Mentra Live smart glasses, which use the ASG Client software.

## About Mentra Live

Mentra Live is an Android-based smart glasses device that:

- Runs a customized Android OS
- Has WiFi connectivity (no cellular)
- Supports ADB over WiFi only (no USB ADB)
- Communicates with the MentraOS mobile app via Bluetooth Low Energy

## Prerequisites

- Android Studio with Java SDK 17
- MentraOS mobile app installed on your phone
- Mentra Live glasses
- Computer and glasses on the same WiFi network

## Initial Setup

### 1. Pair Glasses with Mobile App

1. Install the MentraOS app on your phone
2. Turn on your Mentra Live glasses
3. Open the MentraOS app and go to pairing
4. Follow the in-app instructions to pair via Bluetooth

### 2. Connect Glasses to WiFi

1. In the MentraOS app, go to the "Glasses" screen
2. Select "WiFi Settings"
3. Choose your WiFi network and enter credentials
4. The glasses will connect to your WiFi network

### 3. Find the Glasses IP Address

1. In the MentraOS app, go to the "Glasses" screen
2. Look for "Local IP Address" - note this address
3. This IP is needed for ADB connection

## Connecting via ADB

Mentra Live only supports ADB over WiFi. Here's how to connect:

```bash
# Connect to the glasses using the IP from the app
# The glasses always use port 5555 for ADB
adb connect [GLASSES_IP]:5555

# Example:
adb connect 192.168.1.123:5555

# Verify the connection
adb devices
# Should show: 192.168.1.123:5555    device
```

### Troubleshooting ADB Connection

If you can't connect:

1. **Verify same network**: Ensure your computer and glasses are on the same WiFi
2. **Check IP address**: Confirm the IP in the MentraOS app is current
3. **Restart ADB**: Try `adb kill-server` then `adb start-server`
4. **Reboot glasses**: Power cycle the Mentra Live if needed

## Building and Installing ASG Client

### 1. Build the APK

```bash
# Navigate to the asg_client directory
cd /path/to/asg_client

# Build debug APK
./gradlew assembleDebug

# The APK will be at:
# app/build/outputs/apk/debug/app-debug.apk
```

### 2. Install on Glasses

```bash
# Make sure you're connected via ADB first
adb install app/build/outputs/apk/debug/app-debug.apk

# For reinstalling (updating)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 3. Local Development Setup

For testing with a local MentraOS server:

```bash
# Forward the local server port to the glasses
# This makes localhost:8002 on glasses connect to your computer's port 8002
adb reverse tcp:8002 tcp:8002

# Now configure your .env file:
# MENTRAOS_HOST=localhost
# MENTRAOS_PORT=8002
# MENTRAOS_SECURE=false
```

## Viewing Logs

To see what's happening on the glasses:

```bash
# View all logs
adb logcat

# Filter for ASG Client logs
adb logcat | grep -E "AsgClientService|MediaCapture|RtmpStreaming"

# Save logs to file
adb logcat > glasses_logs.txt
```

### Useful Log Filters

```bash
# Button presses
adb logcat | grep "cs_pho\|cs_vdo"

# Bluetooth communication
adb logcat | grep "BluetoothManager"

# Network status
adb logcat | grep "NetworkManager\|WiFi"

# RTMP streaming
adb logcat | grep "RtmpStreaming"
```

## Common Tasks

### Check Service Status

```bash
# See if ASG Client service is running
adb shell ps | grep augmentos

# Check for crashes
adb logcat | grep -E "FATAL|AndroidRuntime"
```

### Clear App Data

```bash
# Clear all app data (settings, cache, etc.)
adb shell pm clear com.mentra.asg_client
```

### Take Screenshot

```bash
# Capture what's on the glasses display
adb shell screencap -p /sdcard/screenshot.png
adb pull /sdcard/screenshot.png
```

### Access Device Shell

```bash
# Open shell on glasses
adb shell

# Navigate to app data (requires root on some devices)
cd /data/data/com.mentra.asg_client/
```

## Tips for Development

1. **Keep glasses charged**: Development drains battery faster
2. **Use stable WiFi**: Connection drops will interrupt ADB
3. **Monitor temperature**: Glasses may throttle if too hot
4. **Test offline scenarios**: Glasses often lose connectivity
5. **Check permissions**: Ensure camera, storage, network permissions are granted

## Hardware Specifics

### Button Mappings

- **Short press camera button**: Sends `cs_pho` command
- **Long press camera button**: Sends `cs_vdo` command
- **Swipe on arms**: Sends swipe commands

### LED Indicators

- Check the glasses documentation for LED meaning
- Usually indicates power, connectivity, or recording status

### Factory Reset

If needed, you can factory reset through:

1. Settings in the glasses UI (if accessible)
2. MentraOS app settings
3. Hardware button combination (see manual)
