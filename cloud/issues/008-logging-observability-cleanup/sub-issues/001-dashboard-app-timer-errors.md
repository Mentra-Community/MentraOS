# Sub-Issue 008.1: Dashboard App Timer Errors

**Status**: Open  
**Priority**: Critical (130K+ errors in 6 hours)  
**Component**: `system.augmentos.dashboard` app + SDK

## Problem Statement

The `system.augmentos.dashboard` app is generating **130,685 errors in 6 hours** (~6 errors per second) when users disconnect. This represents **~60% of all cloud errors**.

## Root Cause Analysis

### The Error Chain

1. **Dashboard app has timer-based updates** that run continuously (every ~1 second)
2. **When a user disconnects**, the WebSocket closes but the app's timers keep running
3. **Each timer tick calls `session.sendMessage()`** which throws an error
4. **The SDK catches this error** and logs it at `error` level
5. **The error is logged twice** - once in `app-session` service, once in `app-server` service

### Evidence from Logs

```json
{
  "level": "error",
  "service": "app-session",
  "app": "system.augmentos.dashboard",
  "userId": "henrylane@gmail.com",
  "err": {
    "message": "WebSocket not connected (current state: CLOSED)",
    "stack": "Error: WebSocket not connected...\n    at send (...)\n    at updateSystemSection (...)\n    at setTopLeft (...)\n    at updateDashboardSections (/app/src/index.ts:459:33)"
  },
  "message": "Message send error"
}
```

### Error Volume by User

| User                        | Error Count (6h) |
| --------------------------- | ---------------- |
| `pikulik83@gmail.com`       | 24,980           |
| `josiahwarren256@gmail.com` | 2,480            |
| `ottokar.kueper@gmail.com`  | 2,070            |
| (66 more users...)          | ~101,000         |

## Affected Files

### SDK (already partially fixed in repo, may need deployment)

**File**: `cloud/packages/sdk/src/app/session/index.ts`

The current code already has the fix:

```typescript
if (isDisconnectError) {
  this.logger.debug(error, "Message send skipped - session disconnected")
} else {
  this.logger.error(error, "Message send error")
}
```

**But logs show errors still happening** - suggesting the deployed SDK version doesn't have this fix yet.

### Dashboard App (separate deployment)

**File**: Dashboard app's `src/index.ts` (not in this repo)

The app needs to:

1. Check `session.isConnected` before sending updates
2. Clear all timers on disconnect
3. Handle the `disconnect` event to stop all background tasks

## Fix Options

### Option A: SDK Fix (Recommended - already done, needs deploy)

Ensure the SDK fix is deployed. The fix changes disconnect errors from `error` to `debug` level.

**Pros**:

- Fixes the issue for ALL apps, not just dashboard
- Already implemented in the codebase

**Cons**:

- Masks the underlying issue (timers not being cleaned up)

### Option B: Dashboard App Fix (Should also be done)

Update the dashboard app to properly clean up on disconnect:

```typescript
// In dashboard app initialization:
session.events.on("disconnect", () => {
  // Clear all timers
  clearInterval(updateTimer)
  clearInterval(weatherTimer)
  // etc.
})

// Before each timer update:
function updateDashboardSections() {
  if (!session.isConnected) {
    return // Skip update, user disconnected
  }
  // ... rest of update logic
}
```

**Pros**:

- Fixes the root cause
- Reduces unnecessary CPU/memory usage from running timers

**Cons**:

- Only fixes one app

### Option C: Cloud-side Session Cleanup (Defense in depth)

When the cloud detects an app's WebSocket disconnect, proactively stop the app:

```typescript
// In AppSession when WebSocket closes:
if (this.websocket.readyState === WebSocket.CLOSED) {
  this.stop("user_disconnected")
}
```

**Pros**:

- Prevents any app from continuing after user disconnect

**Cons**:

- May have side effects for apps that want to run briefly after disconnect

## Recommended Solution

**Do all three fixes in order:**

1. **Immediate**: Deploy the SDK fix (already in codebase)
2. **Short-term**: Update dashboard app to clean up timers on disconnect
3. **Medium-term**: Add cloud-side session cleanup as defense in depth

## Metrics to Track

After fix deployment, monitor:

- Error rate for `WebSocket not connected` errors
- Error count for `system.augmentos.dashboard` package
- Per-user error distribution

## Success Criteria

- Dashboard app errors drop by >95%
- Total cloud errors drop by ~60%
- No more than 100 `WebSocket not connected` errors per hour (from real issues only)

## Related Issues

- Issue 007: Resource Lifecycle Cleanup (timers should be tracked)
- Issue 008: Logging & Observability Cleanup (parent issue)
