# Sub-Issue 008.8: No Active Session Warnings

**Status**: Open  
**Priority**: Medium (~2.6K warnings/hr)  
**Component**: client.middleware.ts, mobile REST polling

## Problem

Mobile clients continue polling REST APIs after WebSocket session disconnects, generating "No active session found" warnings.

## Error Volume

~2,621 warnings per hour. Top offenders:

- `alex.henson.official@gmail.com`: 1,561/hr (~26/min for over an hour)
- `parth@mentraglass.com`: 261/hr

## Affected Endpoints

All endpoints using `clientAuthWithUserSession` middleware:

- `/api/client/location`
- `/api/client/device/state`
- `/api/client/calendar`
- `/api/client/notifications`

## Root Cause

1. **UserSession lifecycle**: WebSocket disconnects → 60s grace period → UserSession disposed
2. **Mobile behavior**: Background tasks (location updates, calendar sync) keep running after WebSocket dies
3. **Result**: APIs return 401, logged as warning, but mobile keeps trying

### Why Mobile Doesn't Stop

- Background location task runs independently of WebSocket state
- Mobile may not properly handle 401 responses to stop polling
- Mobile app may be backgrounded/suspended but background tasks continue

## Current Behavior

**Middleware** (client.middleware.ts:132-135):

```typescript
if (!userSession) {
  logger.warn(`requireUserSession: No active session found for user: ${userReq.email}`);
  return res.status(401).json({ error: "No active session found" });
}
```

**Problems**:

1. Log doesn't include endpoint URL (hard to debug which API is being hit)
2. Response lacks actionable guidance for client
3. No error code for programmatic handling

## Proposed Fix

### 1. Improve Logging

Add endpoint context to the warning:

```typescript
if (!userSession) {
  logger.warn(
    {
      userId: userReq.email,
      endpoint: req.originalUrl,
      method: req.method,
    },
    "No active session - client should reconnect WebSocket",
  );

  return res.status(401).json({
    error: "No active session found",
    code: "NO_ACTIVE_SESSION",
    message: "WebSocket connection required. Please reconnect.",
    success: false,
  });
}
```

### 2. Response Format

Keep backwards compatible - existing `error` field stays, add optional fields:

```json
{
  "error": "No active session found",
  "code": "NO_ACTIVE_SESSION",
  "message": "WebSocket connection required. Please reconnect.",
  "success": false
}
```

Mobile ignores fields it doesn't understand, so this is non-breaking.

## Architecture Questions

1. **Should these endpoints require UserSession at all?**
   - Location/calendar/notifications are data updates
   - Could potentially be stored without active session
   - But without session, there's nowhere to route the data

2. **Should mobile stop polling on 401?**
   - Background tasks should check response codes
   - Or check WebSocket state before making requests

3. **Should we track this pattern?**
   - Useful for identifying mobile bugs or connection issues
   - Warning level is appropriate (not error, but worth noting)

## Files to Modify

- `cloud/packages/cloud/src/api/middleware/client.middleware.ts` - Improve logging and response

## Mobile Team Notes

- Background tasks should check WebSocket connection state before making REST calls
- Or handle 401 responses by stopping the polling loop
- Investigate why `alex.henson.official@gmail.com` was polling for 1+ hour without session

## Success Criteria

- Warnings include endpoint context for debugging
- Response gives mobile actionable information
- Mobile team has info to fix client-side behavior
