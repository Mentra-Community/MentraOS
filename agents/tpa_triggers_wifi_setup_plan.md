# TPA-Triggered WiFi Setup Plan

## Problem Statement

Mentra Live glasses need WiFi for operations like RTMP streaming, but when users try to stream without WiFi, it just fails silently. There's no clear path to guide users to WiFi setup.

**Current Issue**: TPA calls `startStream()` → fails with no WiFi → user confused.

**Desired Flow**: TPA calls `startStream()` → fails with WiFi error → TPA triggers WiFi setup → user sets up WiFi → TPA retries stream → success.

---

## Solution Overview

**TPA-Controlled WiFi Setup** (not automatic):

- Cloud validates WiFi before streaming operations
- Returns structured error code: `WIFI_NOT_CONNECTED`
- TPA handles error and calls `session.requestWifiSetup()`
- Mobile app shows native alert with WiFi setup flow
- TPA listens for WiFi reconnection and retries operation

**Why TPA-controlled?**

- Follows existing permission model pattern
- Gives TPAs UX control (when to interrupt user)
- Prevents surprise interruptions
- Better for debugging

---

## Architecture Overview

### Current WiFi Tracking

**Mobile App** already tracks glasses WiFi status from Core:

```typescript
interface GlassesInfo {
  glasses_wifi_connected?: boolean
  glasses_wifi_ssid?: string | null
  glasses_wifi_local_ip?: string
}
```

**Cloud** receives `GLASSES_CONNECTION_STATE` from mobile:

```typescript
export interface GlassesConnectionState extends BaseMessage {
  type: GlassesToCloudMessageType.GLASSES_CONNECTION_STATE
  modelName: string
  status: string // "CONNECTED" or "DISCONNECTED"
}
```

**TPAs** can already subscribe to `GLASSES_CONNECTION_STATE` to know when glasses connect/disconnect.

### What's Missing

1. ❌ WiFi info not included in `GLASSES_CONNECTION_STATE` message
2. ❌ No WiFi validation before streaming operations
3. ❌ No way for TPA to trigger WiFi setup on mobile app

---

## Implementation Plan

### 1. Add WiFi Info to GLASSES_CONNECTION_STATE

#### 1.1: Extend the message type (SDK)

**File**: `cloud/packages/sdk/src/types/messages/glasses-to-cloud.ts`

```typescript
export interface GlassesConnectionState extends BaseMessage {
  type: GlassesToCloudMessageType.GLASSES_CONNECTION_STATE
  modelName: string
  status: string // "CONNECTED" or "DISCONNECTED"

  // NEW - optional WiFi details
  wifi?: {
    connected: boolean
    ssid?: string | null
  }
}
```

**Why optional?**

- Not all glasses have WiFi (e.g., Even Realities G1)
- Backwards compatible with existing TPAs

#### 1.2: Send WiFi info from mobile app

**File**: `mobile/src/services/SocketComms.ts`

Update the `sendGlassesConnectionState` method (line 138):

```typescript
sendGlassesConnectionState(connected: boolean): void {
  const modelName = useSettingsStore.getState().getSetting(SETTINGS_KEYS.default_wearable)
  const glassesInfo = useCoreStatus.getState().status.glasses_info

  this.ws.sendText(
    JSON.stringify({
      type: "glasses_connection_state",
      modelName: modelName,
      status: connected ? "CONNECTED" : "DISCONNECTED",
      timestamp: new Date(),
      // NEW - WiFi info (only if available)
      wifi: glassesInfo?.glasses_wifi_connected !== undefined ? {
        connected: glassesInfo.glasses_wifi_connected,
        ssid: glassesInfo.glasses_wifi_ssid || null,
      } : undefined,
    }),
  )
}
```

**Note**: Also need to send WiFi updates when WiFi state changes (not just when glasses connect/disconnect). Listen to Core's WiFi status change events and call this method.

#### 1.3: Add SDK helper methods

**File**: `cloud/packages/sdk/src/app/session/index.ts`

Add to `AppSession` class:

```typescript
/** Track latest glasses connection state including WiFi */
private glassesConnectionState: GlassesConnectionState | null = null;

/**
 * Get current WiFi status of glasses
 * Returns null if glasses don't support WiFi or state not yet received
 */
getWifiStatus(): { connected: boolean; ssid?: string | null } | null {
  if (!this.capabilities?.hasWifi) {
    return null; // Glasses don't support WiFi
  }

  return this.glassesConnectionState?.wifi || null;
}

/**
 * Check if glasses are connected to WiFi
 */
isWifiConnected(): boolean {
  return this.getWifiStatus()?.connected === true;
}
```

