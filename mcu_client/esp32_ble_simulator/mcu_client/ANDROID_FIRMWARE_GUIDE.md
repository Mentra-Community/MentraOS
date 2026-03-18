# Android/Firmware Implementation Guide for Smart Glasses Integration

## Overview

This guide provides practical instructions for implementing a SmartGlassesCommunicator (SGC) to integrate new smart glasses with AugmentOS. The SGC serves as the bridge between AugmentOS and your smart glasses hardware.

## Key Files to Reference

- **SmartGlassesCommunicator.java** - The abstract base class you'll extend
- **EvenRealitiesG1SGC.java** - Good example of display implementation and dual device support
- **MentraLiveSGC.java** - Example of audio-only glasses with streaming capabilities

## Implementation Steps

### 1. Create Your SmartGlassesCommunicator

Create a new Java file extending `SmartGlassesCommunicator`:

```java
package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

public class YourGlassesSGC extends SmartGlassesCommunicator {
    private static final String TAG = "YourGlassesSGC";
    
    // BLE Service and Characteristic UUIDs
    private static final String SERVICE_UUID = "your-service-uuid";
    private static final String RX_CHAR_UUID = "your-rx-characteristic-uuid";
    private static final String TX_CHAR_UUID = "your-tx-characteristic-uuid";
    
    // Constructor
    public YourGlassesSGC(Context context, String glassesId) {
        super(context, glassesId);
        // Initialize your components
    }
}
```

### 2. Required Abstract Methods

#### findCompatibleDeviceNames()

This method is **void** and uses EventBus to communicate discovered devices:

```java
@Override
public void findCompatibleDeviceNames() {
    // Start scanning
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    
    if (adapter != null && adapter.isEnabled()) {
        Set<BluetoothDevice> pairedDevices = adapter.getBondedDevices();
        
        for (BluetoothDevice device : pairedDevices) {
            String deviceName = device.getName();
            if (deviceName != null && isYourGlassesDevice(deviceName)) {
                // Post discovery event for each compatible device found
                EventBus.getDefault().post(
                    new GlassesBluetoothSearchDiscoverEvent(
                        deviceModelName,  // Your glasses model name
                        deviceName        // The actual device name found
                    )
                );
            }
        }
    }
    
    // When done searching, post stop event
    EventBus.getDefault().post(
        new GlassesBluetoothSearchStopEvent(deviceModelName)
    );
}
```

#### connectToSmartGlasses()

```java
@Override
public void connectToSmartGlasses() {
    // Update state using the base class method
    connectionEvent(SmartGlassesConnectionState.CONNECTING);
    
    // Your BLE connection logic here
    BluetoothDevice device = bluetoothAdapter.getRemoteDevice(deviceMacAddress);
    bluetoothGatt = device.connectGatt(context, false, gattCallback);
}
```

#### Connection State Management

Use the `connectionEvent()` method from the base class to update connection states:

```java
// Available states from SmartGlassesConnectionState enum:
// DISCONNECTED, SCANNING, BONDING, CONNECTING, CONNECTED

// In your GATT callback:
@Override
public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
    if (newState == BluetoothProfile.STATE_CONNECTED) {
        connectionEvent(SmartGlassesConnectionState.CONNECTED);
        gatt.discoverServices();
    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        connectionEvent(SmartGlassesConnectionState.DISCONNECTED);
    }
}
```

### 3. Display Methods

Implement the display methods according to your hardware capabilities:

```java
@Override
public void displayReferenceCardSimple(String title, String body) {
    // Convert and send to your glasses format
}

@Override
public void displayBitmap(Bitmap bmp) {
    // Convert bitmap to your display format and send
}

@Override
public void blankScreen() {
    // Clear the display
}

// Implement other display methods as needed...
```

### 4. Audio Handling

The base SmartGlassesCommunicator already provides `audioProcessingCallback`. Use it when you receive audio data:

```java
// When you receive audio data from the glasses:
private void handleIncomingAudioData(byte[] audioData) {
    if (shouldUseGlassesMic && audioProcessingCallback != null) {
        // For raw PCM audio
        audioProcessingCallback.onAudioDataAvailable(audioData);
        
        // For LC3 encoded audio
        audioProcessingCallback.onLC3AudioDataAvailable(lc3Data);
    }
}
```

For LC3 audio decoding example (from EvenRealitiesG1SGC):
```java
if (lc3DecoderPtr != 0) {
    byte[] pcmData = L3cCpp.decodeLC3(lc3DecoderPtr, lc3);
    if (shouldUseGlassesMic) {
        if (audioProcessingCallback != null) {
            if (pcmData != null && pcmData.length > 0) {
                audioProcessingCallback.onAudioDataAvailable(pcmData);
            }
        }
    }
}
// Also send the LC3 data
audioProcessingCallback.onLC3AudioDataAvailable(lc3);
```

### 5. Event Handling

Use EventBus for specific events:

```java
// Battery events
EventBus.getDefault().post(new BatteryLevelEvent(
    batteryLevel,    // int: battery percentage (0-100)
    isCharging       // boolean: whether the glasses are charging
));

// Tap events (if your glasses support tap detection)
EventBus.getDefault().post(new GlassesTapOutputEvent(
    numTaps,         // int: number of taps (1, 2, or 3)
    sideOfGlasses,   // boolean: false = left side, true = right side
    timestamp        // long: timestamp of the tap event
));

// Head movement events (if your glasses have IMU/motion detection)
EventBus.getDefault().post(new GlassesHeadUpEvent());
EventBus.getDefault().post(new GlassesHeadDownEvent());

// Head angle data (if supported)
EventBus.getDefault().post(new HeadUpAngleEvent(headUpAngle));

// Case events (if your glasses have a charging case)
EventBus.getDefault().post(new CaseEvent(
    caseBatteryLevel,  // int: case battery percentage
    caseCharging,      // boolean: is case charging
    caseOpen,          // boolean: is case open
    caseRemoved        // boolean: are glasses removed from case
));

// Microphone state changes
EventBus.getDefault().post(new isMicEnabledForFrontendEvent(enable));

// Bluetooth discovery events (shown above in findCompatibleDeviceNames)
```

