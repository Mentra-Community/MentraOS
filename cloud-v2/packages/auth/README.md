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

`session.workspaceId` is the person's workspace, but only when that workspace
assigned your miniapp through Fleet; for every other miniapp it is `null`, so a
miniapp never learns which workspace someone belongs to unless the workspace
chose it. A company's miniapp can use it to admit exactly its own workspace's
members.

Defaults:

- `packageName`: required, or set `MENTRA_PACKAGE_NAME`, `MINIAPP_PACKAGE_NAME`, or `PACKAGE_NAME`.
- JWKS URLs (the Core key sets whose tokens are accepted): the `jwksUrls` option, then the `jwksUrl` option, then `MENTRA_AUTH_JWKS_URLS` as a comma-separated list, then `MENTRA_AUTH_JWKS_URL` as one value, falling back to `MENTRA_JWKS_URLS`, the key sets of the Mentra Cores for prod, staging, dev and debug.
- `issuer`: `MENTRA_AUTH_ISSUERS` as a comma-separated list, or `MENTRA_AUTH_ISSUER` as one value, falling back to `cloud-core`.
- `keyIds`: the accepted key IDs, `["mentra-miniapp-1"]`. Core's key set also publishes the keys of its other tokens, and a token under any other key ID is refused, as is a token with a `typ` other than `JWT`.
- `allowLocalBuilds`: `false`, or `true` when `MENTRA_AUTH_ALLOW_LOCAL_BUILDS=true`. See [Local builds](#local-builds).

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

## Local builds

A miniapp installed from a local-network address (a developer's own machine)
has no domain to vouch for its package name, so it could claim any name,
yours included. Core marks the tokens it mints for such a build, and this
package refuses them unless the backend allows local builds: a verification
fails with a `MentraAuthError` whose `code` is `local_build_not_allowed`.

Allow them only on your development backend, by setting this in that
deployment's environment and nowhere else:

```bash
MENTRA_AUTH_ALLOW_LOCAL_BUILDS=true
```

or with `createMentraAuth({packageName, allowLocalBuilds: true})` in code that
only your development backend runs. The option wins over the environment, and
only the value `true` turns it on: anything else, or nothing, refuses local
builds. On a backend that allows them, `session.localBuild` is `true` for a local
build's token, and its `workspaceId` is always `null`.

## Private miniapps

A miniapp's server can decide who gets its `miniapp.json` and ZIPs, the way a
website decides who gets its pages. `miniappFiles` gates them behind a Mentra
sign-in:

```ts
import {serveStatic} from "hono/bun";

app.use(
  "/tools/*",
  mentraAuth.miniappFiles({
    authorize: (session) => session.workspaceId === "ws_your_workspace",
  }),
);
app.use("/tools/*", serveStatic({root: "./public"}));
```

- A request without a bearer token, or with one that doesn't verify (an expired
  token included), gets `401` with the sign-in challenge
  `WWW-Authenticate: Bearer realm="mentra", package="<packageName>"`. The
  Mentra App answers it with a token for that package, and only for it, and
  retries.
- A token `authorize` refuses gets `403`. Only `true` admits a request; an
  error thrown by `authorize` propagates, and the files are not served.
- A local build's token on a backend that doesn't allow local builds also
  gets `403`.
- An admitted request has its verified session on the context (`mentraAuth`,
  or `contextKey`) and goes on to the files. Its response is marked
  `Cache-Control: private` (dropping `public` and `s-maxage`), so a shared
  cache never hands a gated file to someone else. Refusals are `no-store`.

A server that never challenges is public: the Mentra App sends no account,
token or cookie to it. Often the ZIP doesn't need hiding at all; a miniapp
that keeps its secrets in its backend can be an ordinary unlisted miniapp whose
backend checks `workspaceId`. Not on Hono? Verify with `verifyRequest` and
answer `401` with `mentraSignInChallenge(packageName)` as the
`WWW-Authenticate` value.

## Errors

Every refusal is a `MentraAuthError` with a `code`:

| `code` | Meaning |
| --- | --- |
| `missing_token` | No `Authorization: Bearer` header. |
| `invalid_token` | Not a miniapp token this backend accepts: signature, key ID, type, issuer, audience (`packageName`), expiry or subject. |
| `local_build_not_allowed` | A local build's token, on a backend that doesn't allow local builds. |
| `invalid_configuration` | The verifier is misconfigured, such as a missing `packageName`. |
