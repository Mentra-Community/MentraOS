# SDK Hono Architecture

## Current System

```
AppServer (816 lines)
    └── Express App
          ├── express.json()
          ├── cookie-parser
          ├── createAuthMiddleware
          ├── multer (photo-upload)
          └── express.static()
```

Express touch points in SDK:
| File | Usage |
|------|-------|
| `src/app/server/index.ts` | Main server, routes, middleware (lines 7, 133-134, 408, 488, 588) |
| `src/app/webview/index.ts` | Auth middleware types (line 3) |
| `src/types/index.ts` | `AuthenticatedRequest extends express.Request` (lines 140-146) |

### LiveCaptionsOnSmartGlasses Pattern

```
User → Express :3333 → Bun :3334
         ├── /webhook (Express handles)
         ├── /api/transcripts/stream (Express handles, SSE)
         └── /* (proxy to Bun)
                  ├── React webview
                  └── /api/* routes
```

Problems:

1. Two servers, two ports
2. Manual proxy (~50 lines)
3. Auth header forwarding
4. SSE bypass logic

---

## Proposed System

```
AppServer extends Hono
    └── Developer calls Bun.serve()
          ├── routes: { "/*": webview.html }  → Bun handles webview
          └── fetch: app.fetch                → Hono handles API
```

Single server handles everything:

```
User → Bun.serve :3333
         ├── routes (HTML imports) → React + HMR
         └── fetch (Hono)
               ├── /webhook
               ├── /tool
               ├── /health
               ├── /settings
               ├── /photo-upload
               ├── /mentra-auth
               └── /api/* (custom)
```

### Key Changes

1. **AppServer extends Hono** instead of wrapping Express
2. **`Bun.serve()`** with `routes` + `fetch` hybrid
3. **Hono middleware** replaces Express middleware
4. **TypeScript generics** for typed context variables

---

## Implementation Details

### AppServer Class

```typescript
// src/app/server/index.ts
import { Hono, Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"

export interface AuthVariables {
  authUserId?: string
  activeSession: AppSession | null
}

export class AppServer extends Hono<{ Variables: AuthVariables }> {
  constructor(private config: AppServerConfig) {
    super()
    this.use("*", createAuthMiddleware({...}))
    this.setupWebhook()
    // ... setup other SDK endpoints
  }

  async start(): Promise<void> {
    this.logger.info(`🎯 App initialized: ${this.config.packageName}`)
    // SDK doesn't manage Bun.serve anymore (Option C)
  }
}
```

### Auth Middleware

```typescript
// src/app/webview/index.ts
import { Context, Next } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  return async (c: Context, next: Next) => {
    // Check signed user token
    const signedUserToken = c.req.query("aos_signed_user_token")
    if (signedUserToken) {
      const userId = await verifySignedUserToken(signedUserToken)
      if (userId) {
        c.set("authUserId", userId)
        setCookie(c, cookieName, signSession(userId, secret), cookieOptions)
        return next()
      }
    }

    // Check temp token
    const tempToken = c.req.query("aos_temp_token")
    if (tempToken) {
      const { userId } = await exchangeToken(...)
      c.set("authUserId", userId)
      setCookie(c, cookieName, signSession(userId, secret), cookieOptions)
      return next()
    }

    // Check session cookie
    const sessionCookie = getCookie(c, cookieName)
    if (sessionCookie) {
      const userId = verifySession(sessionCookie, secret)
      if (userId) {
        c.set("authUserId", userId)
        return next()
      }
      deleteCookie(c, cookieName)
    }

    await next()
  }
}
```

### Photo Upload (multer replacement)

```typescript
// Hono handles multipart natively
this.post("/photo-upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body.photo as File;

  if (!file) {
    return c.json({ success: false, error: "No photo" }, 400);
  }

  const buffer = await file.arrayBuffer();
  const photoData = {
    buffer: Buffer.from(buffer),
    mimeType: file.type,
    filename: file.name,
    size: file.size,
  };

  // ... handle photo
  return c.json({ success: true });
});
```

### Example App Usage

```typescript
// Apps/LiveCaptionsOnSmartGlasses/src/index.ts
import {serve} from "bun"
import {AppServer} from "@mentra/sdk"
import {api} from "./api"
import webview from "./webview/index.html"

const app = new AppServer({ ... })
await app.start()

// Mount API routes (Hono sub-app pattern)
app.route("/", api)

// Developer controls Bun.serve directly (Option C)
serve({
  port: 3333,
  routes: { "/*": webview },
  fetch: app.fetch,
})
```

---

## Migration Strategy

### Phase 1: Core Refactor

1. Replace Express imports with Hono
2. Refactor middleware to Hono pattern
3. Update types (AuthVariables instead of AuthenticatedRequest)

### Phase 2: AppServer Extends Hono

1. Change class signature
2. Move route handlers to constructor
3. Implement `start()` with `Bun.serve()`

### Phase 3: Bun Fullstack Integration

1. Add `setWebview()` method
2. Implement routes + fetch hybrid
3. Development mode HMR

### Phase 4: Package Updates

1. Remove: express, cookie-parser, multer, @types/express
2. Add: hono
3. Update build externals

---

## API Comparison

| Express                              | Hono                          |
| ------------------------------------ | ----------------------------- |
| `app.use(express.json())`            | Built-in                      |
| `app.get(path, (req, res) => {...})` | `app.get(path, (c) => {...})` |
| `res.json(data)`                     | `return c.json(data)`         |
| `res.status(code).json(data)`        | `return c.json(data, code)`   |
| `req.body`                           | `await c.req.json()`          |
| `req.query.param`                    | `c.req.query("param")`        |
| `req.cookies.name`                   | `getCookie(c, "name")`        |
| `res.cookie(...)`                    | `setCookie(c, ...)`           |
| `req.authUserId` (custom property)   | `c.get("authUserId")`         |

---

## Open Questions

1. **Error handling pattern?**
   - Express: `next(error)` + error middleware
   - Hono: `app.onError((err, c) => {...})`
   - **Decision**: Use Hono's built-in

2. **Logging integration?**
   - Current: pino logger on AppServer
   - Keep same pattern, just update method references
