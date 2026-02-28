# Sub-Issue 008.2: Display Validation Errors

**Status**: Open  
**Priority**: High (25K+ errors in 6 hours)  
**Component**: DisplayManager, ConnectionValidator

## Problem Statement

Display validation errors are generating **25,148 errors in 6 hours** when apps attempt to send display requests while glasses are disconnected. These are **expected validation failures being logged at error level**.

## Root Cause Analysis

### Error Breakdown

| Error Code             | Count (6h) | Description            |
| ---------------------- | ---------- | ---------------------- |
| `GLASSES_DISCONNECTED` | 21,450     | Glasses not connected  |
| `WEBSOCKET_CLOSED`     | 3,698      | Phone WebSocket closed |

### The Problem

1. Apps continuously send display requests (especially teleprompter app with ~2 requests/second)
2. When glasses disconnect, the ConnectionValidator correctly rejects these requests
3. **The rejection is logged as an error** even though it's expected behavior
4. One user (`pikulik83@gmail.com`) alone generated **12,223 errors** from `com.augmentos.teleprompter`

### Evidence from Logs

```json
{
  "level": "error",
  "service": "DisplayManager",
  "userId": "pikulik83@gmail.com",
  "errorCode": "GLASSES_DISCONNECTED",
  "error": "Cannot process display request - smart glasses are not connected",
  "connectionStatus": "WebSocket: OPEN, Phone: Connected, Glasses: Disconnected, Model: Even Realities G1",
  "packageName": "com.augmentos.teleprompter",
  "message": "[pikulik83@gmail.com] ❌ Display request validation failed"
}
```

### Pattern Analysis

The teleprompter app for user `pikulik83@gmail.com` is sending **2 display requests per second** continuously even when glasses are disconnected. This ran for over 6 hours, generating:

- ~246 errors per minute
- ~4 errors per second
- Total: 12,223 errors from just one app/user combination

## Affected Files

### ConnectionValidator (Already Fixed in Repo)

**File**: `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts`

The code in the repository **already uses `logger.debug`** instead of `logger.error`:

```typescript
if (!isGlassesConnected && !isSimulatedGlasses) {
  logger.debug(
    {
      userId: userSession.userId,
      requestType,
      glassesModel: model,
      feature: "device-state",
    },
    "Hardware request skipped - glasses not connected",
  )
  // ...
}
```

**But the deployed code is still logging at `error` level** based on log evidence showing the old message: "Hardware request validation failed - glasses not connected"

### DisplayManager6.1.ts (Already Fixed in Repo)

**File**: `cloud/packages/cloud/src/services/layout/DisplayManager6.1.ts`

The code also uses `logger.debug` for validation failures:

```typescript
if (!validation.valid) {
  this.logger.debug(
    {
      errorCode: validation.errorCode,
      packageName: displayRequest.packageName,
      feature: "device-state",
    },
    `[${this.getUserId()}] Display request skipped - ${validation.errorCode}`,
  )
  return false
}
```

## The Real Bug: App Behavior

Beyond the logging issue, there's a **real bug** in the teleprompter app:

1. The app sends display requests at ~2 Hz even when glasses are disconnected
2. This wastes resources and pollutes logs
3. The app should check connection state before sending, or reduce update frequency when disconnected

## Fix Plan

### Phase 1: Deploy Existing Fixes (Immediate)

The codebase already has fixes to downgrade validation errors to `debug`. These need to be deployed:

1. Verify the fixes are in the build
2. Deploy to production
3. Monitor error reduction

### Phase 2: App-Side Fixes (Short-term)

Update apps (especially teleprompter) to check connection state:

```typescript
// Before sending display requests
if (!session.isGlassesConnected()) {
  return // Skip display update when glasses disconnected
}

// Or reduce frequency when disconnected
const updateInterval = session.isGlassesConnected() ? 500 : 5000
```

### Phase 3: Rate Limiting (Medium-term)

Add server-side rate limiting for display requests per user:

```typescript
// In DisplayManager
private displayRequestCounts = new Map<string, number>();

handleDisplayRequest(request) {
  const count = this.displayRequestCounts.get(userId) || 0;
  if (count > 10) { // Max 10 requests per second
    this.logger.debug("Display request rate limited");
    return;
  }
  // ... handle request
}
```

## Validation Errors That Should Stay as Errors

Some validation errors **should** remain at error level:

| Scenario                        | Log Level | Reason                            |
| ------------------------------- | --------- | --------------------------------- |
| Glasses disconnected            | `debug`   | Expected during normal disconnect |
| WebSocket closed                | `debug`   | Expected during normal disconnect |
| Stale connection (>1 min)       | `warn`    | Potential issue to investigate    |
| No UserSession available        | `error`   | Indicates a bug                   |
| WebSocket exists but can't send | `error`   | Unexpected state                  |

## Metrics to Track

After deployment:

- `DisplayManager` errors should drop by >90%
- `GLASSES_DISCONNECTED` errors should drop to near zero
- `WEBSOCKET_CLOSED` errors should drop to near zero

## Success Criteria

- Display validation errors drop from 25K to <500 per 6 hours
- Remaining errors are actual bugs (no UserSession, send failures)
- App-specific error rate limiting is in place

## Related Issues

- Sub-Issue 001: Dashboard app timer errors (same pattern)
- Sub-Issue 003: Hardware validation errors (similar validation pattern)
- Issue 008: Logging & Observability Cleanup (parent)
