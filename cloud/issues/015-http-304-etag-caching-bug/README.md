# HTTP 304 ETag Caching Bug

Mobile client fails to parse responses when server returns 304 Not Modified with empty body.

## Documents

- **001-problem-analysis.md** - Root cause analysis and fix

## Quick Context

**Current**: Express/Helmet adds ETag headers to responses. Mobile OkHttp caches responses and sends `If-None-Match` on subsequent requests. Server returns 304 with empty body. React Native/OkHttp fails to use cached response and tries to parse empty body as JSON.

**Result**: `JSON Parse error: Unexpected end of input`

## Key Insight

The bug only manifests when:

1. Mobile has previously cached a successful response
2. Mobile sends conditional request with `If-None-Match: <etag>`
3. Server returns `304 Not Modified` (empty body)
4. OkHttp/React Native chain fails to properly serve cached response

Works fine from curl, browsers, and first-time requests. Fails on subsequent requests from mobile.

## Evidence

Request from mobile (ngrok inspector):

```
GET /apps/version HTTP/1.1
If-None-Match: W/"14-8fdeBt+fs5xMHZxnNYRLB952bII"
User-Agent: okhttp/4.12.0
```

Mobile console:

```
Testing URL: https://isaiah.augmentos.cloud:443/apps/version
URL Test Failed: JSON Parse error: Unexpected end of input
```

## Affected Endpoints

Potentially any endpoint that:

- Returns JSON
- Has ETag headers (default with Express)
- Is called multiple times by mobile

Known affected:

- `GET /apps/version` - Version check on URL test
- Possibly `POST /apps/:packageName/start` - App start
- Possibly `POST /apps/:packageName/stop` - App stop

## Fix

Add cache-control headers to disable conditional requests:

```typescript
res.set("Cache-Control", "no-store, no-cache, must-revalidate")
res.set("Pragma", "no-cache")
res.removeHeader("ETag")
```

## Status

- [x] Root cause identified (304 + empty body + OkHttp)
- [x] Fix applied to `/apps/version` endpoint
- [ ] Audit other endpoints for same issue
- [ ] Consider global middleware to disable ETags for mobile API routes
- [ ] Investigate if this is a React Native/OkHttp bug worth reporting upstream
