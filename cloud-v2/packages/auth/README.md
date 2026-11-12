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

`session.workspaceRole` is the person's role in that workspace: `member`,
`developer`, `admin` or `owner`. Use it to show an admin what a member doesn't
see, such as everyone's records instead of their own. It is `null` whenever
`workspaceId` is, and for tokens from a Core that doesn't name roles yet, so
treat `null` as the least privilege.

`session.workspaceName` is that workspace's name, for showing the person which
workspace they are in. It is `null` whenever `workspaceId` is, and when Core
couldn't read it in time or doesn't send it yet, so show something else then and
never decide anything by it.

`session.clientId` is set when the token came from a website the person signed
in to with their Mentra account (Sign in with Mentra), and `null` when it came
from the Mentra App. It is the same person and the same `mentraUserId` either
way, so both reach the same records. Use it to decide what a website may do:
for example, answer `403` on a route that only the miniapp on the phone should
call.

## Bind your backend to its Core

Set `MENTRA_CORE_URL` to the public URL of the one Core your backend serves,
such as `https://core.mentraglass.com`, or pass it as `coreUrl`:

```ts
const mentraAuth = createMentraAuth({
  packageName: "com.example.miniapp",
  coreUrl: "https://core.mentraglass.com",
  requireCoreUrl: true,
});
```

Only that Core's key set (`<coreUrl>/.well-known/jwks.json`) is tried, and a
token's `iss` must name that Core (a Core whose `CLOUD_CORE_ISSUER` is its
origin names itself by it), or be the default `cloud-core`, from that same key
set. A token from any other
Core is refused, even for the same user: one sign-in account works on every
Mentra Core, so trusting several Cores lets a development Core's token act for
a production user.

The Core URL must be an origin (no path). It replaces `jwksUrl`, `jwksUrls` and
`issuer` and their environment variables: a verifier given a Core and any of
them refuses to start (`invalid_configuration`) rather than pick one.
`requireCoreUrl: true` also refuses to start without a Core, instead of falling
back to the settings below; Mentra's own backends set it. `mentraAuth.coreUrl`
is the bound Core's origin. See [CORE-BINDING.md](CORE-BINDING.md).

Defaults without a Core (deprecated: bind to your Core instead):

- `packageName`: required, or set `MENTRA_PACKAGE_NAME`, `MINIAPP_PACKAGE_NAME`, or `PACKAGE_NAME`.
- JWKS URLs (the Core key sets whose tokens are accepted): the `jwksUrls` option, then the `jwksUrl` option, then `MENTRA_AUTH_JWKS_URLS` as a comma-separated list, then `MENTRA_AUTH_JWKS_URL` as one value, falling back to `MENTRA_JWKS_URLS`, the key sets of the Mentra Cores for prod, staging, dev and debug.
- `issuer`: `MENTRA_AUTH_ISSUERS` as a comma-separated list, or `MENTRA_AUTH_ISSUER` as one value, falling back to `cloud-core`. A key set served at `<origin>/.well-known/jwks.json` also accepts its own Core's name, `<origin>`, which a Core puts in its tokens when its `CLOUD_CORE_ISSUER` is its origin.
- `keyIds`: the accepted key IDs, `["mentra-miniapp-1"]`. Core's key set also publishes the keys of its other tokens, and a token under any other key ID is refused, as is a token with a `typ` other than `JWT`.
- `allowLocalBuilds`: `false`, or `true` when `MENTRA_AUTH_ALLOW_LOCAL_BUILDS=true`. See [Local builds](#local-builds).

The token is tried against each key set in order, and the first whose key verifies its signature wins: the Mentra Cores reuse the same key ID with different keys, so the key ID alone doesn't say which Core signed. A token rejected for its claims (expired, or the wrong audience or issuer) is refused at once and isn't tried against the rest. An explicit `jwksUrl`, or a single URL in `MENTRA_AUTH_JWKS_URL`, tries that one key set only.

For local, staging, test, or self-hosted Core deployments, bind to that Core:

```ts
const mentraAuth = createMentraAuth({
  packageName: "com.example.miniapp",
  coreUrl: "http://localhost:3000",
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
are honored from every key set the verifier trusts. A backend bound to its Core
honors only that Core's features and refuses a token from any other; an unbound
one, by default, honors every Mentra Core's. There is no feature setting. A token with no
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
| `invalid_configuration` | The verifier is misconfigured, such as a missing `packageName`, a Core URL that isn't an origin, a Core beside the JWKS or issuer settings it replaces, or no Core with `requireCoreUrl`. |
