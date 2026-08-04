# Cloud Core Auth: v2 API spec

**TL;DR:** The v2 Core auth contract: the endpoints and token shapes the
cloud-client and developer backends build against for Core-owned APIs. Every actor
(OEM user, Mentra user, miniapp) can obtain a Core credential via RFC 8693 token
exchange; a miniapp gets a short-lived audience-pinned token derived from that
Core-backed path. Runtime live services are split onto a separate
`cloud-runtime` audience token in
[`../../007-runtime-auth-independence/README.md`](../../007-runtime-auth-independence/README.md).
This doc is endpoints + token shapes only.

New here? Read [`README.md`](./README.md) for the map and [`concepts.md`](./concepts.md)
for the from-zero primer. The mechanisms behind these endpoints live in the sibling
docs and are referenced, not duplicated:

- OEM onboarding, key registration, subject-token verification, replay protection:
  [`oem-auth.md`](./oem-auth.md).
- `mentraUserId`, the audiences, and the v1 to v2 migration bridge:
  [`design.md`](./design.md#identity-model).
- The end-to-end miniapp auto-auth flow and dev-backend verification:
  [`design.md`](./design.md#miniapp-auto-auth).

## Path and caller convention

Core serves several audiences, so its routes are grouped by **caller**, with the
product implied by the domain (no version segment; a future break would take
`/api/v2/...`):

- `/api/client/...` endpoints the **mobile client / device** calls. The same
  routes serve an OEM's client and Mentra's client; the **subject token**
  distinguishes them, not the path.
- `/api/oem/...` endpoints the **OEM's backend** calls, server to server
  (registration, public-key management). The mobile client does not hit these.
- `/api/console/...`, `/api/store/...` website backends.
- `/.well-known/jwks.json` at the root (standard).

## Tokens

### Core access token

Ed25519 JWT, signed with the **access-token key**. Claims: `sub = mentraUserId`,
`tenantId`, `sessionId`, `jti`, `aud = "cloud-core"`, `iss`, `exp` (1h). The
device's credential to Core-owned APIs. Held by the cloud-client, **never** given
to a miniapp.

### Runtime token

Separate JWT with `aud = "cloud-runtime"` for Runtime Services. In
Mentra-hosted deployments, Core/Auth can mint or broker this token after verifying
the OEM subject token. In OEM-hosted deployments, the runtime may trust an OEM
issuer/JWKS directly and Core is not required for live services. The runtime token
contract is tracked in issue 007.

### Miniapp-scoped token

Ed25519 JWT, signed with a **separate miniapp-token key**. Claims:
`sub = mentraUserId`, `tenantId`, `aud = <packageName>`, `iss = "cloud-core"`,
`iat`, `exp` (configurable, default 1h), `jti`. Audience-pinned to one miniapp;
only ever valid against that miniapp's developer backend, which verifies it via
JWKS. This is the only token a miniapp ever holds.

## Endpoints

### `POST /api/client/auth/exchange`

RFC 8693 token exchange. The mobile client presents a subject token and gets back
Core-backed tokens. `subject_token_type` selects the verification path:

| subject token | verified with | `tenantId` | `tenantUserId` |
| --- | --- | --- | --- |
| OEM-signed JWT | the OEM's registered public key | `iss` | `sub` |
| Mentra core token (transition) | shared `AUGMENTOS_AUTH_JWT_SECRET` (HS256) | `"mentra"` | core token `sub` (the Supabase sub) |
| Mentra Supabase session (end state) | `SUPABASE_JWT_SECRET` | `"mentra"` | `sub` |

Maps `(tenantId, tenantUserId)` to the user's `_id` (the `mentraUserId`), creating the
record on first sight. Returns `{ access_token, refresh_token, token_type,
expires_in }`, where `access_token` is the Core access token unless a future
response explicitly asks for a runtime token. Verification details, supported
algorithms, and `jti` replay protection are in [`oem-auth.md`](./oem-auth.md).

### `POST /api/client/auth/refresh`

`grant_type=refresh_token`. Returns a new Core access token and a **rotated**
refresh token (the old one is invalidated). The OEM backend is not in this path.

### `POST /api/client/auth/miniapp-token`

```
Authorization: Bearer <cloud-core token>
{ "packageName": "com.dev.app" }
->  { "token": "<ed25519 jwt>", "expiresAt": <unix seconds> }
```

Verifies the Core token, reads `mentraUserId` + `tenantId`, and mints the
miniapp-scoped token with `aud = packageName`. **No install or entitlement
check**: a valid Core token plus the requested packageName is sufficient, and
the on-device Runtime enforces that a bundle can only request its own packageName.
TTL is configurable (default 1h) so tests can shorten it. This is what
`cloud.auth.getMiniappToken` calls.

### `POST /api/client/auth/runtime-token`

```
Authorization: Bearer <cloud-core token>
->  { "access_token": "<cloud-runtime jwt>", "token_type": "Bearer", "expires_in": 900 }
```

Verifies the Core token, reads `mentraUserId` + `tenantId`, and mints a short-lived
Runtime token with `aud = "cloud-runtime"`. Hosted-Core CloudClient mode uses
this endpoint explicitly via `auth.runtime = { source: "core" }`. Runtime
Services verify the token locally against their configured issuer/JWKS list.

### `GET /.well-known/jwks.json`

Publishes Mentra's public keys in JWK form, each with a `kid`. Developer backends
fetch it to verify miniapp tokens; Core services verify Core access tokens the
same way. Runtime token verification is deployment-configured in issue 007.

## Signing keys

**Two Ed25519 keys**, each with its own `kid`: one for access tokens, one for
miniapp tokens. Keeping them separate limits the damage if one leaks: a problem with
the miniapp-token key can't touch access tokens. Both public halves are published in
the JWKS.

**Rotation** (from day one): to rotate a key, publish the new key in the JWKS
alongside the old one and keep the old until every token signed with it has
expired, then drop it. Verifiers select the key by `kid` automatically, so no
client coordination is needed.

## How the cloud-client uses this

- In Core-backed mode, constructed with a **subject token** (the OEM-minted JWT,
  or the Mentra core token), or a `getSubjectToken()` callback. It calls
  `/exchange` to get Core access + refresh tokens and owns refresh via `/refresh`.
- Runtime uses its own `cloud-runtime` token provider. Hosted deployments may
  source that provider through Core/Auth; runtime-only deployments do not need a
  Core endpoint.
- Calls `/miniapp-token` per running miniapp's packageName, caches per package,
  and re-mints before expiry. It hands the miniapp only the miniapp-scoped token.
- Developer backends (not the client) fetch the JWKS to verify.

## In scope this week vs not

This auth slice is needed for the cloud-client, so it is specced now. The rest of
cloud-core (miniapp-service, storage-service, console, store) is next week.
