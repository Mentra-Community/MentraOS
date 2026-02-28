# Photo Capture Testing Framework

## Overview

The PhotoCaptureTestFramework allows you to test different failure scenarios in the photo capture pipeline in real-time by modifying static variables.

## Master Controls

### Enable/Disable Testing

```java
// In MediaCaptureService.java, PhotoCaptureTestFramework class:
public static final boolean ENABLE_FAKE_FAILURES = false;  // Master switch
public static final boolean ENABLE_FAKE_DELAYS = false;    // Add artificial delays
```

### Step-Specific Controls

```java
public static final boolean FAIL_CAMERA_INIT = false;          // Camera initialization
public static final boolean FAIL_CAMERA_CAPTURE = false;       // Photo capture
public static final boolean FAIL_IMAGE_COMPRESSION = false;    // Image compression
public static final boolean FAIL_BLE_TRANSFER = false;         // BLE file transfer
public static final boolean FAIL_CLOUD_UPLOAD = false;         // Cloud upload
public static final boolean FAIL_RANDOM_STEP = false;          // Random failure
```

### Configuration

```java
public static String FAILURE_TYPE = FAILURE_TYPE_CAMERA_INIT;  // Which failure to simulate
public static final double FAILURE_PROBABILITY = 1.0;          // 0.0 to 1.0 (100% when enabled)
public static final int FAKE_DELAY_MS = 5000;                  // Artificial delay in milliseconds
```

## Testing Scenarios

### 1. Test Camera Initialization Failure

```java
ENABLE_FAKE_FAILURES = true;
FAIL_CAMERA_INIT = true;
```

**Expected Result**: Photo request fails immediately with `CAMERA_INIT_FAILED` error

### 2. Test Camera Capture Failure

```java
ENABLE_FAKE_FAILURES = true;
FAIL_CAMERA_CAPTURE = true;
```

**Expected Result**: Camera initializes but photo capture fails with `CAMERA_CAPTURE_FAILED` error

### 3. Test Image Compression Failure

```java
ENABLE_FAKE_FAILURES = true;
FAIL_IMAGE_COMPRESSION = true;
```

**Expected Result**: Photo captured but compression fails with `COMPRESSION_FAILED` error

### 4. Test BLE Transfer Failure

```java
ENABLE_FAKE_FAILURES = true;
FAIL_BLE_TRANSFER = true;
```

**Expected Result**: Photo compressed but BLE transfer fails with `BLE_TRANSFER_FAILED` error

### 5. Test Cloud Upload Failure

```java
ENABLE_FAKE_FAILURES = true;
FAIL_CLOUD_UPLOAD = true;
```

**Expected Result**: Photo captured but upload fails with `UPLOAD_FAILED` error

### 6. Test Timeout Scenarios

```java
ENABLE_FAKE_DELAYS = true;
FAKE_DELAY_MS = 10000;  // 10 second delay
```

**Expected Result**: Photo request times out after delay

### 7. Test Random Failures

```java
ENABLE_FAKE_FAILURES = true;
FAILURE_TYPE = FAILURE_TYPE_RANDOM;
FAILURE_PROBABILITY = 0.5;  // 50% chance of failure
```

**Expected Result**: Random failures at different steps

## Error Response Format

All fake failures return structured error responses:

```json
{
  "type": "photo_error_response",
  "requestId": "test_123",
  "success": false,
  "error": {
    "code": "CAMERA_INIT_FAILED",
    "message": "TESTING: Fake camera initialization failure",
    "details": {
      "stage": "GLASSES_CAMERA_INIT",
      "retryable": false,
      "userMessage": "Camera initialization failed - check camera hardware",
      "timestamp": 1234567890,
      "source": "glasses"
    }
  }
}
```

## Usage Instructions

1. **Modify the variables** in `MediaCaptureService.java` PhotoCaptureTestFramework class
2. **Rebuild the app** to apply changes
3. **Send photo requests** through the SDK
4. **Monitor logs** for test configuration and failure simulation
5. **Check error responses** in the SDK callback

## Log Output

The framework logs its configuration on each photo request:

```
D/PhotoTest: === PHOTO CAPTURE TEST CONFIG ===
D/PhotoTest: ENABLE_FAKE_FAILURES: true
D/PhotoTest: ENABLE_FAKE_DELAYS: false
D/PhotoTest: FAILURE_TYPE: CAMERA_INIT_FAILED
D/PhotoTest: FAIL_CAMERA_INIT: true
D/PhotoTest: FAIL_CAMERA_CAPTURE: false
D/PhotoTest: FAIL_IMAGE_COMPRESSION: false
D/PhotoTest: FAIL_BLE_TRANSFER: false
D/PhotoTest: FAIL_CLOUD_UPLOAD: false
D/PhotoTest: FAIL_RANDOM_STEP: false
D/PhotoTest: ================================
```

## Testing Checklist

- [ ] Camera initialization failure
- [ ] Camera capture failure
- [ ] Image compression failure
- [ ] BLE transfer failure
- [ ] Cloud upload failure
- [ ] Timeout scenarios
- [ ] Random failures
- [ ] Error propagation to SDK
- [ ] Retry logic
- [ ] Fallback mechanisms