Update the message handler to store connection state:

```typescript
// In handleMessage, where GLASSES_CONNECTION_STATE is handled:
else if (isDataStream(message) && message.streamType === StreamType.GLASSES_CONNECTION_STATE) {
  const stateUpdate = message.data as GlassesConnectionState;

  // Store latest state
  this.glassesConnectionState = stateUpdate;

  // Emit existing event (for backwards compatibility)
  this.events.emit('glasses_connection_state', stateUpdate);
}
```

---

### 2. Add WiFi Validation Before Streaming

#### 2.1: Extend ConnectionErrorCode enum

**File**: `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts`

```typescript
export enum ConnectionErrorCode {
  PHONE_DISCONNECTED = "PHONE_DISCONNECTED",
  GLASSES_DISCONNECTED = "GLASSES_DISCONNECTED",
  STALE_CONNECTION = "STALE_CONNECTION",
  WEBSOCKET_CLOSED = "WEBSOCKET_CLOSED",
  WIFI_NOT_CONNECTED = "WIFI_NOT_CONNECTED", // NEW
}
```

#### 2.2: Add WiFi validation method

**File**: `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts`

```typescript
/**
 * Validate WiFi connection for operations that require internet
 * (e.g., RTMP streaming for Mentra Live glasses)
 */
static validateWifiForOperation(
  userSession: UserSession,
): ValidationResult {
  if (!ConnectionValidator.VALIDATION_ENABLED) {
    return { valid: true };
  }

  // Check if glasses have WiFi capability using DeviceManager
  const capabilities = userSession.deviceManager.getCapabilities();
  const requiresWifi = capabilities?.hasWifi === true;

  if (!requiresWifi) {
    // Model doesn't need WiFi (e.g., BLE-only glasses)
    logger.debug(
      {
        userId: userSession.userId,
        glassesModel: userSession.deviceManager.getCurrentModel(),
        hasWifi: capabilities?.hasWifi,
      },
      "Glasses don't have WiFi capability - skipping WiFi validation"
    );
    return { valid: true };
  }

  // Get WiFi status from latest GLASSES_CONNECTION_STATE message
  // This requires UserSession to store the latest glassesConnectionState
  const glassesState = userSession.lastGlassesConnectionState;

  if (!glassesState?.wifi?.connected) {
    logger.error(
      {
        userId: userSession.userId,
        glassesModel: userSession.deviceManager.getCurrentModel(),
        wifiState: glassesState?.wifi,
      },
      "Operation requires WiFi but glasses are not connected to WiFi"
    );

    return {
      valid: false,
      error: `Cannot process request - smart glasses must be connected to WiFi for this operation`,
      errorCode: ConnectionErrorCode.WIFI_NOT_CONNECTED,
    };
  }

  logger.debug(
    {
      userId: userSession.userId,
      wifiSsid: glassesState.wifi.ssid,
    },
    "WiFi validation successful"
  );

  return { valid: true };
}
```

#### 2.3: Store GLASSES_CONNECTION_STATE on UserSession

**File**: `cloud/packages/cloud/src/services/session/UserSession.ts`

Add property:

```typescript
/** Latest glasses connection state including WiFi info */
public lastGlassesConnectionState: GlassesConnectionState | null = null;
```

**File**: `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts`

Update handler to store state:

```typescript
case GlassesToCloudMessageType.GLASSES_CONNECTION_STATE:
  await this.handleGlassesConnectionState(userSession, message as GlassesConnectionState);

  // Store latest state for validation
  userSession.lastGlassesConnectionState = message as GlassesConnectionState;
  break;
```

#### 2.4: Use WiFi validation in streaming extensions

**File**: `cloud/packages/cloud/src/services/session/UnmanagedStreamingExtension.ts`

In `startRtmpStream` method, after existing connection validation (around line 103):

