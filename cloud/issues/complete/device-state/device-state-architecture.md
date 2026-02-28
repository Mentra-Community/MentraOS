# Device State REST API - Architecture

## Current System (Before)

```
Android Core → CoreStatusProvider
  ├─> status.glasses_info.model_name ✅ (updated)
  └─> useGlassesStore.connected ❌ (stale, never synced)
       └─> SocketComms reads stale store
            └─> WebSocket: GLASSES_CONNECTION_STATE = "DISCONNECTED"
                 └─> Cloud: glassesConnected = false
                      └─> Display requests fail ❌
```

**Problem:** Two sources of truth never synchronized.

**Result:** 30% of display requests fail with `GLASSES_DISCONNECTED` even when glasses are connected and audio is flowing.

## New System (After)

```
Android Core → CoreStatusProvider
  └─> Watches status.glasses_info.model_name
       └─> REST: POST /api/client/device/state
            └─> Cloud: DeviceManager.updateDeviceState()
                 ├─> Infers connected from modelName
                 ├─> Updates capabilities
                 ├─> Notifies MicrophoneManager
                 └─> Display requests succeed ✅
```

**Fix:** Single explicit state update via REST. Connection inferred from model name presence.

## Key Implementation Details

### 1. Connection Inference (DeviceManager)

**File:** `cloud/packages/cloud/src/services/session/DeviceManager.ts`

```typescript
async updateDeviceState(payload: Partial<GlassesInfo>): Promise<void> {
  // Infer connection from modelName if not explicit
  if (payload.modelName && payload.connected === undefined) {
    payload.connected = true
    this.logger.debug("Inferred connected=true from modelName")
  } else if (
    (payload.modelName === null || payload.modelName === "") &&
    payload.connected === undefined
  ) {
    payload.connected = false
    this.logger.debug("Inferred connected=false from empty modelName")
  }

  // Check if model changing before merge
  const modelChanged =
    payload.modelName && payload.modelName !== this.deviceState.modelName

  // Merge partial update
  this.deviceState = {
    ...this.deviceState,
    ...payload,
  }

  // Handle connection state changes
  if (payload.connected !== undefined) {
    if (payload.connected && payload.modelName) {
      await this.handleGlassesConnectionState(payload.modelName, "CONNECTED")
    } else {
      await this.handleGlassesConnectionState(null, "DISCONNECTED")
    }
    this.userSession.microphoneManager?.handleConnectionStateChange(
      payload.connected ? "CONNECTED" : "DISCONNECTED"
    )
  } else if (modelChanged && payload.modelName) {
    // Model changed without connection change
    await this.updateModelAndCapabilities(payload.modelName)
  }
}
```

**Key insight:** If mobile sends model name, glasses must be connected. No need for redundant `connected` field.

### 2. REST Endpoint

**File:** `cloud/packages/cloud/src/api/client/device-state.api.ts`

```typescript
async function updateDeviceState(req: Request, res: Response) {
  const _req = req as RequestWithUserSession
  const {userSession} = _req
  const payload = req.body as Partial<GlassesInfo>

  // No validation needed - DeviceManager infers connected from modelName

  try {
    await userSession.deviceManager.updateDeviceState(payload)

    return res.json({
      success: true,
      appliedState: {
        isGlassesConnected: userSession.deviceManager.isGlassesConnected,
        isPhoneConnected: userSession.deviceManager.isPhoneConnected,
        modelName: userSession.deviceManager.getModel(),
        capabilities: userSession.deviceManager.getCapabilities(),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    _req.logger.error({error, feature: "device-state"}, "Failed to update device state")
    return res.status(500).json({
      success: false,
      message: "Failed to update device state",
    })
  }
}
```

**Registered:** `app.use("/api/client/device/state", deviceStateApi)`

### 3. Connection Getters (DeviceManager)

```typescript
get isPhoneConnected(): boolean {
  return this.userSession.websocket?.readyState === 1 // WebSocket.OPEN
}

get isGlassesConnected(): boolean {
  return this.deviceState.connected === true
}
```

**Replaced ambiguous `isConnected()` method** with clear getters specifying what connection we're checking.

### 4. ConnectionValidator Uses New Getters

**File:** `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts`

```typescript
static validateForHardwareRequest(userSession, requestType) {
  // Check phone WebSocket
  if (!userSession.websocket ||
      userSession.websocket.readyState !== WebSocket.OPEN) {
    return { valid: false, error: "Phone WebSocket not open" }
  }

  // Check glasses connection via DeviceManager
  const isGlassesConnected = userSession.deviceManager.isGlassesConnected
  const model = userSession.deviceManager.getModel()

  // HOTFIX: Simulated Glasses treated as connected (no BLE)
  const isSimulated = model === "Simulated Glasses"

  if (!isGlassesConnected && !isSimulated) {
    return {
      valid: false,
      error: "Glasses not connected",
      errorCode: "GLASSES_DISCONNECTED"
    }
  }

  return { valid: true }
}
```

## Data Flow Examples

### Glasses Connect

```
1. Bluetooth pairs
2. Core reports: connected_glasses.model_name = "Mentra Live"
3. Mobile sends: { modelName: "Mentra Live" }
4. Cloud infers: { connected: true, modelName: "Mentra Live" }
5. Cloud updates capabilities: { hasCamera: true, hasDisplay: true, hasWifi: true }
6. Cloud stops incompatible apps
7. Display requests now succeed ✅
```

### WiFi Status Change

