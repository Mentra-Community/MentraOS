# Sub-Issue 008.3: Unrecognized Message Type Errors

**Status**: Open  
**Priority**: Medium (~1,000 errors in 6 hours)  
**Component**: app-server, tpa-server, SDK

## Problem Statement

Apps are sending `capabilities_update` messages that the server doesn't recognize, generating **1,025 errors in 6 hours**:

- `app-server`: 907 errors
- `tpa-server`: 118 errors

## Root Cause Analysis

### The Error

```json
{
  "level": "error",
  "service": "app-server",
  "err": {
    "message": "Unrecognized message type: capabilities_update"
  }
}
```

### Root Cause Identified

**`capabilities_update` is a `CloudToAppMessageType`, NOT an `AppToCloudMessageType`.**

This message type is defined in the SDK as something the **cloud sends TO apps** (to notify about device capability changes), not something apps should send to the cloud.

```typescript
// In sdk/src/types/message-types.ts
export enum CloudToAppMessageType {
  // ...
  CAPABILITIES_UPDATE = "capabilities_update", // Cloud → App
  // ...
}

// NOT in AppToCloudMessageType - apps should never send this!
```

### Why This Is Happening

Possible scenarios:

1. **App bug**: An app is incorrectly echoing back the capabilities_update message it received
2. **SDK bug**: The SDK is somehow re-sending received messages
3. **Message routing issue**: A message meant for the app is being routed back to the cloud
4. **Old SDK version**: An old SDK version might have incorrectly defined this as bidirectional

## Investigation Needed

### Questions to Answer

1. ~~What is `capabilities_update` supposed to do?~~ ✅ **Answered**: Cloud sends this to apps when device capabilities change
2. ~~Is there a handler that should exist but is missing?~~ ✅ **Answered**: No handler needed - apps should never send this message
3. Which apps are sending this message? **Need to investigate**
4. Why are apps sending a cloud-to-app message type? **Need to investigate**

### Queries to Run

```sql
-- Find which apps are sending capabilities_update
SELECT
  JSONExtract(raw, 'app', 'Nullable(String)') as app,
  JSONExtract(raw, 'packageName', 'Nullable(String)') as packageName,
  JSONExtract(raw, 'userId', 'Nullable(String)') as userId,
  count() as error_count
FROM s3Cluster(primary, t373499_augmentos_s3)
WHERE _row_type = 1
  AND dt >= now() - INTERVAL 6 HOUR
  AND JSONExtract(raw, 'err', 'message', 'Nullable(String)') LIKE '%capabilities_update%'
GROUP BY app, packageName, userId
ORDER BY error_count DESC
LIMIT 20
```

### Code Analysis

The SDK handles incoming `capabilities_update` correctly:

```typescript
// In sdk/src/app/session/index.ts - handleMessage()
// This correctly receives and emits the event
this.events.emit("capabilities_update", {
  capabilities: capabilitiesMessage.capabilities,
  modelName: capabilitiesMessage.modelName,
})
```

The cloud correctly sends this to apps:

```typescript
// In cloud/src/services/session/DeviceManager.ts
const message = {
  type: CloudToAppMessageType.CAPABILITIES_UPDATE,
  capabilities,
  modelName,
}
// Sent to all connected app websockets
```

**The bug is likely in a specific app that's echoing the message back.**

## Fix Options

### Option A: Add Ignore Handler for CloudToApp Messages (Recommended)

Since apps should never send `CloudToAppMessageType` messages, add a check:

```typescript
// In websocket-app.service.ts handleAppMessage()
// Before the switch statement:
const cloudToAppTypes = Object.values(CloudToAppMessageType)
if (cloudToAppTypes.includes(message.type as any)) {
  this.logger.warn(
    {messageType: message.type, packageName: message.packageName},
    "App incorrectly sent a CloudToApp message type - ignoring",
  )
  return
}
```

**Pros**:

- Stops the error spam
- Clearly documents this is a protocol violation
- Helps identify misbehaving apps

**Cons**:

- Masks the underlying app bug

### Option B: Downgrade Unhandled Message to Debug

The current code already logs at `warn` level, but the error comes from somewhere else:

```typescript
// Current in websocket-app.service.ts:
default:
  logger.warn(`Unhandled App message type: ${message.type}`);
  break;
```

The `error` level logs are coming from the SDK's `handleMessage()` function when it doesn't recognize a message. This suggests the error is being logged by an app running the SDK, not the cloud itself.

### Option C: Fix the Offending App(s)

Find which app(s) are sending this message and fix them:

1. Query logs to identify the app
2. Check if the app has a handler that echoes messages
3. Update the app to not send CloudToApp messages back

## Error Details from Logs

### Affected Services

| Service      | Error Count (6h) | Notes                                |
| ------------ | ---------------- | ------------------------------------ |
| `app-server` | 907              | SDK logging in dashboard/system apps |
| `tpa-server` | 118              | SDK logging in third-party apps      |

### Key Insight

The service names `app-server` and `tpa-server` suggest these errors are being logged by the **SDK running inside apps**, not by the cloud server. This means:

1. The cloud is correctly forwarding `capabilities_update` to apps
2. Some apps' SDK instances are then logging an error because they don't recognize the message
3. This could be an **SDK version mismatch** - older SDK versions may not have the handler

### Missing Context

The logs don't include:

- Which app is sending the message
- The message payload
- User context

This makes it hard to debug. We should improve logging for unrecognized messages.

## Recommended Action Plan

### Step 1: Verify SDK Version Handling ✅

The SDK (`sdk/src/app/session/index.ts`) has a handler for `capabilities_update`:

```typescript
case CloudToAppMessageType.CAPABILITIES_UPDATE:
  // ... handles the message correctly
```

So the issue is likely:

- **Old SDK versions** deployed in some apps don't have this handler
- Or **message echo bug** in specific apps

### Step 2: Query to Identify Affected Apps

Run the query above to find which apps are generating these errors.

### Step 3: Short-term Fix

Add better handling in the cloud for apps that incorrectly send CloudToApp messages:

```typescript
// In websocket-app.service.ts, before the switch:
if (message.type === "capabilities_update") {
  this.logger.debug(
    {packageName: message.packageName},
    "Ignoring capabilities_update from app - this is a CloudToApp message type",
  )
  return
}
```

### Step 4: Long-term Fix

1. Identify apps using old SDK versions
2. Require SDK update for those apps
3. Add SDK version tracking to logs for easier debugging

## Files to Investigate

- `cloud/packages/cloud/src/services/websocket/websocket-app.service.ts` - Cloud-side app message handler (add ignore for CloudToApp types)
- `cloud/packages/sdk/src/app/session/index.ts` - SDK message handler (line ~1421 handles capabilities_update)
- `cloud/packages/sdk/src/types/message-types.ts` - Message type definitions
- `cloud/packages/cloud/src/services/session/DeviceManager.ts` - Where capabilities_update is sent from

## Metrics to Track

After fix:

- `Unrecognized message type` errors should drop to zero
- If handler implemented, track `capabilities_update` message volume

## Success Criteria

- No more `Unrecognized message type: capabilities_update` errors
- Clear understanding of what the message does (documented)
- Either proper handler or documented decision to ignore

## Related Issues

- Issue 008: Logging & Observability Cleanup (parent)
- Potential: SDK version compatibility tracking
- Potential: App SDK version requirements enforcement
- DeviceManager sends CAPABILITIES_UPDATE correctly (not a bug there)
