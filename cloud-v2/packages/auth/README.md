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
- JWKS URLs (the Core key sets whose tokens are accepted): the `jwksUrls` option, then the `jwksUrl` option, then `MENTRA_AUTH_JWKS_URLS` as a comma-separated list, then `MENTRA_AUTH_JWKS_URL` as one value, falling back to `MENTRA_JWKS_URLS`, the key sets of the Mentra Cores for prod, staging, dev and debug.
- `issuer`: `MENTRA_AUTH_ISSUERS` as a comma-separated list, or `MENTRA_AUTH_ISSUER` as one value, falling back to `cloud-core`.
- `keyIds`: the accepted key IDs, `["mentra-miniapp-1"]`. Core's key set also publishes the keys of its other tokens, and a token under any other key ID is refused, as is a token with a `typ` other than `JWT`.

The token is tried against each key set in order, and the first whose key verifies its signature wins: the Mentra Cores reuse the same key ID with different keys, so the key ID alone doesn't say which Core signed. A token rejected for its claims (expired, or the wrong audience or issuer) is refused at once and isn't tried against the rest. An explicit `jwksUrl`, or a single URL in `MENTRA_AUTH_JWKS_URL`, tries that one key set only.

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

## Features

A token also carries the paid features Core granted the user for this miniapp.
`session.features` lists their keys, and `session.hasFeature(key)` is an exact,
case-sensitive match against them:

```ts
app.post("/api/call", async (c) => {
  const session = c.get("mentraAuth");
  if (!session.hasFeature("call.unlimited")) {
    return c.json({error: "feature_required"}, 403);
  }
  // ...
});
```

The features come from the `features` claim of the token that verified, so they
are honored from every key set the verifier trusts. By default that is every
Mentra Core, which suits a backend shared across environments. A Private Cloud
backend configured with its own `jwksUrl` honors only that Core's features and
refuses a token from any other. There is no feature setting. A token with no
`features` claim, or one that isn't a list of strings, has no features.
