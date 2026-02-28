# Problem Analysis: HTTP 304 ETag Caching Bug

## Summary

Mobile client receives `304 Not Modified` responses with empty body, then fails to parse as JSON. This happens because OkHttp sends conditional requests with `If-None-Match` headers, and something in the React Native/OkHttp chain doesn't properly serve the cached response.

## The Bug Flow

```
1. Mobile makes first request to /apps/version
2. Server responds: 200 OK, body: {"version":"2.1.16"}, ETag: W/"14-8fdeBt..."
3. OkHttp caches response

4. Mobile makes second request to /apps/version
5. OkHttp adds: If-None-Match: W/"14-8fdeBt..."
6. Server responds: 304 Not Modified, body: (empty)
7. OkHttp SHOULD serve cached response
8. Instead: React Native tries to parse empty body as JSON
9. Error: "JSON Parse error: Unexpected end of input"
```

## Evidence

### Request Headers (from ngrok inspector)

```
GET /apps/version HTTP/1.1
Host: isaiah.augmentos.cloud
User-Agent: okhttp/4.12.0
Accept-Encoding: gzip
If-None-Match: W/"14-8fdeBt+fs5xMHZxnNYRLB952bII"
```

### Mobile Console Output

```
Testing URL: https://isaiah.augmentos.cloud:443/apps/version
URL Test Failed: JSON Parse error: Unexpected end of input
```

### Server Response (304)

```
HTTP/1.1 304 Not Modified
ETag: W/"14-8fdeBt+fs5xMHZxnNYRLB952bII"
Content-Length: 0
```

### Curl Works Fine

```bash
$ curl -s https://isaiah.augmentos.cloud/apps/version
{"version":"2.1.16"}
```

Curl doesn't send `If-None-Match` by default, so it always gets 200 with body.

## Why This Only Affects Local/Dev Servers

Production servers (`debug.augmentos.cloud`) go through **Cloudflare**, which:

- May strip or modify caching headers
- May always return 200 with body
- Has different caching behavior

Local servers via ngrok pass through raw Express responses with ETags intact.

## Root Cause

Express (via `res.json()`) automatically sets ETag headers. When the client sends `If-None-Match` matching the ETag, Express returns 304.

The bug is in the React Native / OkHttp / fetch chain - somewhere between receiving the 304 and serving the cached response to JavaScript, it fails.

This could be:

1. React Native's fetch polyfill not handling 304 correctly
2. OkHttp cache misconfiguration in React Native
3. A known bug in specific OkHttp/RN versions

## Affected Code Paths

### Mobile - BackendUrl.tsx

```typescript
// packages/mobile/src/components/dev/BackendUrl.tsx:49-57
const response = await fetch(testUrl, {
  method: "GET",
  signal: controller.signal,
});

if (response.ok) {
  const data = await response.json();  // ← Fails here on 304
```

### Mobile - RestComms.ts

```typescript
// packages/mobile/src/services/RestComms.ts:72-92
private makeRequest<T>(config: RequestConfig): AsyncResult<T, Error> {
  // Uses axios, which uses OkHttp on Android
  const res = await this.axiosInstance.request<T>(axiosConfig);
  return res.data;  // ← Could fail here on 304
}
```

### Server - apps.routes.ts (before fix)

```typescript
// packages/cloud/src/routes/apps.routes.ts:1356
router.get("/version", async (req, res) => {
  res.json({version: CLOUD_VERSION}) // ← Express adds ETag automatically
})
```

## Fix Applied

```typescript
// packages/cloud/src/routes/apps.routes.ts:1356-1361
router.get("/version", async (req, res) => {
  // Disable caching to prevent 304 responses that cause JSON parse errors on mobile
  res.set("Cache-Control", "no-store, no-cache, must-revalidate")
  res.set("Pragma", "no-cache")
  res.removeHeader("ETag")
  res.json({version: CLOUD_VERSION})
})
```

## Other Potentially Affected Endpoints

Any endpoint called multiple times by mobile could have this issue:

| Endpoint                        | Risk      | Notes                   |
| ------------------------------- | --------- | ----------------------- |
| `GET /apps/version`             | **Fixed** | URL test check          |
| `GET /api/client/min-version`   | Medium    | Called on app start     |
| `GET /api/client/apps`          | Medium    | App list fetch          |
| `GET /api/apps/installed`       | Medium    | Installed apps          |
| `POST /apps/:pkg/start`         | Low       | POST usually not cached |
| `POST /apps/:pkg/stop`          | Low       | POST usually not cached |
| `GET /api/client/user/settings` | Medium    | Settings fetch          |
| `GET /health`                   | Low       | Not called by mobile    |

## Recommended Fix Options

### Option 1: Per-Endpoint Fix (Current)

Add cache headers to each affected endpoint:

```typescript
res.set("Cache-Control", "no-store, no-cache, must-revalidate")
res.set("Pragma", "no-cache")
res.removeHeader("ETag")
```

**Pros**: Surgical, doesn't affect browser caching for web endpoints
**Cons**: Easy to miss endpoints, repetitive

### Option 2: Global Middleware for Mobile Routes

```typescript
// Middleware for /api/client/* routes
app.use("/api/client", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate")
  res.set("Pragma", "no-cache")
  next()
})

// Disable ETags globally for API routes
app.set("etag", false)
```

**Pros**: Catches all mobile endpoints
**Cons**: May affect legitimate caching, broader impact

### Option 3: Disable ETags in Helmet

```typescript
app.use(
  helmet({
    // ... other options
  }),
)

// After helmet
app.set("etag", false)
```

**Pros**: Simple
**Cons**: Affects all routes including web

### Option 4: Fix on Mobile Side

Investigate and fix the React Native/OkHttp cache handling:

```typescript
// In axios config or fetch options
const response = await fetch(url, {
  cache: "no-store", // Disable caching
})
```

**Pros**: Fixes root cause
**Cons**: Requires mobile app update, may miss edge cases

## Recommended Approach

1. **Immediate**: Apply per-endpoint fix to critical endpoints (done for `/apps/version`)
2. **Short-term**: Add global middleware for `/api/client/*` routes
3. **Long-term**: Investigate mobile-side fix, report upstream if RN bug

## Testing

To verify the fix:

1. Clear mobile app cache/data
2. Make request → should get 200 with body
3. Make same request again → should still get 200 (not 304)
4. Check response headers for `Cache-Control: no-store`

## Open Questions

1. **Is this a known React Native bug?** Need to search RN/OkHttp issues
2. **Does iOS have the same issue?** OkHttp is Android-only, iOS uses different HTTP stack
3. **Why does Cloudflare "fix" this?** Need to understand CF's caching behavior
4. **Should we disable ETags globally?** Trade-off between mobile compatibility and web caching
