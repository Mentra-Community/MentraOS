# Authentication Guide for MentraOS Apps

This guide explains how authentication works in MentraOS apps with the two-server architecture (Express + Bun).

## Table of Contents

- [Overview](#overview)
- [How Authentication Works](#how-authentication-works)
- [Local Development](#local-development)
- [Building API Routes](#building-api-routes)
  - [Express Routes (Recommended for Auth)](#express-routes-recommended-for-auth)
  - [Bun Routes (Forwarded Headers)](#bun-routes-forwarded-headers)
- [Authentication Patterns](#authentication-patterns)
- [Testing Authentication](#testing-authentication)
- [Troubleshooting](#troubleshooting)

---

## Overview

MentraOS apps use a **hybrid two-server architecture**:

- **Port 3333 (Express)**: Handles MentraOS integration, webhooks, and authentication middleware
- **Port 3334 (Bun)**: Serves React webview and API routes with hot reloading

Authentication happens in **Express** via the `createAuthMiddleware` from `@mentra/sdk`, then gets forwarded to **Bun** routes via headers.

---

## How Authentication Works

### The Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User visits: http://localhost:3333/mentra-auth              │
│    ↓                                                             │
│ 2. Redirect to: https://account.mentra.glass/auth?packagename=...│
│    ↓                                                             │
│ 3. User logs in (if needed)                                     │
│    ↓                                                             │
│ 4. User clicks "Allow" on consent screen                        │
│    ↓                                                             │
│ 5. Redirect back: http://localhost:3333?aos_signed_user_token=...│
│    ↓                                                             │
│ 6. Express auth middleware:                                     │
│    - Verifies token                                             │
│    - Sets req.authUserId                                        │
│    - Creates session cookie                                     │
│    ↓                                                             │
│ 7. Subsequent requests use session cookie                       │
└─────────────────────────────────────────────────────────────────┘
```

### Supported Token Types

The auth middleware automatically handles:

1. **Signed User Token** (`aos_signed_user_token`) - JWT from OAuth flow
2. **Temporary Token** (`aos_temp_token`) - From mobile app webview
3. **Frontend Token** (`aos_frontend_token`) - Hash-based token
4. **Session Cookie** (`aos_session`) - Persistent session after any auth method

---

## Local Development

### Step 1: Start Your App

```bash
bun run dev
```

This starts:

- Express on port 3333 (with auth middleware)
- Bun on port 3334 (webview + API routes)

### Step 2: Authenticate

Visit the auth endpoint:

```
http://localhost:3333/mentra-auth
```

This will:

1. Redirect you to the MentraOS login page
2. Ask you to authorize the app
3. Redirect back with a token
4. Set a session cookie

### Step 3: Verify Authentication

Visit the `/api/me` endpoint to check your auth status:

```bash
curl http://localhost:3333/api/me
```

**Expected response:**

```json
{
  "userId": "your-email@example.com",
  "hasSession": true,
  "isAuthenticated": true
}
```

---

## Building API Routes

You can build authenticated API routes in **either Express or Bun**. Choose based on your preference:

### Express Routes (Recommended for Auth)

**When to use:**

- You prefer Express patterns
- You need complex middleware chains
- You want direct access to `req.authUserId`

**How to use:**

In `src/index.ts`, add routes **before** the catch-all proxy:

```typescript
// Get Express app instance
const expressApp = captionsApp.getExpressApp()

// Add your authenticated routes here
expressApp.get("/api/express-example", (req, res) => {
  const authReq = req as any

  if (!authReq.authUserId) {
    return res.status(401).json({ error: "Not authenticated" })
  }

  res.json({
    message: "Hello from Express!",
    userId: authReq.authUserId,
    hasSession: !!authReq.activeSession
  })
})

// IMPORTANT: Proxy comes AFTER your routes
expressApp.all("*", async (req, res) => { ... })
```

**Pros:**

- Direct access to auth middleware
- Standard Express patterns
- No header forwarding needed

**Cons:**

- Code in `index.ts` instead of separate route files
- No hot reloading (requires restart)

---

### Bun Routes (Forwarded Headers)

**When to use:**

- You prefer Bun's patterns
- You want hot reloading during development
- You want organized route files

**How to use:**

In `src/api/routes.ts`, use the auth helpers:

```typescript
import {getAuthUserId, requireAuth, optionalAuth} from "./auth-helpers"

export const routes = {
  // Pattern 1: Manual auth check
  "/api/me": {
    async GET(req: Request) {
      const userId = getAuthUserId(req)

      if (!userId) {
        return Response.json({error: "Not authenticated"}, {status: 401})
      }

      return Response.json({userId, authenticated: true})
    },
  },

  // Pattern 2: requireAuth wrapper (cleaner)
  "/api/profile": requireAuth(async (req, userId) => {
    return Response.json({
      message: "This route is protected",
      userId,
    })
  }),

  // Pattern 3: optionalAuth (different behavior for auth/non-auth)
  "/api/feed": optionalAuth(async (req, userId) => {
    if (userId) {
      return Response.json({
        message: "Your personalized feed",
        userId,
        items: [], // Fetch user-specific items
      })
    }

    return Response.json({
      message: "Public feed",
      items: [], // Fetch public items
    })
  }),
}
```

**Pros:**

- Hot reloading (instant updates)
- Organized in route files
- Clean helper functions

**Cons:**

- Auth info comes from headers (not `req` object)
- Slightly less intuitive than Express patterns

---

## Authentication Patterns

### Helper Functions (Bun Routes)

#### `getAuthUserId(req: Request): string | null`

Extract the authenticated user ID:

```typescript
const userId = getAuthUserId(req)
if (!userId) {
  return Response.json({error: "Not authenticated"}, {status: 401})
}
```

#### `hasActiveSession(req: Request): boolean`

Check if there's an active MentraOS session (glasses connected):

```typescript
if (hasActiveSession(req)) {
  // User has glasses connected
}
```

#### `getAuthInfo(req: Request)`

Get all auth information at once:

```typescript
const {userId, hasSession, isAuthenticated} = getAuthInfo(req)
return Response.json({userId, hasSession, isAuthenticated})
```

#### `requireAuth(handler)`

Wrapper that requires authentication:

```typescript
"/api/protected": requireAuth(async (req, userId) => {
  // userId is guaranteed to exist here
  return Response.json({ userId })
})
```

#### `optionalAuth(handler)`

Wrapper for routes that work with or without auth:

```typescript
"/api/public": optionalAuth(async (req, userId) => {
  // userId might be null
  if (userId) {
    return Response.json({ message: "Hello, " + userId })
  }
  return Response.json({ message: "Hello, guest" })
})
```

---

## Testing Authentication

### Manual Browser Testing

1. **Start the app:**

   ```bash
   bun run dev
   ```

2. **Open browser to:**

   ```
   http://localhost:3333/mentra-auth
   ```

3. **Log in and authorize**

4. **Test authenticated endpoints:**
   ```
   http://localhost:3333/api/me
   http://localhost:3333/api/protected-example
   ```

### cURL Testing

**Get auth token:**

```bash
# Visit /mentra-auth in browser first, then copy the aos_session cookie

curl http://localhost:3333/api/me \
  -H "Cookie: aos_session=your-session-cookie-here"
```

**Test without auth:**

```bash
curl http://localhost:3333/api/me
# Should return: { "authenticated": false }
```

**Test with auth:**

```bash
# After authenticating via /mentra-auth
curl http://localhost:3333/api/me \
  --cookie-jar cookies.txt \
  --cookie cookies.txt
```

---

## Troubleshooting

### Issue: `/api/me` returns `authenticated: false`

**Possible causes:**

1. **Haven't authenticated yet**
   - Solution: Visit `http://localhost:3333/mentra-auth`

2. **Session cookie expired**
   - Solution: Re-authenticate via `/mentra-auth`

3. **Cookies not being sent**
   - Solution: Check browser dev tools → Application → Cookies
   - Ensure `aos_session` cookie exists

4. **Wrong port**
   - Solution: Always use port 3333 (Express), not 3334 (Bun directly)

### Issue: Auth works in Express but not Bun routes

**Check:**

1. **Headers are being forwarded?**
   - In `src/index.ts`, verify the proxy adds `x-auth-user-id` header:

   ```typescript
   if (authReq.authUserId) {
     proxyHeaders["x-auth-user-id"] = authReq.authUserId
   }
   ```

2. **Using correct helper functions?**
   - Use `getAuthUserId(req)` in Bun routes
   - NOT `req.authUserId` (that's Express only)

### Issue: CORS errors in browser

**Solution:**

Add CORS headers to your Bun routes:

```typescript
"/api/example": {
  async GET(req: Request) {
    return Response.json(
      { data: "example" },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      }
    )
  }
}
```

### Issue: Changes to Bun routes not reflecting

**Solution:**

Bun routes have hot reloading, but sometimes you need to refresh the browser:

1. Save the file
2. Hard refresh browser (Cmd+Shift+R or Ctrl+Shift+R)
3. If still not working, restart: `bun run dev`

### Issue: Express routes not working

**Check:**

1. **Routes added BEFORE the proxy?**

   ```typescript
   // ✅ Correct order
   expressApp.get("/api/my-route", handler)
   expressApp.all("*", proxyHandler) // Proxy comes LAST
   ```

2. **Restart required**
   - Express routes require restart (no hot reload)
   - Stop and run `bun run dev` again

---

## Best Practices

### 1. Choose One Pattern Per Project

For consistency, pick either:

- **All Express routes** (if you prefer traditional patterns)
- **All Bun routes** (if you want hot reloading)
- **Hybrid** (MentraOS/auth in Express, app logic in Bun)

### 2. Always Use `/mentra-auth` for Local Dev

Don't try to generate tokens manually. The `/mentra-auth` endpoint handles the entire OAuth flow for you.

### 3. Check Authentication Early

In protected routes, check auth at the start:

```typescript
const userId = getAuthUserId(req)
if (!userId) {
  return unauthorizedResponse()
}
// ... rest of route logic
```

### 4. Use Helper Functions

Instead of manually checking headers, use the auth helpers:

```typescript
// ❌ Don't do this
const userId = req.headers.get("x-auth-user-id")

// ✅ Do this
const userId = getAuthUserId(req)
```

### 5. Test Both Auth States

Always test your routes in two states:

- **Authenticated** (after visiting `/mentra-auth`)
- **Unauthenticated** (in incognito window)

---

## Advanced: Production Deployment

In production, the auth flow is the same, but:

1. **Use HTTPS** - Required for secure cookies
2. **Set proper cookie options** - Already configured in `AppServer`
3. **Use ngrok for testing** - To test OAuth flow before deployment

**Example with ngrok:**

```bash
# Start your app
bun run dev

# In another terminal, expose it
ngrok http 3333

# Visit the ngrok URL
https://your-subdomain.ngrok.app/mentra-auth
```

---

## Summary

| Feature     | Express Routes     | Bun Routes           |
| ----------- | ------------------ | -------------------- |
| Auth access | `req.authUserId`   | `getAuthUserId(req)` |
| Hot reload  | ❌ No              | ✅ Yes               |
| Location    | `src/index.ts`     | `src/api/routes.ts`  |
| Pattern     | Express middleware | Helper functions     |
| Best for    | Complex auth logic | Rapid development    |

**Recommended approach:** Use **Bun routes** for most API endpoints (hot reload is great for development), and only use **Express routes** if you need custom middleware or prefer Express patterns.

---

## Questions?

- Check the [MentraOS Discord](https://discord.gg/5ukNvkEAqT)
- Read the [SDK Documentation](https://docs.mentra.glass)
- Open an issue on [GitHub](https://github.com/Mentra-Community/MentraOS-2)
