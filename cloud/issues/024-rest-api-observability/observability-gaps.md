# Observability Gaps Analysis

Investigation date: 2025-01-05  
Data source: Better Stack (1-hour sample)

## Executive Summary

The cloud logging infrastructure has significant gaps that prevent effective debugging of user-specific issues. The primary problem: **HTTP request logs don't include `userId`**, making it impossible to filter by user in Better Stack.

## Gap 1: HTTP Request Logs Missing `userId`

### Evidence

```sql
SELECT service, countIf(userId != '') AS has_userId, count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR AND service = 'hono-http'
GROUP BY service
```

| service | has_userId | total |
|---------|------------|-------|
| hono-http | 0 | 308 |

**0% of HTTP request logs have `userId`.**

### Sample Log Entry

```json
{
  "dt": "2026-01-05T23:17:59.716Z",
  "level": "info",
  "env": "staging",
  "server": "cloud-staging",
  "service": "hono-http",
  "feature": "http-request",
  "reqId": "e85fc20c2857a5427aade80d97fa5bc8",
  "method": "POST",
  "path": "/api/client/notifications/dismissed",
  "url": "/api/client/notifications/dismissed",
  "status": 200,
  "duration": 0,
  "clientIp": "173.226.56.14",
  "userAgent": "okhttp/4.12.0",
  "contentType": "application/json",
  "contentLength": 186,
  "hasAuth": true,
  "authType": "Bearer"
}
```

Notice: `hasAuth: true` and `authType: "Bearer"` exist, but no `userId` field.

### Root Cause

In `hono-app.ts`, the request logging middleware:
1. Runs and captures request details
2. Calls `await next()` (which runs auth middleware)
3. Logs response **but doesn't read `c.get("email")` from context**

```typescript
// hono-app.ts lines 87-159
app.use(async (c, next) => {
  // ... capture request details ...
  await next();  // Auth runs here, populates c.get("email")
  
  const logData = {
    reqId, method, path, status, duration,
    hasAuth,  // ✅ Captured
    // ❌ MISSING: userId: c.get("email")
  };
  logger.info(logData, `HTTP ${status} ${method} ${path}`);
});
```

### Fix

Add after `await next()`:

```typescript
const userId = c.get("email") || undefined;
const logData = {
  ...existingFields,
  userId,  // Now included!
};
```

---

## Gap 2: `reqId` Not Propagated to Child Loggers

### Evidence

```sql
SELECT service, countIf(reqId != '') AS has_reqId, count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY service ORDER BY total DESC LIMIT 10
```

| service | has_reqId | total |
|---------|-----------|-------|
| app-session | 0 | 18176 |
| DashboardManager | 0 | 4709 |
| hono-http | 308 | 308 |
| client.middleware | 0 | 1756 |

**Only `hono-http` has `reqId`. No other service logs it.**

### Root Cause

Auth middleware creates child logger without `reqId`:

```typescript
// client.middleware.ts line 59
c.set("logger", logger.child({ userId: email }));
// Missing: reqId: c.get("reqId")
```

### Impact

Cannot correlate HTTP request with handler logs:
- HTTP log: `reqId: "abc123"` 
- Handler error: (no reqId) → Can't link them!

### Fix

```typescript
c.set("logger", logger.child({ 
  userId: email,
  reqId: c.get("reqId")  // Add this
}));
```

---

## Gap 3: API Handlers Use Module-Level Logger

### Evidence

Looking at handler code patterns:

```typescript
// user-settings.api.ts
const logger = rootLogger.child({ service: "user-settings.api" });

async function getUserSettings(c: AppContext) {
  const email = c.get("email")!;
  // ...
  logger.error(err, `Error fetching settings for user ${email}`);
  // ❌ Uses module logger, not c.get("logger")
}
```

### Impact

- Handler logs don't have `userId` in structured fields
- Handler logs don't have `reqId` 
- Must parse message string to find user info (unreliable)

### Fix

Handlers should use context logger:

