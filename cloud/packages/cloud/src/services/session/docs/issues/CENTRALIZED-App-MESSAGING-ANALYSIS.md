# Centralized App Messaging Analysis

## Current App WebSocket Message Sending Locations

All of these locations currently use the scattered `userSession.appWebsockets.get(packageName)` + `readyState` check pattern and should be replaced with centralized `appManager.sendMessageToApp()` calls.

### **High Priority - Replace Immediately**

#### **1. Transcription Service**

**File**: `packages/cloud/src/services/processing/transcription.service.ts:488-501`

- **Data**: Transcription/Translation results (JSON)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` + `readyState === 1` check
- **Error Handling**: Logs "App not connected" if websocket unavailable
- **Message Type**: `CloudToAppMessageType.DATA_STREAM`
- **Frequency**: Medium (per speech segment)

#### **2. Video Manager**

**File**: `packages/cloud/src/services/session/UnmanagedStreamingExtension.ts:507-515`

- **Data**: RTMP stream status updates (JSON)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` + `readyState === WebSocket.OPEN` check
- **Error Handling**: Logs "App not connected" if websocket unavailable
- **Message Type**: Video stream status messages
- **Frequency**: Low (status changes only)

#### **3. Photo Manager**

**File**: `packages/cloud/src/services/session/PhotoManager.ts:74-78`

- **Data**: Photo request responses (JSON)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` + `readyState !== WebSocket.OPEN` check
- **Error Handling**: Throws error "App WebSocket is not connected"
- **Message Type**: Photo data messages
- **Frequency**: Low (per photo request)

#### **4. Subscription Service**

**File**: `packages/cloud/src/services/session/subscription.service.ts:233-248`

- **Data**: Permission error messages (JSON)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` + `readyState === 1` check
- **Error Handling**: Silent failure if websocket unavailable
- **Message Type**: Permission error notifications
- **Frequency**: Low (subscription changes only)

#### **5. User Data Routes**

**File**: `packages/cloud/src/routes/user-data.routes.ts:39-43`

- **Data**: Custom user data messages (JSON)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` + `readyState === 1` check
- **Error Handling**: Silent failure if websocket unavailable
- **Message Type**: Custom data messages
- **Frequency**: Low (API calls only)

#### **6. App Settings Routes**

**File**: `packages/cloud/src/routes/app-settings.routes.ts:292-297`

- **Data**: Settings update notifications (JSON)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` check only
- **Error Handling**: Returns 404 HTTP error if websocket not found
- **Message Type**: Settings change notifications
- **Frequency**: Low (settings changes only)

#### **7. AppManager Dispose**

**File**: `packages/cloud/src/services/session/AppManager.ts:752-762`

- **Data**: App stopped notifications (JSON)
- **Current Pattern**: `userSession.appWebsockets` iteration + `readyState === WebSocket.OPEN` check
- **Error Handling**: Logs error on send failure
- **Message Type**: `CloudToAppMessageType.APP_STOPPED`
- **Frequency**: Very low (session cleanup only)

### **Special Case - Keep Direct Access for Performance**

#### **8. Audio Manager**

**File**: `packages/cloud/src/services/session/AudioManager.ts:369-376`

- **Data**: Raw audio data (binary chunks)
- **Current Pattern**: `userSession.appWebsockets.get(packageName)` + `readyState === WebSocket.OPEN` check
- **Error Handling**: Logs "Error sending audio to {packageName}" on failure
- **Message Type**: Raw binary audio data (not JSON)
- **Frequency**: **VERY HIGH** (continuous audio stream)
- **Special Consideration**: Keep direct websocket access for performance - audio latency is critical

## Issues with Current Implementation

### **1. Inconsistent Error Handling**

- Some services throw errors (PhotoManager)
- Some log errors (TranscriptionService, UnmanagedStreamingExtension)
- Some fail silently (SubscriptionService, UserDataRoutes)
- HTTP routes return different status codes

### **2. No Resurrection Logic**

- All services just fail when websocket unavailable
- No attempt to restart failed Apps
- Users see broken functionality with no recovery

### **3. Duplicate Code Patterns**

- Same `appWebsockets.get() + readyState` check everywhere
- Inconsistent readyState values (1 vs WebSocket.OPEN)
- Duplicate error logging patterns

### **4. No Centralized Connection Health**

- Each service checks connection health independently
- No unified view of App connection status
- Hard to debug connection issues across services

## Proposed Centralized Solution

### **AppManager.sendMessageToApp() Method**

```typescript
async sendMessageToApp(packageName: string, message: any): Promise<{
  sent: boolean;
  resurrectionTriggered: boolean;
  error?: string;
}> {
  // 1. Check websocket health
  // 2. If healthy → send message
  // 3. If dead → trigger resurrection
  // 4. If resurrection successful → retry send
  // 5. Return detailed result
}
```

### **Benefits of Centralization**

1. **Unified Error Handling**: Consistent behavior across all services
2. **Automatic Resurrection**: Dead Apps automatically restarted
3. **Better Logging**: Centralized connection health tracking
4. **Easier Debugging**: Single point of failure analysis
5. **Code Reduction**: Eliminate duplicate patterns

### **AudioManager Exception**

- Keep direct websocket access for performance
- Audio chunks need minimal latency
- High frequency makes resurrection impractical
- Can add optional centralized audio health checks separately

## Implementation Plan

### **Phase 1: Core Infrastructure**

1. ✅ Add `sendMessageToApp()` method to AppManager
2. Add resurrection logic with new Promise-based `startApp()`
3. Add comprehensive error handling and logging

### **Phase 2: Replace JSON Message Sending**

1. Replace TranscriptionService App messaging
2. Replace UnmanagedStreamingExtension App messaging
3. Replace PhotoManager App messaging
4. Replace SubscriptionService App messaging
5. Replace route-based App messaging
6. Update AppManager dispose method

### **Phase 3: Testing and Validation**

1. Test resurrection scenarios
2. Verify error handling consistency
3. Monitor performance impact
4. Add metrics for connection health

### **Phase 4: AudioManager Optimization (Future)**

1. Consider separate audio health monitoring
2. Evaluate async audio resurrection
3. Add audio-specific connection recovery

## Expected Outcomes

### **Immediate Benefits**

- Broken Apps automatically restart
- Consistent error handling across services
- Better debugging with centralized logging
- Reduced code duplication

### **Long-term Benefits**

- More reliable App connections
- Easier maintenance and updates
- Better user experience with fewer failures
- Simplified troubleshooting for support team