### 6. Methods You Don't Need to Implement

These methods have default implementations in the base class:
- `requestPhoto()` - Only if your glasses don't have a camera
- `requestWifiScan()`, `sendWifiCredentials()` - Only if your glasses don't have WiFi
- `requestRtmpStreamStart()`, `stopRtmpStream()` - Only if you don't support streaming
- `sendCustomCommand()` - Only if you don't need custom commands

### 7. BLE Implementation Tips

```java
private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
    @Override
    public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
        // Update connection state using connectionEvent()
    }
    
    @Override
    public void onServicesDiscovered(BluetoothGatt gatt, int status) {
        // Find your service and characteristics
        // Enable notifications on characteristics that send data
    }
    
    @Override
    public void onCharacteristicChanged(BluetoothGatt gatt, 
                                       BluetoothGattCharacteristic characteristic) {
        // Handle incoming data from glasses
        byte[] data = characteristic.getValue();
        // Process based on your protocol
    }
    
    @Override
    public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
        // Update your packet size for chunking if needed
    }
};
```

### 8. Cleanup

```java
@Override
public void destroy() {
    if (bluetoothGatt != null) {
        bluetoothGatt.close();
        bluetoothGatt = null;
    }
    connectionEvent(SmartGlassesConnectionState.DISCONNECTED);
}
```

## Firmware Protocol Considerations

Your firmware should handle:
1. BLE connection and characteristic setup
2. Message parsing and response
3. Display commands (if applicable)
4. Audio streaming (if applicable)
5. Battery level reporting
6. Any hardware-specific features (tap detection, etc.)

## Common Implementation Patterns

From EvenRealitiesG1SGC:
- Queue-based message sending with retry logic
- Chunking for large data (displays)
- Dual device support (left/right glasses)
- Font rendering and bitmap conversion

From MentraLiveSGC:
- Audio streaming focus
- Version information exchange
- Keep-alive mechanisms

## Testing Your Implementation

1. Test device discovery with `findCompatibleDeviceNames()`
2. Test connection/disconnection cycles
3. Test all display methods (if applicable)
4. Test audio streaming (if applicable)
5. Verify proper cleanup in `destroy()`

Remember: Look at the existing SGC implementations for patterns, but implement based on your specific hardware capabilities and requirements.

## UI Integration in mobile

To make your new glasses available in the AugmentOS Manager app UI, you need to update several files:

### 1. Add to Glasses Model List

In `mobile/src/app/pairing/select-glasses-model.tsx`, add your glasses to the appropriate platform array:

```javascript
// For Android support
const glassesOptions = Platform.select({
  android: [
    // ... existing models
    "Your Glasses Model Name",
  ],
  ios: [
    // ... existing models if iOS is supported
  ],
})
```

### 2. Define Glasses Features

In `mobile/src/config/glassesFeatures.ts`, add your glasses capabilities:

```javascript
"Your Glasses Model Name": {
  camera: false,       // if it has a camera
  speakers: false,     // if it has speakers
  display: true,       // if it has a display
  binocular: false,    // if it has binocular displays
  wifi: false,         // if it has WiFi
  imu: false,          // if it has IMU/motion sensors
  micTypes: ["sco"],   // microphone types: ["none"], ["sco"], ["custom"], or ["sco", "custom"]
},
```

### 3. Add Glasses Image

In `mobile/src/utils/getGlassesImage.tsx`:

```javascript
switch (glassesModel) {
  // ... existing cases
  case "Your Glasses Model Name":
    return require("@/assets/glasses/your-glasses-image.png");
}
```

Also add your glasses image to `mobile/assets/glasses/your-glasses-image.png`

### 4. Create Pairing Guide

In `mobile/src/components/misc/GlassesPairingGuides.tsx`, add a pairing guide component:

```javascript
const YourGlassesPairingGuide = () => (
  <View>
    <Text style={styles.subtitle}>How to pair Your Glasses:</Text>
    <Text style={styles.instructions}>
      1. Turn on your glasses{'\n'}
      2. Enable Bluetooth pairing mode{'\n'}
      3. Select your glasses from the list
    </Text>
  </View>
);
```

Then in `mobile/src/utils/getPairingGuide.tsx`:

```javascript
switch (glassesModel) {
  // ... existing cases
  case "Your Glasses Model Name":
    return <YourGlassesPairingGuide />;
}
```

### 5. WiFi Support (Optional)

If your glasses support WiFi, update `mobile/src/config/glassesFeatures.ts` to set `wifi: true` for your glasses model:

```javascript
"Your Glasses Model Name": {
  camera: false,
  speakers: false,
  display: true,
  binocular: false,
  wifi: true,        // Set to true if WiFi is supported
  imu: false,
  micTypes: ["sco"], // or ["custom"], ["none"], or ["sco", "custom"]
}
```

### Important Notes

- Use consistent naming: The model name must match exactly across all files
- The model name is used as the key throughout the system
- Platform selection: Add to iOS array only if iOS is supported
- Test the UI flow after adding your glasses model