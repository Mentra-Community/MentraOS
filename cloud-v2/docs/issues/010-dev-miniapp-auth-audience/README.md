# 010 - Dev Miniapp Auth Audience

**Status:** Draft

## Problem

Dev miniapps use a single host runtime slot, `com.dev`, so the mobile app can
route one live development bundle consistently. That runtime slot is useful for
foregrounding, WebView lifecycle, hot reload, and dev server bridge routing.

Miniapp backend auth has a different requirement: the token audience must be the
real miniapp package name that owns the backend, such as
`com.mentra.local-merge`.

Those two identities are currently easy to confuse:

1. Local Merge declares `packageName = "com.mentra.local-merge"` in
   `miniapp.json`.
2. The scanner registers the dev bundle into the single host slot `com.dev`.
3. The host mints a miniapp token for `com.dev`.
4. Local Merge backend verifies `aud = "com.mentra.local-merge"`.
5. The backend rejects the request, and the miniapp reports
   "Insight request failed".

The immediate bug is a wrong-audience token. The deeper risk is that simply
switching auth to use the manifest's package name could let a dev bundle claim
any package name unless the host treats that package name as a trusted local
dev grant.

## Why This Matters

Miniapp tokens are intentionally less powerful than Core/runtime tokens, but
they still authenticate a user to a miniapp backend. A malicious or mistaken dev
bundle should not be able to claim another miniapp's package name and receive a
token that another backend accepts.

The security boundary is:

- miniapp JavaScript may call `session.auth.getToken()` and `session.auth.fetch`.
- miniapp JavaScript must not choose the token audience.
- the trusted host decides the audience from an installed package record or an
  explicit dev registration record.

## Package Ownership Trust Model

Package-name trust depends on where the miniapp came from.

### Released / installed miniapps

For released miniapps, package ownership should come from Core / Developer
Console records. A developer account owns an app record with a package name, and
Core uses that app record when minting miniapp tokens. The mobile host should
trust package names from the install/store registry path, not from arbitrary
bundle JavaScript.

In this mode, a backend can rely on:

1. Core only minted the token after checking the app/package record.
2. The token audience is the registered package name.
3. The backend verifies `aud === its packageName`.

### Local dev miniapps

For local dev miniapps, a manifest package name is not global proof of
ownership. A dev bundle can write any `packageName` into `miniapp.json`, so the
host must treat that value as a local dev claim created by a user action
(scanning a QR code or entering a dev URL), not as proof that the developer owns
that package in Core.

This means the dev path needs a different trust model:

1. The host may store `sourcePackageName` from the scanned manifest as a local
   dev registration grant.
2. That grant can be used to route auth for the current dev session, but it
   should not be treated as permanent/global package ownership.
3. Core and/or the host should avoid minting normal production-looking tokens
   for arbitrary dev claims without a policy decision.
4. Dev tokens may need a `dev: true` / `mode: "dev"` claim, short TTL, origin
   metadata, or other constraints so production backends can reject them if
   desired.

Open concern: if Core currently mints a miniapp token for any package name the
mobile host requests, then a dev bundle could claim another package name and get
an audience token for that package. That must be reviewed before using
`sourcePackageName` as the dev auth audience.

## JWT Vocabulary Refresher

The JWT vocabulary is easy to mix up, so this issue uses the standard terms
alongside our friendlier names.

| JWT field | Standard meaning | Our meaning |
| --- | --- | --- |
| `iss` | issuer | The service/authority that minted and signed the token, such as Core or an OEM issuer |
| `sub` | subject | The user identity; in our system this maps to `mentraUserId` / `users._id` |
| `aud` | audience | The intended recipient of the token; for miniapp tokens this should be the miniapp `packageName` |
| `exp` | expiration time | When the token dies |
| `iat` | issued-at time | When the token was minted |
| `jti` | JWT id | Unique token id for tracking, replay defense, or revocation |
| `kid` | key id in JWT header | Which public key in the JWKS verifies this token |

Our naming:

- `mentraUserId` is the application-level name for JWT `sub`.
- `tenantId` is our tenant/OEM claim, not a standard JWT claim.
- `packageName` is the application-level name for JWT `aud` on miniapp tokens.
- `issuer` is JWT `iss`.
- JWKS is the public key set a backend fetches to verify token signatures.

## Auto Auth E2E Shape

Miniapp auto auth lets a miniapp backend know which user is calling it without
making the miniapp implement login and without leaking Core/runtime credentials
to miniapp JavaScript.