```
1. Glasses connect to WiFi
2. Core reports: glasses_wifi_connected = true
3. Mobile sends: { wifiConnected: true, wifiSsid: "Home" }
4. Cloud merges WiFi state (connection state unchanged)
5. Streaming operations allowed ✅
```

### Glasses Disconnect

```
1. Bluetooth disconnects
2. Core reports: connected_glasses = null
3. Mobile sends: { modelName: null }
4. Cloud infers: { connected: false, modelName: null }
5. Cloud analytics: glasses_current_connected = false
6. Display requests rejected with GLASSES_DISCONNECTED ✅
```

## State Management Simplification

### Removed (Cleanup)

**UserSession:**

- ❌ `phoneConnected` boolean (redundant with `websocket.readyState`)
- ❌ `handlePhoneConnectionClosed()` method (just sets flag)
- ❌ `updateGlassesModel()` wrapper (one-line passthrough)

**DeviceManager:**

- ❌ `isConnected()` ambiguous method
- ❌ `capabilities` cached property (always derive from model)

### Added (Clarity)

**DeviceManager:**

- ✅ `isPhoneConnected` getter (checks WebSocket)
- ✅ `isGlassesConnected` getter (checks device state)
- ✅ `updateDeviceState()` unified method (replaces multiple paths)

### Connection State Now Single Source of Truth

**Before:** Multiple scattered state flags

- `userSession.phoneConnected`
- `userSession.glassesConnected`
- `userSession.glassesModel`
- `deviceManager.capabilities`

**After:** DeviceManager owns everything

- `deviceManager.isPhoneConnected` (derived from WebSocket)
- `deviceManager.isGlassesConnected` (from device state)
- `deviceManager.getModel()` (from device state)
- `deviceManager.getCapabilities()` (derived from model)

## Backward Compatibility

### Phase 1: Deployed (Current)

Cloud keeps both paths:

- REST: `/api/client/device/state` ✅ New
- WebSocket: `GLASSES_CONNECTION_STATE` ✅ Legacy

Old mobile: WebSocket (works)
New mobile: REST (works)

### Phase 2: Mobile Deploys REST

Mobile adds REST call, still has WebSocket code:

- Old mobile: WebSocket (works)
- New mobile: REST (works)

### Phase 3: Remove WebSocket Handler

Cloud removes WebSocket handler:

- Old mobile: Breaks (acceptable)
- New mobile: REST (works)

Clean separation: REST for state, WebSocket only for real-time streams.

## Why REST Over WebSocket

| Aspect       | WebSocket          | REST            |
| ------------ | ------------------ | --------------- |
| Confirmation | Fire-and-forget ❌ | HTTP 200 ✅     |
| Retry        | Manual ❌          | Automatic ✅    |
| Semantics    | Event stream       | Explicit update |
| Debugging    | Hard ❌            | HTTP logs ✅    |
| Timing       | Race conditions ❌ | Always works ✅ |
| Backpressure | None ❌            | Built-in ✅     |

**WebSocket:** Good for real-time streams (audio, transcription, button events)
**REST:** Good for state updates (connection, settings, configuration)

Use the right tool for the job.

## Logging & Debugging

### Feature Tag

All logs include `feature: "device-state"` for filtering:

```
feature:"device-state" AND userId:"user@example.com"
```

### Key Log Points

**1. API request received:**

```json
{
  "level": "debug",
  "feature": "device-state",
  "message": "updateDeviceState",
  "deviceStateUpdate": {"modelName": "Mentra Live"}
}
```

**2. Connection inferred:**

```json
{
  "level": "debug",
  "feature": "device-state",
  "message": "Inferred connected=true from modelName",
  "modelName": "Mentra Live"
}
```

**3. State updated:**

```json
{
  "level": "info",
  "feature": "device-state",
  "message": "Device state updated successfully",
  "connected": true,
  "modelName": "Mentra Live",
  "capabilities": {"hasCamera": true}
}
```

**4. Validation check:**

```json
{
  "level": "debug",
  "feature": "device-state",
  "message": "Hardware request validation successful",
  "requestType": "display",
  "glassesModel": "Mentra Live"
}
```

**5. Validation failure:**

```json
{
  "level": "error",
  "feature": "device-state",
  "message": "Hardware request validation failed - glasses not connected",
  "connectionStatus": "WebSocket: OPEN, Phone: Connected, Glasses: Disconnected"
}
```

## Testing

### Manual Test Flow

1. Start cloud with device-state changes
2. Connect glasses via mobile app
3. Check Better Stack: `feature:"device-state" AND message:"Inferred connected"`
4. Verify display requests succeed
5. Disconnect glasses
6. Check Better Stack: `message:"Inferred connected=false"`
7. Verify display requests fail with GLASSES_DISCONNECTED

## Migration Checklist

### Cloud (Done)

- [x] Create `/api/client/device/state` endpoint
- [x] Implement connection inference in DeviceManager
- [x] Add `isPhoneConnected` / `isGlassesConnected` getters
- [x] Remove `phoneConnected` state flag
- [x] Remove redundant wrapper methods
- [x] Update ConnectionValidator to use new getters
- [x] Add feature tag to all logs
- [x] Deploy to production

### Cloud Cleanup (After Mobile Deployed)

- [ ] Remove WebSocket `GLASSES_CONNECTION_STATE` handler
- [ ] Remove `handleGlassesConnectionState()` method (if unused)
- [ ] Remove Simulated Glasses hotfix
- [ ] Archive legacy code documentation
