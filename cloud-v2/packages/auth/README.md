# @mentra/auth

Helpers for miniapp backends that need to verify Local Runtime auto-auth tokens.

```ts
import {createMentraAuth, type MentraAuthVariables} from "@mentra/auth";
import {Hono} from "hono";

const mentraAuth = createMentraAuth({
  packageName: "com.example.miniapp",
});

const app = new Hono<{ Variables: MentraAuthVariables }>();

app.use("/api/*", mentraAuth.hono());

app.post("/api/endpoint", async (c) => {
  const session = c.get("mentraAuth");
  return c.json({userId: session.mentraUserId});
});
```

`session.email` is the user's verified Mentra account email when Core could
resolve one (from the token's `email` + `email_verified` claims). It is absent
for OEM accounts and unverified addresses, and it can change, so key stored data
on `mentraUserId`.

Defaults:

- `packageName`: required, or set `MENTRA_PACKAGE_NAME`, `MINIAPP_PACKAGE_NAME`, or `PACKAGE_NAME`.
- `jwksUrl`: `MENTRA_AUTH_JWKS_URL`, falling back to `https://core.mentraglass.com/.well-known/jwks.json`.
- `issuer`: `MENTRA_AUTH_ISSUERS` as a comma-separated list, or `MENTRA_AUTH_ISSUER` as one value, falling back to `cloud-core`.
- `keyIds`: the accepted key IDs, `["mentra-miniapp-1"]`. Core's key set also publishes the keys of its other tokens, and a token under any other key ID is refused, as is a token with a `typ` other than `JWT`.

Use `jwksUrl` for local, staging, test, or self-hosted Core deployments:

```ts
const mentraAuth = createMentraAuth({
  packageName: "com.example.miniapp",
  jwksUrl: "http://localhost:3000/.well-known/jwks.json",
});
```

Lower-level helpers are available when a framework middleware is not enough:

```ts
await mentraAuth.verifyToken(token);
await mentraAuth.verifyAuthHeader(header);
await mentraAuth.verifyRequest(request);
```