The intended flow:

1. The user signs into the mobile app through the normal Mentra/OEM auth path.
2. The mobile app/cloud-client gets Core/runtime credentials through the trusted
   host layer.
3. A miniapp starts inside the local runtime.
4. The runtime asks the host for miniapp auth for that miniapp.
5. The host/cloud-client asks Core to mint a miniapp token.
6. Core mints a short-lived JWT:
   - `iss`: `cloud-core` by default
   - `sub`: the Mentra user id
   - `aud`: the miniapp package name, for example `com.mentra.local-merge`
   - `exp`: short expiry
   - optional/custom claims: `tenantId`, `jti`, etc.
7. The runtime passes only that miniapp token into the miniapp session via
   `CONNECT_ACK` and later `AUTH_UPDATE` refreshes.
8. The miniapp calls its backend with `session.auth.fetch(...)`.
9. The backend verifies the JWT with `@mentra/auth`, usually through
   `app.use("/api/*", mentraAuth.hono())`:
   - signature matches Core's JWKS,
   - `iss` is trusted,
   - `aud` equals that backend's package name,
   - `exp` is still valid,
   - `sub` exists and becomes the backend's user id.

The important safety rule is that the miniapp may use `session.auth`, but it
does not choose the `aud`. The host owns that decision.

## Desired Model

Separate the identities explicitly:

| Identity | Example | Owned by | Used for |
| --- | --- | --- | --- |
| Runtime package | `com.dev` | host dev runtime | foregrounding, WebView lifecycle, dev bridge routing |
| Auth audience package | `com.mentra.local-merge` | trusted install/dev registration | miniapp backend token `aud` |

For installed or released miniapps, the runtime package and auth audience are
normally the same package name.

For dev miniapps, the runtime package may remain `com.dev`, but the auth
audience should come from the host-owned dev registration record created when
the user scans or enters the dev server URL.

## Constraints

1. Do not expose Core access tokens, runtime tokens, refresh tokens, or subject
   tokens to miniapp JavaScript.
2. Do not let miniapp JavaScript request arbitrary token audiences.
3. Keep `session.auth.fetch(...)` audience-implicit.
4. Keep the single dev runtime slot if it is still needed for stable dev
   lifecycle routing.
5. Preserve backend verification: backends should continue checking
   `aud === their packageName`.

## Candidate Fix

When the island runtime asks the host for miniapp auth:

1. If the runtime package is an installed/released package, mint the token for
   that same package.
2. If the runtime package is `com.dev`, resolve the trusted dev registration
   record.
3. Use the registration's `sourcePackageName` as the token audience only when
   it came from the host's dev scan / dev URL flow.
4. Return the token to the dev miniapp session without exposing any way for the
   miniapp to override the audience.

The dev registration record may also need to store enough context to review or
constrain the grant:

- `sourcePackageName`
- `devUrl`
- `devPort`
- scanned/registered timestamp
- optional local dev session id

## Open Questions

1. Should dev miniapp tokens include a `dev: true` or `mode: "dev"` claim?
2. Should Core enforce a separate policy for dev-token minting, or is host-side
   dev-mode gating enough?
3. Should developer backends be able to reject dev tokens in production?
4. Should the token include the dev origin, such as `devUrl`, so a backend can
   audit where the bundle came from?
5. Should the dev grant expire or be cleared when the app restarts, the dev URL
   changes, or the user scans another dev app?
6. How do we make this work for OEM-hosted runtime-only deployments that supply
   their own miniapp token provider?

## Observed Repro

Observed while running Local Merge as a dev miniapp:

1. Start Local Merge through `mentra-miniapp dev`.
2. Scan the dev QR in the mobile app.
3. Speak enough text for Merge to request an insight.
4. UI shows "Insight request failed".
5. Phone logs show the host minted the token for the dev slot:

```text
cloudClient: debug: minted miniapp token {"packageName":"com.dev"}
```

6. Local Merge backend expects:

```text
aud = "com.mentra.local-merge"
```

Expected result after the fix:

- Runtime still routes the live dev app as `com.dev`.
- Auth token audience is `com.mentra.local-merge`.
- The backend accepts the token and can create an insight.

## Related Docs

- [009 - Miniapp Auto Auth](../009-miniapp-auto-auth/)
- [001 Cloud Core Auth Spec](../001-cloud-core/auth/spec.md)
- [004 Cloud Client Architecture](../004-cloud-client/architecture.md)