```typescript
// Existing validation
const validation = ConnectionValidator.validateForHardwareRequest(this.userSession, "stream")
if (!validation.valid) {
  // ... existing error handling
}

// NEW - WiFi validation
const wifiValidation = ConnectionValidator.validateWifiForOperation(this.userSession)
if (!wifiValidation.valid) {
  this.logger.error(
    {
      userId: this.userSession.userId,
      packageName,
      error: wifiValidation.error,
      errorCode: wifiValidation.errorCode,
      glassesModel: this.userSession.deviceManager.getCurrentModel(),
    },
    "RTMP stream request blocked - WiFi validation failed",
  )

  // Throw error with WiFi-specific code
  const error = new Error(wifiValidation.error || "WiFi connection required for streaming")
  ;(error as any).code = wifiValidation.errorCode
  throw error
}
```

**File**: `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`

Same validation in `startManagedStream` method (around line 100).

#### 2.5: Handle WiFi errors in websocket-app.service

**File**: `cloud/packages/cloud/src/services/websocket/websocket-app.service.ts`

Update RTMP_STREAM_REQUEST error handler (around line 360-372):

```typescript
case AppToCloudMessageType.RTMP_STREAM_REQUEST:
  try {
    const rtmpRequestMsg = message as RtmpStreamRequest;

    // Check camera permission
    const hasCameraPermission = await this.checkCameraPermission(
      rtmpRequestMsg.packageName,
      userSession,
    );
    if (!hasCameraPermission) {
      this.sendError(
        appWebsocket,
        AppErrorCode.PERMISSION_DENIED,
        "Camera permission required to start video streams.",
      );
      break;
    }

    // Start stream
    const streamId = await userSession.unmanagedStreamingExtension.startRtmpStream(
      rtmpRequestMsg,
    );
    this.logger.info({ streamId, packageName: rtmpRequestMsg.packageName }, "RTMP Stream started");

  } catch (e) {
    const errorMessage = (e as Error).message || "Failed to start stream.";
    const errorCode = (e as any).code;

    // Check if this is a WiFi error (from cloud or asg_client)
    const isWifiError = errorCode === "WIFI_NOT_CONNECTED" ||
                        errorMessage === "no_wifi_connection"; // from asg_client

    this.logger
      .child({
        packageName: message.packageName,
        isWifiError,
        errorCode,
        originalMessage: errorMessage
      })
      .error(e, "Error starting RTMP stream");

    // Map asg_client error to our error code
    let finalErrorCode = errorCode;
    if (errorMessage === "no_wifi_connection") {
      finalErrorCode = "WIFI_NOT_CONNECTED";
    }

    // Send error with WiFi-specific code if applicable
    this.sendError(
      appWebsocket,
      isWifiError ? (finalErrorCode || "WIFI_NOT_CONNECTED") : AppErrorCode.INTERNAL_ERROR,
      errorMessage,
    );
  }
  break;
```

---

### 3. Add TPA WiFi Setup Trigger

#### 3.1: Add message type for WiFi setup request

**File**: `cloud/packages/sdk/src/types/messages/app-to-cloud.ts`

```typescript
export enum AppToCloudMessageType {
  // ... existing types
  REQUEST_WIFI_SETUP = "request_wifi_setup",
}

/**
 * Request from App to show WiFi setup flow on mobile app
 */
export interface RequestWifiSetup extends BaseMessage {
  type: AppToCloudMessageType.REQUEST_WIFI_SETUP
  packageName: string
  sessionId: string
  reason?: string // Optional explanation for user
}
```

Add to union type:

```typescript
export type AppToCloudMessage =
  | AppConnectionInit
  | AppSubscriptionUpdate
  // ... existing types
  | RequestWifiSetup
```

#### 3.2: Add message type for mobile app

**File**: `cloud/packages/sdk/src/types/message-types.ts`

Mobile receives messages via `CloudToGlassesMessageType`:

```typescript
export enum CloudToGlassesMessageType {
  // ... existing types
  SHOW_WIFI_SETUP = "show_wifi_setup",
}
```

**File**: `cloud/packages/sdk/src/types/messages/cloud-to-glasses.ts`

```typescript
/**
 * Instruction from cloud to mobile app to show WiFi setup flow
 */
export interface ShowWifiSetup extends BaseMessage {
  type: CloudToGlassesMessageType.SHOW_WIFI_SETUP
  reason?: string // Why WiFi setup is needed
  appPackageName?: string // Which app requested it
}
```

Add to union type:

```typescript
export type CloudToGlassesMessage =
  | ConnectionAck
  | ConnectionError
  // ... existing types
  | ShowWifiSetup
```

#### 3.3: Handle WiFi setup request in cloud

