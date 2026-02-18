# Sub-Issue 008.5: API Authentication Errors

**Status**: Open  
**Priority**: Medium (~971 errors in 6 hours)  
**Component**: app-session, authentication

## Problem Statement

Apps are encountering **971 authentication errors (401 status code) in 6 hours** when making API requests. This indicates either:

1. Token expiration not being handled properly
2. Apps using invalid/outdated credentials
3. Race conditions during token refresh
4. Session state mismatches

## Error Details

### Error from Logs

```json
{
  "level": "error",
  "service": "app-session",
  "err": {
    "message": "Request failed with status code 401"
  }
}
```

### Error Volume

| Service       | Error Count (6h) | Error Type       |
| ------------- | ---------------- | ---------------- |
| `app-session` | 971              | 401 Unauthorized |
| `AppManager`  | 11               | 404 Not Found    |
| `AppManager`  | 9                | 502 Bad Gateway  |

## Root Cause Analysis

### Possible Causes

1. **Token Expiration**
   - JWT tokens have expired
   - Token refresh logic not working
   - Clock skew between services

2. **Invalid Credentials**
   - Apps using old/revoked API keys
   - Session tokens invalidated server-side
   - Credentials not properly stored

3. **Race Conditions**
   - Multiple requests during token refresh
   - Token refreshed but old token still used
   - Concurrent session invalidation

4. **Session State Issues**
   - Session ended but app still making requests
   - User logged out but app not notified
   - Backend session cleanup not propagated

### Missing Context

The current logs don't include:

- Which API endpoint failed
- Which app is making the request
- Token expiration time vs current time
- User ID associated with the request

## Investigation Needed

### Questions to Answer

1. Which apps are generating these 401 errors?
2. What API endpoints are failing?
3. Are these happening for specific users or all users?
4. Is there a pattern (time of day, after certain actions)?
5. What's the token expiration configuration?

### Queries to Run

```sql
-- Find which apps are generating 401 errors
SELECT
  JSONExtract(raw, 'app', 'Nullable(String)') as app,
  JSONExtract(raw, 'packageName', 'Nullable(String)') as packageName,
  JSONExtract(raw, 'userId', 'Nullable(String)') as userId,
  count() as error_count
FROM s3Cluster(primary, t373499_augmentos_s3)
WHERE _row_type = 1
  AND dt >= now() - INTERVAL 6 HOUR
  AND JSONExtract(raw, 'level', 'Nullable(String)') = 'error'
  AND JSONExtract(raw, 'err', 'message', 'Nullable(String)') LIKE '%401%'
GROUP BY app, packageName, userId
ORDER BY error_count DESC
LIMIT 20
```

## Fix Options

### Option A: Improve Token Refresh Logic

Ensure tokens are refreshed before expiration:

```typescript
class TokenManager {
  private refreshBuffer = 60000; // Refresh 1 minute before expiry

  async getValidToken(): Promise<string> {
    const expiresAt = this.getTokenExpiry();
    const now = Date.now();

    if (expiresAt - now < this.refreshBuffer) {
      await this.refreshToken();
    }

    return this.currentToken;
  }
}
```

**Pros**: Prevents expiration-related 401s
**Cons**: Requires SDK changes

### Option B: Automatic Retry on 401

Add automatic token refresh and retry on 401:

```typescript
async makeRequest(options: RequestOptions): Promise<Response> {
  try {
    return await this.httpClient.request(options);
  } catch (error) {
    if (error.response?.status === 401) {
      await this.refreshToken();
      return await this.httpClient.request(options);
    }
    throw error;
  }
}
```

**Pros**: Transparent retry for users
**Cons**: Hides potential issues, adds latency

### Option C: Better Error Logging

Add context to understand the failures:

```typescript
} catch (error) {
  if (error.response?.status === 401) {
    this.logger.warn({
      endpoint: options.url,
      packageName: this.packageName,
      userId: this.userId,
      tokenAge: Date.now() - this.tokenIssuedAt,
      tokenExpiry: this.tokenExpiresAt,
    }, "API request unauthorized - token may be expired");
  }
  throw error;
}
```

**Pros**: Better debugging capability
**Cons**: Doesn't fix the issue

### Option D: Graceful Session End

When a 401 is received, properly end the session:

```typescript
if (error.response?.status === 401) {
  this.logger.info({ packageName: this.packageName }, "Session authentication failed - ending session");
  await this.endSession("auth_failed");
}
```

**Pros**: Prevents cascading errors
**Cons**: May disrupt user experience

## Recommended Action Plan

### Phase 1: Better Logging (Immediate)

1. Add context to 401 error logs:
   - Endpoint URL
   - Package name
   - User ID
   - Token age/expiry info

2. Downgrade expected 401s (session ended) to `warn`

3. Keep unexpected 401s (active session) as `error`

### Phase 2: Investigation

1. Run queries to identify patterns
2. Check token expiration configuration
3. Review recent auth-related changes
4. Test token refresh flow manually

### Phase 3: Fix Based on Findings

**If token expiration issue**: Implement proactive refresh
**If race condition**: Add token refresh locking
**If session cleanup issue**: Improve session end propagation
**If app bug**: Fix specific app

### Phase 4: Add Monitoring

1. Dashboard for auth error rate by app
2. Alert on spike in 401 errors
3. Track token refresh success/failure rate

## Files to Investigate

- `cloud/packages/sdk/src/app/session/index.ts` - Session authentication
- `cloud/packages/sdk/src/app/auth.ts` - Token management (if exists)
- `cloud/packages/cloud/src/routes/apps.routes.ts` - Auth middleware
- `cloud/packages/cloud/src/middleware/auth.ts` - Token validation

## Error Response Handling Matrix

| Scenario                     | Current Behavior | Recommended                |
| ---------------------------- | ---------------- | -------------------------- |
| Token expired, can refresh   | Error, fail      | Warn, retry with new token |
| Token expired, can't refresh | Error            | Error (legitimate)         |
| Session ended by user        | Error            | Debug, end gracefully      |
| Invalid API key              | Error            | Error (legitimate)         |
| Service-to-service auth fail | Error            | Error (legitimate)         |

## Metrics to Track

After fixes:

- 401 error rate by app
- Token refresh success rate
- Time between token refresh and 401 (should be >0)
- Errors per unique session

## Success Criteria

- 401 errors drop by >80% (assuming most are preventable)
- Remaining 401s have full context for debugging
- Token refresh happens proactively before expiration
- Clear documentation of auth error handling

## Related Issues

- Sub-Issue 001: Dashboard app errors (may be related to session auth)
- Issue 008: Logging & Observability Cleanup (parent)
- Potential: Token management improvements
- Potential: Session lifecycle documentation
