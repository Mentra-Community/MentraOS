# MentraOS IMU Implementation Plan

## Overview

This plan outlines the implementation of IMU (Inertial Measurement Unit) data access for Mentra Live smart glasses over Bluetooth communication. The implementation will allow the phone to request single IMU readings, stream continuous IMU data, and subscribe to gesture events like head movements.

## Architecture Analysis

### Current Communication Stack

#### Glasses Side (ASG_client)

- **Main Service**: `AsgClientService` - Central service managing all communications
- **Command Processing**: `CommandProcessor` - Routes JSON commands to appropriate handlers
- **Bluetooth Manager**: `BaseBluetoothManager` and implementations handle BLE communication
- **Response Sending**: Via `ResponseSender` and `CommunicationManager`

#### Phone Side

- **Android**: `MentraLiveSGC` in android_core handles BLE communication
- **iOS**: `MentraLiveManager.swift` provides similar functionality
- **Protocol**: JSON messages with K900 protocol for reliability (ACK system with message IDs)

### Communication Flow

1. Phone sends JSON command via BLE
2. Glasses receive data in `BaseBluetoothManager.notifyDataReceived()`
3. `AsgClientService` receives via `BluetoothStateListener.onDataReceived()`
4. `CommandProcessor.processCommand()` parses and routes
5. Specific handler processes command
6. Response sent back via `ResponseSender`

## Implementation Components

### 1. Glasses Side (ASG_client)

#### A. Create IMU Manager (`ImuManager.java`)

Location: `asg_client/app/src/main/java/com/augmentos/asg_client/sensors/`

```java
package com.mentra.asg_client.sensors;

public class ImuManager implements SensorEventListener {
    private SensorManager sensorManager;
    private Sensor accelerometer;
    private Sensor gyroscope;
    private Sensor magnetometer;
    private Sensor rotationVector;

    // Streaming configuration
    private boolean isStreaming = false;
    private int streamRateHz = 50;
    private long batchingTimeMs = 0;
    private Handler streamHandler;

    // Gesture detection
    private GestureDetector gestureDetector;
    private Set<String> subscribedGestures;

    // Latest sensor values
    private float[] accelValues = new float[3];
    private float[] gyroValues = new float[3];
    private float[] magValues = new float[3];
    private float[] quaternion = new float[4];
    private float[] eulerAngles = new float[3];
}
```

#### B. Create IMU Command Handler (`ImuCommandHandler.java`)

Location: `asg_client/app/src/main/java/com/augmentos/asg_client/service/core/handlers/`

```java
public class ImuCommandHandler implements ICommandHandler {
    private ImuManager imuManager;
    private ResponseSender responseSender;

    public void handleCommand(CommandData commandData) {
        switch(commandData.type()) {
            case "imu_single":
                handleSingleReading(commandData);
                break;
            case "imu_stream_start":
                handleStreamStart(commandData);
                break;
            case "imu_stream_stop":
                handleStreamStop(commandData);
                break;
            case "imu_subscribe_gesture":
                handleGestureSubscription(commandData);
                break;
        }
    }
}
```

#### C. Create Gesture Detector (`ImuGestureDetector.java`)

Location: `asg_client/app/src/main/java/com/augmentos/asg_client/sensors/`

```java
public class ImuGestureDetector {
    // Detect head gestures based on sensor data
    public enum Gesture {
        HEAD_UP,
        HEAD_DOWN,
        NOD_YES,
        SHAKE_NO
    }

    // Threshold values for gesture detection
    private static final float HEAD_UP_PITCH_THRESHOLD = 30.0f;
    private static final float HEAD_DOWN_PITCH_THRESHOLD = -30.0f;
    private static final float NOD_VELOCITY_THRESHOLD = 2.0f;
    private static final float SHAKE_YAW_VELOCITY_THRESHOLD = 2.0f;
}
```

### 2. Phone Side - Android (android_core)

#### A. Add IMU Methods to MentraLiveSGC

Location: `android_core/.../MentraLiveSGC.java`

```java
// Single IMU reading request
public void requestImuSingle() {
    JSONObject json = new JSONObject();
    json.put("type", "imu_single");
    sendDataToGlasses(json.toString(), false);
}

// Start IMU streaming
public void startImuStream(int rateHz, long batchMs) {
    JSONObject json = new JSONObject();
    json.put("type", "imu_stream_start");
    json.put("rate_hz", rateHz);
    json.put("batch_ms", batchMs);
    sendDataToGlasses(json.toString(), false);
}

// Subscribe to gestures
public void subscribeToGestures(List<String> gestures) {
    JSONObject json = new JSONObject();
    json.put("type", "imu_subscribe_gesture");
    json.put("gestures", new JSONArray(gestures));
    sendDataToGlasses(json.toString(), false);
}

// Handle IMU responses
private void handleImuResponse(JSONObject json) {
    String type = json.getString("type");
    switch(type) {
        case "imu_response":
            handleSingleImuData(json);
            break;
        case "imu_stream_response":
            handleStreamImuData(json);
            break;
        case "imu_gesture_response":
            handleGestureDetected(json);
            break;
    }
}
```

### 3. Phone Side - iOS (mobile/ios)

#### A. Add IMU Methods to MentraLiveManager.swift

Location: `mobile/ios/BleManager/MentraLiveManager.swift`

