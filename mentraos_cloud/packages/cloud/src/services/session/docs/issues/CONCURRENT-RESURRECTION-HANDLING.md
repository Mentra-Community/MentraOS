# Concurrent Resurrection Handling

## The Edge Case

When a TPA connection fails, multiple services might try to send messages simultaneously, each triggering resurrection attempts. Without proper handling, this could cause:

1. **Resurrection Spam**: Multiple webhook calls to the same TPA
2. **Resource Waste**: Duplicate connection attempts and timeouts
3. **Race Conditions**: Conflicting state updates
4. **Poor Logging**: Duplicate error messages

## Our Solution

### **Anti-Spam Protection in startApp()**

**Location**: `AppManager.ts:108-138`

When `startApp()` is called for a TPA that's already loading:

```typescript
// Check if already loading - return existing pending promise
if (this.userSession.loadingApps.has(packageName)) {
  const existing = this.pendingConnections.get(packageName);
  if (existing) {
    // Wait for existing attempt instead of starting new one
    return new Promise<AppStartResult>((resolve) => {
      const checkCompletion = () => {
        if (!this.pendingConnections.has(packageName)) {
          // Check final state and resolve accordingly
          if (this.userSession.runningApps.has(packageName)) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: {...} });
          }
        } else {
          setTimeout(checkCompletion, 100); // Poll every 100ms
        }
      };
      checkCompletion();
    });
  }
}
```

### **How Concurrent Messages Are Handled**

#### **Scenario**: TPA disconnects, then 3 services try to send messages simultaneously

1. **Service A calls `sendMessageToTpa()`**:
   - Detects dead connection
   - Calls `resurrectTpaAndRetry()` → `startApp()`
   - Starts webhook, adds to `loadingApps` and `pendingConnections`

2. **Service B calls `sendMessageToTpa()` (100ms later)**:
   - Detects dead connection  
   - Calls `resurrectTpaAndRetry()` → `startApp()`
   - **Sees app already loading**, waits for existing attempt
   - **No duplicate webhook sent**

3. **Service C calls `sendMessageToTpa()` (200ms later)**:
   - Same as Service B - waits for existing attempt
   - **No duplicate webhook sent**

4. **TPA connects and authenticates**:
   - All 3 services get the same result: `{ success: true }`
   - All 3 services then retry their original messages

### **Key Benefits**

#### **No Webhook Spam**
- Only **one webhook sent** per resurrection attempt
- Additional attempts wait for existing connection
- TPA servers don't get flooded with duplicate requests

#### **Efficient Resource Usage**  
- Only **one timeout timer** per resurrection
- Only **one pending connection** tracked
- No duplicate network calls or database queries

#### **Consistent Results**
- All concurrent callers get the **same result**
- No race conditions between multiple attempts
- Clean state management with single source of truth

#### **Clean Logging**
- Only **one set of resurrection logs** per attempt
- Clear distinction between "starting new attempt" vs "waiting for existing"
- Easy to debug connection issues

## Edge Cases Handled

### **1. TPA Connects During Wait Period**
```
Service A: Starts resurrection
Service B: Waits for Service A's attempt  
TPA: Connects successfully
Service A: Gets { success: true }
Service B: Gets { success: true } (from polling)
Both: Successfully retry their messages
```

### **2. TPA Fails to Connect**
```
Service A: Starts resurrection  
Service B: Waits for Service A's attempt
TPA: Fails to connect (timeout)
Service A: Gets { success: false, error: "TIMEOUT" }
Service B: Gets { success: false, error: "Existing connection attempt failed" }
Both: Handle failure gracefully
```

### **3. Very High Frequency Messages**
```
Multiple audio/transcription messages arrive while resurrection in progress:
- First message triggers resurrection
- Subsequent messages wait (no spam)
- Once connected, all messages flow normally
- AudioManager keeps direct access for performance
```

### **4. Session Cleanup During Resurrection**
```
User session ending while resurrection in progress:
- dispose() clears pendingConnections
- Waiting services get failure results
- No hanging promises or memory leaks
```

## Performance Considerations

### **Polling Interval**
- **100ms polling** for completion checking
- Balance between responsiveness and CPU usage
- Could be optimized with event emitters if needed

### **AudioManager Exception**
- **High-frequency audio** keeps direct websocket access
- Avoids resurrection overhead for real-time streams
- Audio failures handled separately if needed

### **Memory Management**
- **Automatic cleanup** when connections succeed/fail
- **Timeout handling** prevents memory leaks
- **Session disposal** clears all pending operations

## Monitoring and Debugging

### **Key Log Messages**

**Starting New Resurrection**:
```json
{
  "userId": "user123",
  "packageName": "com.example.app", 
  "service": "AppManager",
  "message": "Attempting to resurrect TPA com.example.app"
}
```

**Waiting for Existing Attempt**:
```json
{
  "userId": "user123",
  "packageName": "com.example.app",
  "service": "AppManager", 
  "message": "App com.example.app already loading, waiting for existing attempt"
}
```

**Resurrection Success**:
```json
{
  "userId": "user123",
  "packageName": "com.example.app",
  "service": "AppManager",
  "message": "Successfully resurrected TPA com.example.app"
}
```

### **Metrics to Monitor**
- **Resurrection attempt frequency** per TPA
- **Success rate** of resurrection attempts  
- **Wait times** for concurrent callers
- **Webhook response times** from TPAs

## Future Improvements

### **Event-Based Waiting**
Replace polling with event emitters for better performance:
```typescript
private resurrectionEvents = new EventEmitter();

// Instead of polling, listen for events
this.resurrectionEvents.once(`completed:${packageName}`, (result) => {
  resolve(result);
});
```

### **Resurrection Queue**
For very high traffic, consider queuing messages during resurrection:
```typescript
private messageQueue = new Map<string, Array<{message: any, resolve: Function}>>();
```

### **Circuit Breaker Pattern**
Prevent repeated resurrection attempts for permanently broken TPAs:
```typescript
private failureCount = new Map<string, number>();
private lastFailure = new Map<string, number>();
```

This would temporarily stop resurrection attempts for TPAs that consistently fail.