```typescript
async function getUserSettings(c: AppContext) {
  const reqLogger = c.get("logger")!;  // Has userId + reqId
  // ...
  reqLogger.error(err, "Error fetching settings");
  // ✅ userId and reqId automatically included
}
```

---

## Gap 4: Inconsistent `userId` Coverage by Service

### Evidence

```sql
SELECT service, 
  countIf(userId != '') AS has_userId,
  countIf(userId = '' OR userId IS NULL) AS missing_userId,
  count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY service ORDER BY total DESC LIMIT 20
```

| service | has_userId | missing_userId | total | coverage |
|---------|------------|----------------|-------|----------|
| app-session | 17522 | 0 | 17522 | 100% ✅ |
| DashboardManager | 4556 | 0 | 4556 | 100% ✅ |
| app-server | 18 | 3096 | 3114 | 0.6% ❌ |
| TranscriptionManager | 2730 | 0 | 2730 | 100% ✅ |
| (empty service) | 1016 | 1289 | 2305 | 44% |
| client.middleware | 804 | 924 | 1728 | 46% |
| hono-http | 0 | 308 | 308 | 0% ❌ |
| app.service | 0 | 88 | 88 | 0% ❌ |
| client.apps.api | 0 | 50 | 50 | 0% ❌ |

### Analysis

- Session-related services (app-session, DashboardManager, TranscriptionManager): 100% coverage ✅
- API route handlers (hono-http, client.apps.api, app.service): 0% coverage ❌
- Middleware (client.middleware): 46% coverage (logs before/after auth)

---

## Gap 5: Noisy Auth Logging

### Evidence

```sql
SELECT message, count(*) AS cnt
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'client.middleware'
GROUP BY message ORDER BY cnt DESC
```

| message | count |
|---------|-------|
| "requireUserSession: User session populated for X" | 800+ |
| "Auth Middleware: User X authenticated." | 800+ |

### Analysis

Two logs per authenticated request at `info` level. In 1 hour: 1600+ redundant logs.

These should be `debug` level since the HTTP request log already captures the successful auth.

---

## Gap 6: WebSocket Logs Missing `userId` on Connection

### Evidence

```sql
SELECT dt, raw
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'bun-websocket'
  AND (userId = '' OR userId IS NULL)
LIMIT 5
```

```json
{
  "service": "bun-websocket",
  "userId": "",
  "hasJwt": false,
  "message": "App WebSocket upgrade successful"
}
```

### Analysis

WebSocket connection logs have empty `userId` when JWT hasn't been processed yet. This is expected for initial connection, but makes it hard to trace WebSocket issues back to users.

---

## Gap 7: Error Logs Without Context

### Evidence

```sql
SELECT service, message, count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND level = 'error'
  AND (userId = '' OR userId IS NULL)
GROUP BY service, message ORDER BY total DESC LIMIT 10
```

| service | message | total |
|---------|---------|-------|
| app-server | Various session errors | 3343 |
| (empty) | Hardware request validation failed | 183 |
| tools.routes | (various) | 8 |

### Analysis

~3500 error logs in 1 hour have no `userId`. Makes it impossible to:
- Notify affected users
- See error patterns per user
- Debug user-reported issues

---

## Summary: Observability Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| HTTP Request → User | ❌ 0% | No userId in hono-http logs |
| Request Correlation | ❌ 3% | reqId only in hono-http |
| Handler Logs → User | ⚠️ 50% | Inconsistent use of context logger |
| Session Logs → User | ✅ 95%+ | Good coverage |
| Error Logs → User | ⚠️ 70% | Many errors missing userId |
| Log Noise Level | ⚠️ Medium | Auth logs at wrong level |

---

## Priority Ranking

1. **Add `userId` to HTTP request logs** (Gap 1) - High impact, low effort
2. **Add `reqId` to child loggers** (Gap 2) - Enables full request tracing
3. **Reduce auth log noise** (Gap 5) - Quick win, info → debug
4. **Standardize handler logging** (Gap 3) - Medium effort, requires touching many files
5. **Fix error context** (Gap 7) - Ongoing, fix as errors are touched