```swift
// IMU request methods
func requestImuSingle() {
    let json: [String: Any] = ["type": "imu_single"]
    sendJsonToGlasses(json)
}

func startImuStream(rateHz: Int, batchMs: Int) {
    let json: [String: Any] = [
        "type": "imu_stream_start",
        "rate_hz": rateHz,
        "batch_ms": batchMs
    ]
    sendJsonToGlasses(json)
}

func subscribeToGestures(_ gestures: [String]) {
    let json: [String: Any] = [
        "type": "imu_subscribe_gesture",
        "gestures": gestures
    ]
    sendJsonToGlasses(json)
}
```

## Implementation Steps

### Phase 1: Basic Infrastructure (Week 1)

1. **Create ImuManager class** on glasses side
   - Initialize Android SensorManager
   - Register accelerometer, gyroscope, magnetometer sensors
   - Implement sensor data collection

2. **Create ImuCommandHandler**
   - Parse incoming IMU commands
   - Route to appropriate ImuManager methods
   - Format and send responses

3. **Register handler in CommandProcessor**
   - Add IMU command types to command registry
   - Wire up handler initialization

### Phase 2: Single Reading Support (Week 1)

1. **Implement single reading on glasses**
   - Collect current sensor values
   - Calculate quaternion from rotation vector
   - Convert to Euler angles
   - Send response with all data

2. **Add phone-side single reading support**
   - Android: Add method in MentraLiveSGC
   - iOS: Add method in MentraLiveManager
   - Parse and expose response data

### Phase 3: Streaming Support (Week 2)

1. **Implement streaming on glasses**
   - Configure sensor sampling rate
   - Implement batching with FIFO
   - Handle start/stop commands
   - Send batched data periodically

2. **Add phone-side streaming support**
   - Handle stream configuration
   - Process batched responses
   - Implement stream lifecycle management

### Phase 4: Gesture Detection (Week 2)

1. **Create gesture detector on glasses**
   - Implement head up/down detection
   - Implement nod yes detection (pitch oscillation)
   - Implement shake no detection (yaw oscillation)
   - Use thresholds and timing windows

2. **Add gesture subscription on phone**
   - Subscribe to specific gestures
   - Handle gesture events
   - Expose via EventBus/delegates

### Phase 5: Testing & Optimization (Week 3)

1. **Performance optimization**
   - Tune sampling rates
   - Optimize BLE packet sizes
   - Implement data compression if needed

2. **Testing**
   - Unit tests for sensor calculations
   - Integration tests for BLE communication
   - Gesture detection accuracy testing

## Technical Considerations

### Sensor Coordinate System

- Android uses right-handed coordinate system
- X-axis: points to the right (when facing screen)
- Y-axis: points up
- Z-axis: points toward user
- Rotations follow right-hand rule

### Data Formats

- Accelerometer: m/s² (meters per second squared)
- Gyroscope: rad/s (radians per second)
- Magnetometer: μT (micro-Tesla)
- Quaternion: [w, x, y, z] unit quaternion
- Euler angles: [roll, pitch, yaw] in degrees

### BLE Constraints

- MTU size limits (typically 512 bytes after negotiation)
- Rate limiting needed (minimum 160ms between sends)
- Batching recommended for high-frequency data
- Consider data compression for streams

### Power Management

- Use sensor batching to reduce wake-ups
- Implement adaptive sampling rates
- Stop sensors when not in use
- Consider using low-power sensor modes

### Error Handling

- Handle sensor unavailability gracefully
- Implement reconnection for lost BLE connections
- Validate command parameters
- Provide meaningful error responses

## Testing Strategy

### Unit Tests

- Sensor data conversion algorithms
- Gesture detection logic
- Command parsing and validation
- Response formatting

### Integration Tests

- End-to-end IMU data flow
- BLE communication reliability
- Stream start/stop lifecycle
- Gesture detection accuracy

### Performance Tests

- Maximum sustainable streaming rate
- Latency measurements
- Battery impact assessment
- Memory usage monitoring

## Future Enhancements

1. **Advanced Gestures**
   - Double tap detection
   - Custom gesture training
   - Continuous motion tracking

2. **Sensor Fusion**
   - Kalman filtering for smoother data
   - Improved orientation estimation
   - Motion prediction

3. **Calibration**
   - Magnetometer calibration
   - Gyroscope bias correction
   - User-specific gesture thresholds

4. **Analytics**
   - Head position tracking over time
   - Activity recognition
   - Posture monitoring

## Success Metrics

- Single reading latency < 100ms
- Stream data rate up to 100Hz sustainable
- Gesture detection accuracy > 95%
- Battery impact < 5% for typical usage
- Zero data loss during streaming

## Dependencies

- Android SensorManager API
- BLE communication stack (existing)
- JSON parsing (existing)
- EventBus for notifications (existing)

## Risk Mitigation

- **Risk**: High-frequency streaming impacts battery
  - **Mitigation**: Implement adaptive rates, batching
- **Risk**: BLE bandwidth limitations
  - **Mitigation**: Data compression, intelligent batching
- **Risk**: Sensor unavailability on some devices
  - **Mitigation**: Graceful degradation, feature detection

- **Risk**: Gesture false positives
  - **Mitigation**: Tunable thresholds, confirmation windows
