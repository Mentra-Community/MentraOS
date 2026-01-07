# Issue 024: REST API Observability

**Status**: Investigation Complete  
**Priority**: High  
**Related**: Issue 008 (Logging & Observability Cleanup)

## Problem

Cannot filter logs in Better Stack by `userId` to see all REST requests for a user. This makes debugging user-specific issues extremely difficult.

**Current state**: HTTP request logs exist but have no `userId` field.

## Evidence from Better Stack

Query run: 2025-01-05

```sql
SELECT service, countIf(userId != '') AS has_userId, count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY service ORDER BY total DESC
```

| Service | Has userId | Total | Coverage |
|---------|------------|-------|----------|
| hono-http | 0 | 308 | **0%** ❌ |
| client.middleware | 804 | 1728 | 46% |
| app-session | 17522 | 17522 | 100% ✅ |
| TranscriptionManager | 2730 | 2730 | 100% ✅ |
| app-server | 18 | 3114 | 0.6% ❌ |

### Sample HTTP Request Log (Missing userId)

```json
{
  "service": "hono-http",
  "reqId": "e85fc20c2857a5427aade80d97fa5bc8",
  "method": "POST",
  "path": "/api/client/notifications/dismissed",
  "status": 200,
  "duration": 0,
  "clientIp": "173.226.56.14",
  "hasAuth": true,
  "authType": "Bearer"
  // NO userId field!
}
```

### What We Want

```json
{
  "service": "hono-http",
  "reqId": "e85fc20c2857a5427aade80d97fa5bc8",
  "userId": "user@example.com",  // <-- This is missing
  "method": "POST",
  "path": "/api/client/notifications/dismissed",
  "status": 200,
  "duration": 0
}
```

## Root Cause Analysis

### 1. HTTP Logging Runs Before Auth

`hono-app.ts` line 87-159: The request logging middleware logs **after** `await next()` but doesn't capture `userId` from context.

```typescript
app.use(async (c, next) => {
  const start = Date.now();
  // ... capture request details ...
  
  await next();  // Auth middleware runs here, sets c.get("email")
  
  // Logs here but doesn't include c.get("email")!
  const logData = {
    reqId, method, path, status, duration,
    hasAuth,  // Only knows IF auth exists
    // Missing: userId: c.get("email")
  };
});
```

### 2. reqId Not Propagated to Child Loggers

Auth middleware creates child logger but doesn't include `reqId`:

```typescript
// client.middleware.ts line 59
c.set("logger", logger.child({ userId: email }));
// Missing: reqId: c.get("reqId")
```

This means we can't correlate HTTP request logs with handler logs.

### 3. Handlers Use Module-Level Logger

Most API handlers do:

```typescript
const logger = rootLogger.child({ service: "user-settings.api" });
// ...
logger.error(err, `Error fetching settings for user ${email}`);
```

Instead of using `c.get("logger")` which has userId attached.

## Documents

- **[observability-gaps.md](./observability-gaps.md)** - Full investigation findings
- **[implementation-plan.md](./implementation-plan.md)** - Fix plan with code changes

## Quick Context

**Current**: Can see HTTP requests happened, but can't tell who made them.  
**Proposed**: Add `userId` to HTTP logs, propagate `reqId` through all logs.

## Impact

After fixing:

1. `userId:foo@example.com` → All HTTP requests for that user
2. `reqId:abc123` → HTTP request + all handler logs for one request
3. `userId:foo@example.com status:500` → All failed requests for a user

## Key Findings Summary

| Finding | Current State | Impact |
|---------|--------------|--------|
| HTTP logs missing `userId` | 0% coverage | Can't debug user issues |
| `reqId` only in hono-http | No correlation | Can't trace request flow |
| Handlers don't use context logger | userId not in handler logs | Lost context |
| Info-level auth logging | Noisy (1700+ logs/hour) | Should be debug |

## Status

- [x] Investigation complete
- [x] Root cause identified
- [x] Better Stack queries validated findings
- [ ] Implementation
- [ ] Validation in Better Stack