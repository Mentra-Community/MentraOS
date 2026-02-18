# ASG Client Overview

## What is ASG Client?

ASG Client is the Android application that runs on Android-based smart glasses (primarily Mentra Live). It serves as the bridge between the physical glasses hardware and the MentraOS ecosystem.

## Architecture

### Core Service: AsgClientService

The `AsgClientService` is the main Android service that coordinates all functionality:

1. **Bluetooth Communication**
   - Parses messages from the MentraOS mobile app via Bluetooth Low Energy (BLE)
   - Handles command processing from the phone
   - Sends status updates and media back to the phone

2. **Hardware Integration**
   - Parses messages from Mentra Live's microcontroller (MCU)
   - Processes button presses (camera button, etc.)
   - Handles swipe gestures on the glasses arms
   - Manages battery status reporting

3. **Media Management**
   - Triggers photo capture based on button presses
   - Manages video recording (in development)
   - Handles RTMP live streaming
   - Queues media for upload when connectivity is available

4. **Network Management**
   - Manages WiFi connections
   - Handles network state changes
   - Supports hotspot creation for initial setup

## Communication Flow

```
Physical Hardware → MCU → ASG Client → BLE → Mobile App → MentraOS Cloud
                                    ↓
                              Local Actions
                           (Photo, Stream, etc.)
```

### Button Press Example

1. User presses camera button on glasses
2. MCU sends `cs_pho` (short press) or `cs_vdo` (long press) to ASG Client
3. ASG Client checks button press mode configuration:
   - **PHOTO mode**: Takes photo locally and forwards to apps
   - **APPS mode**: Sends button event to phone/apps only
4. Photo is captured and queued for upload
5. When connected, photo uploads to MentraOS Cloud

## Key Components

### Bluetooth Managers

- **K900BluetoothManager**: Specific to Mentra Live hardware
- **StandardBluetoothManager**: Generic Android BLE implementation
- **NordicBluetoothManager**: For Nordic-based BLE chips

### Media Services

- **MediaCaptureService**: Handles photo/video capture
- **RtmpStreamingService**: Manages live video streaming
- **CameraWebServer**: HTTP server for remote photo access

### Network Services

- **K900NetworkManager**: Mentra Live specific WiFi management
- **FallbackNetworkManager**: Generic Android network management
- **NetworkSetupManager**: Handles initial WiFi setup

## Configuration

The client behavior can be configured through various settings:

- Button press modes (PHOTO, APPS)
- Network preferences
- Media quality settings
- Debug options

## Integration Points

1. **Mobile App Integration**: Via BLE using custom GATT characteristics
2. **Cloud Integration**: Through the mobile app relay
3. **Hardware Integration**: Via serial/UART communication with MCU
4. **Web Integration**: Through the built-in web server on port 8089
