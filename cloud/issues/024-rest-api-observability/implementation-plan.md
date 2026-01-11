# Implementation Plan: REST API Observability

## Overview

This document provides specific code changes to fix the REST API observability gaps identified in the investigation.

## Change 1: Add `userId` to HTTP Request Logs

**File**: `cloud/packages/cloud/src/hono-app.ts`  
**Lines**: ~140-155 (in the request logging middleware)

### Current Code

```typescript
await next();

const duration = Date.now() - start;
const status = c.res.status;
const responseContentType = c.res.headers.get("content-type");

const logData = {
  reqId,
  method,
  path: reqPath,
  url: new URL(url).pathname + new URL(url).search,
  status,
  duration,
  responseContentType,
  clientIp,
  userAgent,
  contentType,
  contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
  referer,
  origin,
  hasAuth,
  authType,
  service: "hono-http",
  feature: "http-request",
};
```

### New Code

```typescript
await next();

const duration = Date.now() - start;
const status = c.res.status;
const responseContentType = c.res.headers.get("content-type");

// Capture userId from auth middleware (runs during next())
const userId = c.get("email") || undefined;

const logData = {
  reqId,
  method,
  path: reqPath,
  url: new URL(url).pathname + new URL(url).search,
  status,
  duration,
  responseContentType,
  clientIp,
  userAgent,
  contentType,
  contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
  referer,
  origin,
  hasAuth,
  authType,
  userId,  // NEW: Include userId for user-centric filtering
  service: "hono-http",
  feature: "http-request",
};
```

**Impact**: All authenticated HTTP requests will now include `userId` in Better Stack.

---

## Change 2: Add `reqId` to Auth Middleware Child Logger

**File**: `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts`  
**Line**: ~59

### Current Code

```typescript
const email = decoded.email.toLowerCase();
c.set("email", email);
c.set("logger", logger.child({ userId: email }));
```

### New Code

```typescript
const email = decoded.email.toLowerCase();
c.set("email", email);
c.set("logger", logger.child({ 
  userId: email,
  reqId: c.get("reqId"),  // NEW: Correlate all logs with HTTP request
}));
```

**File**: `cloud/packages/cloud/src/api/hono/middleware/console.middleware.ts`  
**Line**: ~76

### Current Code

```typescript
c.set("console", { email });
c.set("logger", logger.child({ userId: email, context: "console" }));
```

### New Code

```typescript
c.set("console", { email });
c.set("logger", logger.child({ 
  userId: email, 
  context: "console",
  reqId: c.get("reqId"),  // NEW
}));
```

**Impact**: All logs from handlers using `c.get("logger")` will include both `userId` and `reqId`.

---

## Change 3: Reduce Auth Log Noise

**File**: `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts`

### Current Code (lines ~60-61)

```typescript
c.set("logger", logger.child({ userId: email }));
logger.info(`Auth Middleware: User ${email} authenticated.`);
```

### New Code

```typescript
c.set("logger", logger.child({ userId: email, reqId: c.get("reqId") }));
// Removed: logger.info(`Auth Middleware: User ${email} authenticated.`);
// HTTP request log already captures successful auth
```

### Current Code (lines ~81-82)

```typescript
c.set("user", user);
reqLogger.info(`requireUser: User object populated for ${email}`);
```

### New Code

```typescript
c.set("user", user);
reqLogger.debug(`User object populated`);  // Downgrade to debug, no need to repeat email
```

### Current Code (lines ~104-105)

```typescript
c.set("userSession", userSession);
reqLogger.info(`requireUserSession: User session populated for ${email}`);
```

### New Code

```typescript
c.set("userSession", userSession);
reqLogger.debug(`User session populated`);  // Downgrade to debug
```

**Impact**: ~1600 fewer info-level logs per hour.

---

## Change 4: Example Handler Update (Pattern)

This is the pattern to apply to all API handlers over time.

**File**: `cloud/packages/cloud/src/api/hono/client/user-settings.api.ts`

### Current Pattern