**File**: `cloud/packages/cloud/src/services/websocket/websocket-app.service.ts`

Add case to message handler:

```typescript
case AppToCloudMessageType.REQUEST_WIFI_SETUP:
  try {
    const setupRequest = message as RequestWifiSetup;

    this.logger.info(
      {
        packageName: setupRequest.packageName,
        userId: userSession.userId,
        reason: setupRequest.reason,
      },
      "App requesting WiFi setup flow"
    );

    // Forward to mobile app via phone WebSocket
    if (userSession.websocket?.readyState === WebSocket.OPEN) {
      const mobileMessage: ShowWifiSetup = {
        type: CloudToGlassesMessageType.SHOW_WIFI_SETUP,
        reason: setupRequest.reason,
        appPackageName: setupRequest.packageName,
      };

      userSession.websocket.send(JSON.stringify(mobileMessage));

      this.logger.info(
        { packageName: setupRequest.packageName },
        "WiFi setup request forwarded to mobile app"
      );

    } else {
      this.logger.error(
        {
          packageName: setupRequest.packageName,
          userId: userSession.userId,
          wsReadyState: userSession.websocket?.readyState,
        },
        "Cannot forward WiFi setup request - phone WebSocket not open"
      );

      this.sendError(
        appWebsocket,
        AppErrorCode.INTERNAL_ERROR,
        "Cannot show WiFi setup - phone not connected"
      );
    }
  } catch (e) {
    this.logger.error(e, "Error handling WiFi setup request");
    this.sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      "Failed to process WiFi setup request"
    );
  }
  break;
```

#### 3.4: Handle WiFi setup in mobile app

**File**: `mobile/src/services/SocketComms.ts`

Messages are handled in `handle_message` method (line 529).

Add to switch statement:

```typescript
case "show_wifi_setup":
  this.handle_show_wifi_setup(msg);
  break;
```

Add handler method to the `SocketComms` class:

```typescript
import { showAlert } from '@/utils/AlertUtils';
import { router } from 'expo-router';

private handle_show_wifi_setup(msg: any) {
  console.log('SOCKET: show_wifi_setup requested:', msg);

  const reason = msg.reason || "This operation requires your glasses to be connected to WiFi.";
  const appPackageName = msg.appPackageName;

  // Get current route to return to after WiFi setup
  // TODO: Implement getCurrentRoute() if it doesn't exist
  const currentRoute = router.pathname || '/';

  showAlert(
    "WiFi Setup Required",
    reason,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Setup WiFi",
        onPress: () => {
          // Navigate to WiFi setup with returnTo parameter
          const returnTo = encodeURIComponent(currentRoute);
          router.push(`/pairing/glasseswifisetup?returnTo=${returnTo}`);
        }
      }
    ],
    {
      iconName: "wifi-off",
      iconColor: "#FF9500"
    }
  );
}
```

#### 3.5: Update WiFi setup flow for return navigation

The WiFi setup screens need to support returning to the original location after setup completes.

**Files to modify**:

- `/mobile/src/app/pairing/glasseswifisetup.tsx`
- `/mobile/src/app/pairing/glasseswifisetup/scan.tsx`
- `/mobile/src/app/pairing/glasseswifisetup/password.tsx`
- `/mobile/src/app/pairing/glasseswifisetup/connecting.tsx`

**Main WiFi setup screen** (`glasseswifisetup.tsx`):

```typescript
import {useLocalSearchParams} from "expo-router"

export default function GlassesWifiSetupScreen() {
  const {deviceModel = "Glasses", returnTo} = useLocalSearchParams()
  const {push, goBack, replace} = useNavigationHistory()

  const handleGoBack = useCallback(() => {
    if (returnTo && typeof returnTo === "string") {
      // Return to the route that triggered WiFi setup
      replace(returnTo)
    } else {
      // Default behavior
      goBack()
    }
    return true
  }, [returnTo])

  // Pass returnTo to child screens
  const handleScanForNetworks = () => {
    push("/pairing/glasseswifisetup/scan", {deviceModel, returnTo})
  }

  const handleManualEntry = () => {
    push("/pairing/glasseswifisetup/password", {deviceModel, ssid: "", returnTo})
  }
}
```

**Connecting screen** (`glasseswifisetup/connecting.tsx`):

When WiFi connection succeeds:

