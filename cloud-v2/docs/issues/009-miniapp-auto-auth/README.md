# 009 - Miniapp Auto Auth

## Problem

Local miniapps can have their own backend services, but those backends currently
cannot know which Mentra user is calling them unless the miniapp invents its own
login. Passing the phone's Core access token into the miniapp would solve
identity at the cost of leaking a powerful host credential into developer code.
That is not acceptable.

The runtime must give each miniapp only a short-lived token scoped to that
miniapp's own package name.

## Goals

1. Miniapp code can call `session.auth.getToken()` or `session.auth.fetch(...)`.
2. The token exposed to the miniapp is audience-scoped to the miniapp package
   name, for example `aud = "com.mentra.local-merge"`.
3. Core/runtime access tokens stay inside the trusted host/cloud-client layer.
4. Miniapp backends can verify the token with Core's public JWKS endpoint.
5. Runtime-only deployments keep working; they simply do not provide
   Core-backed miniapp backend auth unless the host supplies an equivalent
   miniapp token provider.

## Non-goals

1. Do not expose Core tokens, runtime tokens, refresh tokens, or subject tokens
   to miniapp JavaScript.
2. Do not require a second login inside a local miniapp.
3. Do not block all local miniapps from connecting forever when Core is slow or
   unavailable.

## Protocol

`CONNECT_ACK` may include:

```ts
auth?: {
  mentraUserId: string
  tenantId?: string
  token: string
  expiresAt: number
}
```

The host may also push:

```ts
{
  type: "miniapp_auth_update",
  auth: {
    mentraUserId: string
    tenantId?: string
    token: string
    expiresAt: number
  }
}
```

`expiresAt` is Unix milliseconds on the client SDK surface. Core may return
Unix seconds or milliseconds; the host adapter normalizes before sending to the
miniapp.

## Host Boundary

The mobile host owns `cloudClient.auth.getMiniappToken(packageName)`. The island
runtime receives only a narrow `miniappAuth.getToken(packageName)` adapter. The
island runtime does not read the legacy `core_token` setting for local miniapp
identity and does not pass any Core credential to `CONNECT_ACK`.

## SDK Surface

Background miniapps get:

```ts
await session.auth.getToken()
session.auth.getAuthHeader()
await session.auth.fetch("https://backend.example.com/api", {
  method: "POST",
  body: JSON.stringify(payload),
})
session.auth.onUpdate((auth) => ...)
```

`session.auth.fetch` attaches `Authorization: Bearer <miniapp token>` and leaves
all other request options intact.

## Backend Verification

Most miniapp backends should use `@mentra/auth`:

```ts
import {createMentraAuth, type MentraAuthVariables} from "@mentra/auth"
import {Hono} from "hono"

const mentraAuth = createMentraAuth({packageName: "com.example.miniapp"})
const app = new Hono<{Variables: MentraAuthVariables}>()

app.use("/api/*", mentraAuth.hono())

app.post("/api/endpoint", async (c) => {
  const auth = c.get("mentraAuth")
  return c.json({userId: auth.mentraUserId})
})
```

The helper verifies:

1. `Authorization: Bearer <token>` exists.
2. JWT signature verifies against the configured JWKS.
3. `iss === "cloud-core"` by default.
4. `aud === <this backend packageName>`.
5. `exp` has not passed.
6. `sub` is present and becomes the Mentra user id.

`@mentra/auth` defaults to the production Core JWKS:
`https://core.mentraglass.com/.well-known/jwks.json`. Local, staging, test, or
self-hosted deployments can pass `jwksUrl` or set `MENTRA_AUTH_JWKS_URL`.

## First Implementation Target

Local Merge is the first protected backend:

1. Mobile mints `com.mentra.local-merge` miniapp tokens through cloud-client.
2. Local Merge miniapp calls backend through `session.auth.fetch`.
3. Local Merge backend rejects unauthenticated or wrong-audience calls.

## Test Matrix

1. Missing `Authorization` header returns `401`.
2. Wrong `aud` returns `401`.
3. Valid miniapp token lets Local Merge create an insight.
4. Miniapp starts even if Core token minting is slow; auth arrives later via
   `miniapp_auth_update`.
5. Local captions and local translation still connect without backend auth.
