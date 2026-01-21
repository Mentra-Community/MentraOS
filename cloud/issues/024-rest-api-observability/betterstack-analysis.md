# Better Stack Analysis: Observability Gaps

Investigation date: 2025-01-05  
Source: Better Stack (AugmentOS source ID: 1311181)  
Sample period: 1 hour

## Query Results

### 1. `userId` Coverage by Service

```sql
SELECT service, 
  countIf(userId != '') AS has_userId,
  countIf(userId = '' OR userId IS NULL) AS missing_userId,
  count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY service ORDER BY total DESC LIMIT 30
```

| service | has_userId | missing_userId | coverage |
|---------|------------|----------------|----------|
| app-session | 17,522 | 0 | 100% ✅ |
| DashboardManager | 4,556 | 0 | 100% ✅ |
| **app-server** | 18 | 3,096 | **0.6%** ❌ |
| TranscriptionManager | 2,730 | 0 | 100% ✅ |
| (empty service) | 1,016 | 1,289 | 44% |
| **client.middleware** | 804 | 924 | **46%** |
| AppManager | 1,681 | 0 | 100% ✅ |
| MicrophoneManager | 1,562 | 0 | 100% ✅ |
| DisplayManager | 1,389 | 0 | 100% ✅ |
| **hono-http** | 0 | 308 | **0%** ❌ |
| bun-websocket | 77 | 86 | 47% |
| **app.service** | 0 | 88 | **0%** ❌ |
| **client.apps.api** | 0 | 50 | **0%** ❌ |
| developer.service | 43 | 0 | 100% ✅ |

**Key Finding**: Session-related services have 100% userId coverage. API route handlers have 0% coverage.

---

### 2. `reqId` Coverage by Service

```sql
SELECT service, 
  countIf(reqId != '') AS has_reqId,
  countIf(reqId = '' OR reqId IS NULL) AS missing_reqId,
  count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY service ORDER BY total DESC LIMIT 10
```

| service | has_reqId | missing_reqId | coverage |
|---------|-----------|---------------|----------|
| app-session | 0 | 18,176 | 0% |
| DashboardManager | 0 | 4,709 | 0% |
| app-server | 0 | 3,235 | 0% |
| client.middleware | 0 | 1,756 | 0% |
| **hono-http** | 308 | 0 | **100%** |

**Key Finding**: `reqId` only exists in `hono-http` logs. No correlation possible with other services.

---

### 3. HTTP Request Log Sample (No userId)

```sql
SELECT dt, raw
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'hono-http'
ORDER BY dt DESC LIMIT 1
```

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
  "status": 200,
  "duration": 0,
  "clientIp": "173.226.56.14",
  "userAgent": "okhttp/4.12.0",
  "hasAuth": true,
  "authType": "Bearer"
}
```

**Problem**: `hasAuth: true` but no `userId` field. We know they authenticated but not who.

---

### 4. Auth Middleware Logs (userId Present After Auth)

```sql
SELECT dt, raw
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'client.middleware'
ORDER BY dt DESC LIMIT 2
```

```json
{
  "service": "client.middleware",
  "message": "Auth Middleware: User drewcreek@gmail.com authenticated."
}
```

```json
{
  "service": "client.middleware",
  "userId": "drewcreek@gmail.com",
  "message": "requireUserSession: User session populated for drewcreek@gmail.com"
}
```

**Observation**: First log (auth) has no `userId` field. Second log (requireUserSession) has it.

---

### 5. Log Volume by Level

```sql
SELECT level, count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY level ORDER BY total DESC
```

| level | total |
|-------|-------|
| debug | 18,237 |
| info | 17,180 |
| **error** | **11,327** |
| warn | 1,587 |

**Concern**: ~23% of logs are errors. Investigated below.

---

### 6. Top Errors (with userId coverage)

```sql
SELECT service, message, 
  countIf(userId != '') AS has_userId,
  count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND level = 'error'
GROUP BY service, message ORDER BY total DESC LIMIT 10
```

| service | message | has_userId | total |
|---------|---------|------------|-------|
| app-session | Message send error | 3,628 | 3,628 ✅ |
| (empty) | Hardware request validation failed - glasses not connected | 0 | 183 ❌ |
| app-session | weather.request.failed | 96 | 96 ✅ |
| app-server | Various session errors | 0 | 43 ❌ |
| DisplayManager | Display request validation failed | 213 | 213 ✅ |

**Good**: Most app-session errors have userId.  
**Bad**: Validation errors and app-server errors missing userId.

---

### 7. Errors by Environment

```sql
SELECT env, count(*) AS cnt
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND level = 'error'
GROUP BY env ORDER BY cnt DESC
```

| env | error_count |
|-----|-------------|
| debug | 17,863 |
| production | 804 |
| development | 13 |
| staging | 8 |

**Note**: Most errors from local debug environments (expected for development).

---

### 8. Errors by Package (SDK Apps)

```sql
SELECT packageName, count(*) AS cnt
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND level = 'error'
GROUP BY packageName ORDER BY cnt DESC LIMIT 10
```

| packageName | error_count |
|-------------|-------------|
| system.augmentos.dashboard | 18,473 |
| (empty) | 441 |
| org.mentra.example-play-sound | 2 |

**Finding**: Dashboard app generating majority of errors (known issue - timer errors after disconnect).

---

### 9. Server/Environment Distribution

```sql
SELECT server, env, count(*) AS log_count
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY server, env ORDER BY log_count DESC
```

| server | env | log_count |
|--------|-----|-----------|
| cloud-local | debug | 40,221 |
| cloud-staging | staging | 17,972 |
| cloud-prod | production | 10,735 |
| cloud-dev | development | 5,796 |
| cloud-debug | debug | 4,298 |
| cloud-local | isaiah | 2,874 |

**Issue**: Inconsistent `env` naming (debug, isaiah, aryan). Should standardize.

---

## Summary of Observability Issues Found

### Critical Gaps

1. **HTTP requests have 0% userId coverage** - Can't filter by user
2. **reqId only in hono-http** - Can't correlate request to handler logs
3. **API handlers have 0% userId** - Errors can't be attributed to users

### Additional Issues

4. **Inconsistent env naming** - `debug`, `isaiah`, `aryan` instead of standard values
5. **High error volume** - 23% of logs are errors (mostly from dashboard app timer issue)
6. **WebSocket logs missing userId on connect** - 47% coverage

### What's Working Well

- Session services (app-session, AppManager, TranscriptionManager): 100% userId ✅
- HTTP request logging exists with reqId ✅
- Error logs from session context have full context ✅

---

## Useful Queries for Debugging

### Find all activity for a user
```sql
SELECT dt, service, level, message
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND userId = 'user@example.com'
ORDER BY dt DESC
LIMIT 100
```

### Find HTTP errors for a user (AFTER FIX)
```sql
SELECT dt, method, path, status, duration
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND service = 'hono-http'
  AND userId = 'user@example.com'
  AND status >= 400
ORDER BY dt DESC
```

### Trace a single request (AFTER FIX)
```sql
SELECT dt, service, level, message
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 10 MINUTE
  AND reqId = 'abc123'
ORDER BY dt
```

### Find users generating most errors
```sql
SELECT userId, count(*) AS error_count
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
  AND level = 'error'
  AND userId != ''
GROUP BY userId
ORDER BY error_count DESC
LIMIT 20
```