```typescript
const {returnTo} = useLocalSearchParams()

// On successful connection
const handleConnectionSuccess = () => {
  if (returnTo && typeof returnTo === "string") {
    // Return to the route that triggered WiFi setup
    router.replace(returnTo)
  } else {
    // Default: go to glasses screen
    router.replace("/(tabs)/glasses")
  }
}
```

#### 3.6: Add SDK convenience method

**File**: `cloud/packages/sdk/src/app/session/index.ts`

Add to `AppSession` class:

````typescript
/**
 * Request mobile app to show WiFi setup flow
 *
 * This triggers a native popup on the user's phone asking them to
 * configure WiFi for their smart glasses.
 *
 * Returns immediately - does not wait for user to complete setup.
 * Listen to GLASSES_CONNECTION_STATE events to detect when WiFi is connected.
 *
 * @param reason Optional explanation shown to user (e.g., "Required for streaming")
 *
 * @throws Error if session is not connected or glasses don't support WiFi
 *
 * @example
 * ```typescript
 * try {
 *   await session.camera.startStream({ rtmpUrl: '...' });
 * } catch (error) {
 *   if (error.code === 'WIFI_NOT_CONNECTED') {
 *     session.requestWifiSetup("Streaming requires WiFi connection");
 *
 *     // Listen for WiFi reconnection
 *     session.onGlassesConnectionState((state) => {
 *       if (state.wifi?.connected) {
 *         // Retry streaming
 *       }
 *     });
 *   }
 * }
 * ```
 */
requestWifiSetup(reason?: string): void {
  if (!this.isConnected()) {
    throw new Error("Cannot request WiFi setup - session not connected");
  }

  if (!this.capabilities?.hasWifi) {
    this.logger.warn("WiFi setup requested but glasses don't support WiFi");
    throw new Error(
      "Cannot request WiFi setup - glasses do not support WiFi"
    );
  }

  const message: RequestWifiSetup = {
    type: AppToCloudMessageType.REQUEST_WIFI_SETUP,
    packageName: this.config.packageName,
    sessionId: this.sessionId!,
    reason,
  };

  this.send(message);

  this.logger.info({ reason }, "Requested mobile app to show WiFi setup");
}

/**
 * Listen for glasses connection state changes (includes WiFi status)
 *
 * Must subscribe to GLASSES_CONNECTION_STATE stream first:
 * ```typescript
 * await session.subscribe([StreamType.GLASSES_CONNECTION_STATE]);
 * ```
 */
onGlassesConnectionState(
  handler: (state: GlassesConnectionState) => void
): () => void {
  return this.events.on('glasses_connection_state', handler);
}
````

---

## Developer Experience

### Example 1: Automatic WiFi Setup on Error

```typescript
const session = new AppSession({
  packageName: "com.example.rtmp-streamer",
  apiKey: "your-key",
  userId: "user@example.com",
  appServer: myAppServer,
})

await session.connect("session-123")

// Subscribe to connection state updates
await session.subscribe([StreamType.GLASSES_CONNECTION_STATE])

// Check WiFi capability
if (!session.capabilities?.hasWifi) {
  console.log("These glasses don't support WiFi - streaming not available")
  return
}

// Try to start stream
try {
  await session.camera.startStream({
    rtmpUrl: "rtmp://live.twitch.tv/app/stream-key",
    video: {width: 1280, height: 720, bitrate: 1500000},
  })

  console.log("Stream started successfully!")
} catch (error) {
  if (error.code === "WIFI_NOT_CONNECTED") {
    // Trigger WiFi setup
    session.requestWifiSetup("RTMP streaming requires your glasses to be connected to WiFi")

    // Listen for WiFi reconnection
    const unsubscribe = session.onGlassesConnectionState((state) => {
      if (state.wifi?.connected) {
        console.log("WiFi connected! Retrying stream...")
        unsubscribe()

        // Retry streaming
        session.camera
          .startStream({
            rtmpUrl: "rtmp://live.twitch.tv/app/stream-key",
            video: {width: 1280, height: 720},
          })
          .catch((err) => console.error("Retry failed:", err))
      }
    })
  } else {
    console.error("Stream failed:", error)
  }
}
```

### Example 2: Pre-flight Check