```typescript
const logger = rootLogger.child({ service: "user-settings.api" });

async function getUserSettings(c: AppContext) {
  const email = c.get("email")!;

  try {
    const settings = await UserSettingsService.getUserSettings(email);
    return c.json({ success: true, data: { settings } });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error fetching settings for user ${email}:`);
    return c.json({ success: false, message: "Failed to fetch user settings" }, 500);
  }
}
```

### New Pattern

```typescript
const fallbackLogger = rootLogger.child({ service: "user-settings.api" });

async function getUserSettings(c: AppContext) {
  const reqLogger = c.get("logger") || fallbackLogger;

  try {
    const settings = await UserSettingsService.getUserSettings(c.get("email")!);
    return c.json({ success: true, data: { settings } });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    reqLogger.error({ err }, "Error fetching user settings");
    // userId and reqId are already in logger context - no need to interpolate
    return c.json({ success: false, message: "Failed to fetch user settings" }, 500);
  }
}
```

**Key differences**:
1. Use `c.get("logger")` instead of module-level logger
2. Don't interpolate `email` in message - it's already in logger context
3. Error object passed as structured field, not concatenated

---

## Implementation Order

### Phase 1: Quick Wins (30 minutes)

| File | Change | Impact |
|------|--------|--------|
| `hono-app.ts` | Add `userId` to logData | All HTTP logs get userId |
| `client.middleware.ts` | Add `reqId` to child logger | Request correlation |
| `console.middleware.ts` | Add `reqId` to child logger | Request correlation |

### Phase 2: Noise Reduction (15 minutes)

| File | Change | Impact |
|------|--------|--------|
| `client.middleware.ts` | Remove/downgrade auth logs | -1600 logs/hour |

### Phase 3: Handler Standardization (Ongoing)

Apply the handler pattern to files as they're touched:

Priority files (highest traffic):
- `client/user-settings.api.ts`
- `client/client.apps.api.ts`
- `client/device-state.api.ts`
- `client/notifications.api.ts`
- `routes/app-settings.routes.ts`

---

## Validation Queries

After deployment, run these queries in Better Stack to verify:

### 1. HTTP Logs Have userId

```sql
SELECT 
  countIf(userId IS NOT NULL AND userId != '') AS has_userId,
  countIf(userId IS NULL OR userId = '') AS missing_userId,
  count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'hono-http'
```

**Expected**: `has_userId` should be ~90%+ (unauthenticated requests won't have it)

### 2. Request Correlation Works

```sql
SELECT reqId, service, message
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 10 MINUTE
  AND reqId = 'some-known-reqid'
ORDER BY dt
```

**Expected**: Multiple log entries with same `reqId` from different services

### 3. Auth Log Noise Reduced

```sql
SELECT count(*) AS auth_logs
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'client.middleware'
  AND level = 'info'
```

**Expected**: Should be near 0 (down from 1600+)

### 4. Filter by User

```sql
SELECT dt, service, level, message
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND userId = 'some-user@example.com'
ORDER BY dt DESC
LIMIT 100
```

**Expected**: Shows all activity for that user including HTTP requests

---

## Rollback Plan

If issues arise:

1. **Phase 1 changes** are additive (adding fields) - no rollback needed
2. **Phase 2 changes** (log level changes) - revert the info→debug changes
3. **Phase 3 changes** (handler updates) - revert individual files

---

## Files to Modify

| File | Phase | Effort |
|------|-------|--------|
| `src/hono-app.ts` | 1 | 5 min |
| `src/api/hono/middleware/client.middleware.ts` | 1, 2 | 10 min |
| `src/api/hono/middleware/console.middleware.ts` | 1 | 5 min |
| `src/api/hono/middleware/sdk.middleware.ts` | 1 | 5 min |
| `src/api/hono/middleware/cli.middleware.ts` | 1 | 5 min |
| Various API handlers | 3 | Ongoing |

---

## Success Criteria

After Phase 1 + 2:

- [ ] Can query `userId:foo@example.com` in Better Stack and see HTTP requests
- [ ] Can query `reqId:abc123` and see full request trace
- [ ] Auth middleware logs reduced by 90%+
- [ ] No regressions in existing observability