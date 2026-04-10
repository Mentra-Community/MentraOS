# Spec: Auto Auth Middleware in MiniAppServer

**Status:** Already implemented. See findings below.

## Overview

**What this doc covers:** Removing boilerplate from webview authentication by having MiniAppServer apply auth middleware automatically, and deprecating `cookieSecret` in favor of reusing `apiKey`.
**Why this doc exists:** We thought developers had to manually create a `createAuthMiddleware` call. Turns out `AppServer` (the base class of `MiniAppServer`) already does this automatically.
**Who should read this:** SDK developers, anyone building apps with webviews.

## The Problem in 30 Seconds

Setting up authenticated webview routes requires passing the same config values twice:

```typescript
const app = new MiniAppServer({
  packageName: "com.example.myapp",
  apiKey: process.env.API_KEY!,
  port: 3000,
  cookieSecret: process.env.COOKIE_SECRET!,  // extra secret to manage
});

// Same values again:
const authMiddleware = createAuthMiddleware({
  apiKey: process.env.API_KEY!,
  packageName: "com.example.myapp",
  cookieSecret: process.env.COOKIE_SECRET!,
});

app.use("/api/*", authMiddleware);
```

This is four config fields and a manual middleware setup for something that should just work.

## Spec

### After this change

```typescript
const app = new MiniAppServer({
  packageName: "com.example.myapp",
  apiKey: process.env.API_KEY!,
  port: 3000,
});

// Auth middleware is applied automatically. Just use getMentraAuth(c).
app.get("/api/me", (c) => {
  const auth = getMentraAuth(c);
  return c.json({ userId: auth.userId });
});
```

Two config fields. No `cookieSecret`. No `createAuthMiddleware`. No `app.use(authMiddleware)`.

### Changes

**1. MiniAppServer applies auth middleware automatically in the constructor.**

If the server has an `apiKey` (which it always does), it creates and applies the auth middleware to all routes during construction. The `apiKey` is used as the cookie signing secret.

```typescript
// Inside MiniAppServer constructor
const authMiddleware = createAuthMiddleware({
  apiKey: config.apiKey,
  packageName: config.packageName,
  cookieSecret: config.cookieSecret || config.apiKey,
});
this.use(authMiddleware);
```

**2. Deprecate `cookieSecret` in MiniAppServerConfig.**

`cookieSecret` becomes optional and deprecated. If not provided, `apiKey` is used as the cookie signing secret. If provided, it overrides `apiKey` for backward compat.

The API key is already a secret that only the developer has. There is no security reason to require a separate cookie signing key.

```typescript
interface MiniAppServerConfig {
  packageName: string;
  apiKey: string;
  port?: number;
  /** @deprecated Use apiKey instead. If not provided, apiKey is used as the cookie signing secret. */
  cookieSecret?: string;
}
```

**3. `createAuthMiddleware` stays exported.**

It remains available for advanced use cases (applying auth to only specific routes, using custom options). But the docs teach the auto path. Most developers never need to call it.

**4. `getMentraAuth(c)` works on any route without setup.**

Since the middleware is applied globally, `getMentraAuth(c)` returns the auth context on every route. If the user isn't authenticated, `auth.userId` is `null`. No middleware application needed per-route.

### Backward Compatibility

- Existing apps that pass `cookieSecret` continue to work. The value overrides `apiKey` for signing.
- Existing apps that call `createAuthMiddleware` manually continue to work. The auto middleware and manual middleware coexist (the manual one just re-validates the same cookie).
- Apps that don't use webviews are unaffected. The middleware runs but `getMentraAuth(c)` returns `{ userId: null }` when no token is present.

### What about apps that don't want auth on every route?

The auto middleware doesn't block requests. It just reads the cookie/token if present and makes `getMentraAuth(c)` available. Unauthenticated requests still pass through. It's the route handler's job to check `auth.userId` and return 401 if needed.

This is the same behavior as the current manual middleware — it doesn't reject requests, it just populates the auth context.

## Finding: Already Implemented

On investigation, `AppServer` (the base class that `MiniAppServer` extends) already does everything this spec proposes:

**File:** `cloud/packages/sdk/src/app/server/index.ts`

Line 183-190 in the `AppServer` constructor:

```typescript
this.use(
  "*",
  createAuthMiddleware({
    apiKey: this.config.apiKey,
    packageName: this.config.packageName,
    getAppSessionForUser: (userId: string) => {
      return this.activeSessionsByUserId.get(userId) || null;
    },
    cookieSecret: this.config.cookieSecret || this.config.apiKey,
  }),
);
```

What's already true:
- Auth middleware is applied globally to all routes (`"*"`)
- `cookieSecret` is optional (line 93: `cookieSecret?: string`)
- When not provided, it defaults to `apiKey` (line 189: `this.config.cookieSecret || this.config.apiKey`)
- `getMentraAuth(c)` works on every route without any setup
- `createMentraAuthRoutes` is also set up automatically (line 1031)

This means developers can already do:

```typescript
const app = new MiniAppServer({
  packageName: "com.example.myapp",
  apiKey: process.env.API_KEY!,
  port: 3000,
});

// Auth just works. No createAuthMiddleware call needed.
app.get("/api/me", (c) => {
  const auth = getMentraAuth(c);
  return c.json({ userId: auth.userId });
});
```

## What still needs to happen

1. **Update the docs.** The webview-authentication.mdx page still shows the manual `createAuthMiddleware` pattern. It should show the simple path (just use `getMentraAuth(c)`, auth is already set up).
2. **Add `@deprecated` JSDoc to `cookieSecret` in `MiniAppServerConfig`.** It works but is unnecessary since `apiKey` is used as the default.
3. **Update the migration guide** to note that auth middleware is automatic.

## Decision Log

| Decision | Alternatives considered | Why we chose this |
|----------|------------------------|-------------------|
| Use apiKey as cookie signing secret | Keep separate cookieSecret, generate a random secret at startup | apiKey is already a secret the developer manages. Adding another secret is unnecessary config. Random secret would invalidate cookies on restart. |
| Apply auth middleware globally | Apply only to /api/* or /webview/* | Global is simpler. The middleware is lightweight (reads one cookie/header). No reason to skip it. Developers check auth in their handlers, not at the middleware level. |
| Keep createAuthMiddleware exported | Remove it entirely | Some developers may want custom auth behavior or to apply it selectively. Keep it as an escape hatch. |
| Deprecate cookieSecret, don't remove | Remove immediately | Existing apps use it. Removing would break them. Deprecate with a console warning, remove in v3.1. |