```typescript
const session = new AppSession({
  packageName: "com.example.streaming-app",
  apiKey: "your-key",
  userId: "user@example.com",
  appServer: myAppServer,
})

await session.connect("session-123")
await session.subscribe([StreamType.GLASSES_CONNECTION_STATE])

// Track WiFi state
let wifiConnected = session.getWifiStatus()?.connected || false

session.onGlassesConnectionState((state) => {
  wifiConnected = state.wifi?.connected || false
  updateUI({wifiConnected})
})

// On user clicking "Start Stream"
async function handleStartStream() {
  // Pre-flight check
  if (session.capabilities?.hasWifi && !wifiConnected) {
    const userWantsSetup = await showConfirmDialog({
      title: "WiFi Required",
      message: "Live streaming requires WiFi. Set up WiFi now?",
    })

    if (userWantsSetup) {
      session.requestWifiSetup("Required for RTMP streaming")
      return // Don't proceed - user will retry after setup
    } else {
      return // User canceled
    }
  }

  // Proceed with streaming
  try {
    await session.camera.startStream({
      rtmpUrl: getRtmpUrl(),
      video: getVideoSettings(),
    })
    showSuccess("Stream started!")
  } catch (error) {
    showError("Failed to start stream: " + error.message)
  }
}
```

---

## Testing Plan

### Unit Tests

1. **WiFi validation in ConnectionValidator**:
   - WiFi-capable glasses (Mentra Live) without WiFi → fail
   - WiFi-capable glasses with WiFi → pass
   - Non-WiFi glasses (Even G1) → pass (skip validation)
   - Validation disabled flag → always pass

2. **Message type extensions**:
   - GLASSES_CONNECTION_STATE with WiFi fields
   - GLASSES_CONNECTION_STATE without WiFi fields (backwards compat)
   - REQUEST_WIFI_SETUP message parsing
   - SHOW_WIFI_SETUP message parsing

3. **SDK methods**:
   - `getWifiStatus()` with/without WiFi capability
   - `isWifiConnected()` with various states
   - `requestWifiSetup()` when not connected → throws error

### Integration Tests

1. **WiFi validation in streaming**:
   - Start RTMP stream with WiFi → success
   - Start RTMP stream without WiFi → `WIFI_NOT_CONNECTED` error
   - Start managed stream without WiFi → `WIFI_NOT_CONNECTED` error

2. **WiFi setup flow**:
   - TPA calls `requestWifiSetup()`
   - Mobile app receives SHOW_WIFI_SETUP
   - Alert shows with custom reason
   - Navigate to WiFi setup
   - Return to original route after setup

3. **End-to-end**:
   - Disconnect WiFi
   - TPA attempts stream → fails
   - TPA requests WiFi setup
   - User completes WiFi setup
   - TPA retries stream → success

### Manual Testing

- [ ] Mentra Live - stream without WiFi shows error
- [ ] Error code is `WIFI_NOT_CONNECTED`
- [ ] `requestWifiSetup()` shows mobile alert
- [ ] Alert uses custom reason text
- [ ] WiFi setup navigates to correct screen
- [ ] After WiFi setup, returns to TPA webview (not home)
- [ ] Even G1 - streaming works without WiFi check
- [ ] `getWifiStatus()` returns null for Even G1
- [ ] `GLASSES_CONNECTION_STATE` includes WiFi for Mentra Live
- [ ] asg_client `"no_wifi_connection"` error is mapped correctly

---

## Benefits

### For TPA Developers

- ✅ Clear error codes (`WIFI_NOT_CONNECTED`)
- ✅ Simple API: `requestWifiSetup()`
- ✅ Control over UX (when to show WiFi setup)
- ✅ Real-time WiFi status via existing subscription
- ✅ Pre-flight checks with `getWifiStatus()`

### For Users

- ✅ Guided experience (clear prompts when WiFi needed)
- ✅ Contextual help (TPA explains why WiFi required)
- ✅ No surprise interruptions (only shown when user takes action)
- ✅ Returns to app after setup (preserves context)

### For Platform

- ✅ Consistent with permission model
- ✅ Backwards compatible (optional fields)
- ✅ Uses existing GLASSES_CONNECTION_STATE (no new message type)
- ✅ Structured errors (not string parsing)
- ✅ Scalable to other WiFi-dependent operations

---

## Future Enhancements

1. **Add `hasInternet` field** to WiFi status (once we can determine this)
2. **Bandwidth requirements** - validate minimum WiFi speed for streaming
3. **Offline mode detection** - warn if WiFi has no internet
4. **WiFi quality metrics** - signal strength, latency
5. **Auto-retry on WiFi reconnect** - SDK-level convenience helper
