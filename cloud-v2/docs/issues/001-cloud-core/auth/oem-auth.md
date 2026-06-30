# OEM auth

**Status:** Implemented (the OEM-JWT exchange mechanics are built in v2 and e2e
verified with `test-oem`; this doc is under review).

**TL;DR:** How an OEM proves who its user is to Mentra, and how Mentra exposes that
user's identity to miniapp backends. An OEM's backend mints a short-lived signed
JWT per user; the client exchanges it (RFC 8693) for Core-backed credentials, and
hosted deployments can derive a normalized `cloud-runtime` token from the same
trust decision. Mentra maps `(tenantId, tenantUserId)` to a `mentraUserId`. The handoff
to miniapp backends carries `tenantId` so developers can set their own trust policy.
This doc carries both the decision (which integration shape and why) and the
implementation (endpoints, data model, token formats, lifecycles, security).

New here? Read [`concepts.md`](./concepts.md) for the from-zero primer (JWTs,
asymmetric signing, JWKS, audiences, token exchange). The consolidated v2 endpoint
and token surface is in [`spec.md`](./spec.md); the cross-cutting identity model
and the Mentra-as-OEM bridge are in [`design.md`](./design.md).

## Problem

Cloud v2 needs an auth model that lets OEMs build their own mobile apps, keep their
own user accounts, and have those users call Mentra's backend services (audio, STT,
TTS, AI, the miniapp store) without signing in to Mentra. v1's auth assumed the
user signs in to Mentra directly.

The work splits into two related but separate decisions:

- **Q1.** How does the OEM prove who its user is, to Mentra?
- **Q2.** How does Mentra expose user identity to miniapp backends?

## Q1: OEM to Mentra auth

A user is signed in to the OEM's mobile app; the OEM's backend knows who they are.
The OEM's app needs to call Mentra's backend and have Mentra know which user is
calling, so state, audio streams, miniapp installs, etc. attach to the right
person.

**Decision: token exchange (the Firebase Custom Auth shape).** The OEM's backend
signs a per-user JWT with a key registered with Mentra at onboarding; the client
exchanges it at Mentra's token endpoint (RFC 8693) for Mentra-issued Core
credentials and, for hosted Runtime, a normalized runtime credential. The SDK then
uses Mentra-issued credentials and refreshes against Mentra where applicable (the
OEM backend is out of the Core refresh path).

Options surveyed and why they lose (the research is in `concepts.md`'s prior-art
note and the git history of this doc):

| Option | Shape | Verdict |
| --- | --- | --- |
| SAML SSO / OIDC SSO / OAuth code | User redirected to a sign-in screen to federate identity | Rejected: assumes a Mentra user-facing UI to redirect from; the OEM owns the user-facing flow, Mentra has no screen |
| Direct-bearer JWT (LiveKit / Twilio / Agora) | OEM JWT used directly as the bearer on every call | Viable but worse: no Mentra-side revocation, OEM downtime becomes session downtime, every service reads OEM-shaped claims |
| **Token exchange (Firebase Custom Auth)** | OEM JWT exchanged once for Mentra tokens | **Chosen**: server-side revocation, refresh independence, Mentra-defined claims, standardized via RFC 8693 |
| Server-to-server registration API | OEM backend calls Mentra with an API key, no JWT crypto | Deferred: functionally equivalent outcome without OEM signing; ship one path for v2, revisit if OEMs want it |

Why token exchange: Mentra controls Core session lifetime (kill the refresh token in
our DB and the session ends), the SDK refreshes against Mentra so OEM downtime
affects only new logins, and hosted services see normalized `mentraUserId` /
`tenantId` claims with no per-request resolution.

## Q2: Mentra to miniapp identity

Today Mentra auto-auths miniapp backends with a stable user identity, which
developers love because their backend just knows who the user is. Under v2, if
users vouched for by an OEM use that same handoff, a miniapp developer is implicitly
trusting every OEM Mentra has approved: a compromised OEM could mint a JWT for any of
its users and reach that user's data on every miniapp they have used.
There is no cryptographic move that lets a miniapp distinguish a real user from an
OEM impersonating its own user, because the OEM is the source of truth for who its
users are.

**Decision: put `tenantId` in the handoff and let developers set a trust policy
(Option B), with per-miniapp opt-in as the configuration surface.** The auto-auth
payload carries `tenantId` alongside `mentraUserId`. Miniapps that ignore it work
exactly as today; miniapps that care apply a policy:

- `trust-all` (default): accept any verified payload. Keeps today's behavior, where
  miniapps just work.
- `mentra-direct-only`: accept only `tenantId == "mentra"`.
- `whitelist`: accept only a configured set of `tenantId`s.

A per-miniapp pseudonymous `sub = H(mentraUserId, packageName)` (so no two miniapps
see the same id for the same user) is available as a future opt-in for
privacy-sensitive miniapps; it is not the default because it would break the thing
developers rely on, a stable id for each user.

## OEM onboarding

One integration flow. The OEM signs JWTs with its own private key; Mentra holds the
corresponding public key for verification.

1. **OEM signs up via the portal** (flow in
   [`../../005-websites/oem-portal/`](../../005-websites/oem-portal/)). Output is a
   record in the `oems` collection with a stable `tenantId`.
2. **OEM generates a keypair locally:**
   ```
   openssl genpkey -algorithm ED25519 -out private.pem
   openssl pkey -in private.pem -pubout -out public.pem
   ```
3. **OEM registers the public key with Mentra,** two ways:
   - **Static upload:** paste `public.pem` into the portal; Mentra stores it on the
     `oems` document.
   - **JWK Set URL:** host a JWKS file at a URL and register that URL; Mentra
     fetches and caches the keys, refreshing periodically (supports rotation
     without re-paste).
4. **OEM keeps the private key secret on its backend,** used to sign per-user JWTs
   at session start.

**Key rotation.** Static key: upload a new public key, Mentra replaces the stored
one (old-key JWTs then fail). JWK Set URL: publish the new key at the JWKS URL,
keeping both old and new during a transition window (standard OIDC practice);
Mentra's cache refreshes on a schedule and on verification failure.

The OEM needs only a backend that can sign JWTs and a place to store the private
key. It does not need a hosted JWKS URL (static upload suffices), its own OIDC
issuer, or any specific framework.

## Endpoints

The consolidated path and caller conventions are in [`spec.md`](./spec.md). The
client-called endpoints (exchange, refresh) live under `/api/client/auth/...`; the
OEM-backend endpoints live under `/api/oem/...`.

### `POST /api/client/auth/exchange`

Token exchange (RFC 8693). The OEM's mobile app presents a JWT signed by the OEM's
backend; Mentra returns Core-backed credentials. Hosted Runtime can derive or mint
a separate `cloud-runtime` token from the same verified identity; see issue 007.

```
POST /api/client/auth/exchange
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<oem-signed-jwt>
&subject_token_type=urn:ietf:params:oauth:token-type:jwt
```

**OEM-signed JWT (`subject_token`) required claims:**

| Claim | Meaning |
| --- | --- |
| `iss` | OEM identifier (`tenantId`). Mentra looks up the OEM's public key by this value. |
| `sub` | The OEM's own user identifier (`tenantUserId`). Stable for the user's lifetime within that OEM. |
| `aud` | Must be `"mentra"`. Audience pinning prevents a JWT meant for another service from being replayed against us. |
| `exp` | Expiry, Unix seconds, in the future. Recommended TTL 5 minutes. |
| `iat` | Issued-at, Unix seconds. |
| `jti` | Unique id per token. Used for replay protection. |

Signing algorithm must be one of `EdDSA` (Ed25519), `RS256`, `ES256`. Algorithm
`none` is rejected.

**Success (200):**

```json
{ "access_token": "<mentra-jwt>", "refresh_token": "<opaque>",
  "token_type": "Bearer", "expires_in": 3600 }
```

**Errors** (RFC 8693 format, `{ "error", "error_description" }`):

| `error` | When | HTTP |
| --- | --- | --- |
| `invalid_request` | Malformed body, missing required claims | 400 |
| `invalid_grant` | `subject_token` signature invalid, expired, or replayed | 400 |
| `unauthorized_client` | The OEM identified by `iss` is disabled or absent | 401 |
| `unsupported_grant_type` | `grant_type` is not the token-exchange URN | 400 |
| `server_error` | Mentra-side issue (DB unavailable, key fetch failed) | 500 |

For the Mentra-as-OEM subject-token types (core token, Supabase session) on this
same endpoint, see [`spec.md`](./spec.md) and the migration bridge in
[`design.md`](./design.md).

### `POST /api/client/auth/refresh`

Exchange a refresh token for a new access token; the OEM backend is not involved.

```
POST /api/client/auth/refresh
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<opaque>
```

Success returns a new access token and a **rotated** refresh token (the old one is
invalidated). Errors: `invalid_grant` (unknown, expired, or already-rotated refresh
token), `unauthorized_client` (the issuing OEM is now disabled).

### `GET /api/oem/me`

OEM admin tooling reads its own registered info (display name, `tenantId`, public key
or JWKS URL, active-session count). Requires an OEM admin session from the portal.

```json
{ "tenantId": "acme-oem", "displayName": "Acme Glasses",
  "publicKeyMode": "static", "publicKey": "<PEM>", "jwksUrl": null,
  "activeSessionCount": 1234, "createdAt": "2026-05-01T12:34:56Z" }
```

In JWK Set URL mode: `publicKeyMode` is `"jwks-url"`, `publicKey` is null, `jwksUrl`
holds the URL.

### `POST /api/oem/jwks`

Register or rotate the OEM's public key. Requires an OEM admin session.

```json
{ "mode": "static", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----" }
```
```json
{ "mode": "jwks-url", "jwksUrl": "https://acme-oem.example.com/.well-known/jwks.json" }
```

Returns the updated `oems` document. Errors: `invalid_request` (PEM does not parse,
JWKS URL unreachable or invalid), `forbidden` (caller is not an admin of this OEM).

### `DELETE /api/oem/sessions/:sessionId`

Revoke a single session early. OEM admin (own sessions only) or Mentra internal
admin. Effect: delete the session's refresh token from `refreshTokens`, and add the
`jti` of any outstanding access token to `revokedJtis` (TTL'd to the access token's
natural expiry). Subsequent refreshes fail; subsequent access-token verifications
return 401. Success: 204.

### `DELETE /api/oem/sessions`

Revoke all sessions for an OEM (terms violation, account closure, security
incident). Mentra internal admin only. Sets `oems.disabled = true` (which alone
blocks future exchanges and refreshes) and enqueues an async job to delete all
`refreshTokens` for the OEM and revoke outstanding jtis. Success: 202 with a job id.

## Data model

MongoDB.

### Collection: `oems`

```js
{
  _id: ObjectId,
  tenantId: "acme-oem",                  // stable, exposed externally
  displayName: "Acme Glasses",
  publicKeyMode: "static" | "jwks-url",
  publicKey: "<PEM>" | null,          // present when mode === "static"
  jwksUrl: "https://..." | null,      // present when mode === "jwks-url"
  cachedJwks: { ... } | null,         // optional cache of fetched JWKS
  cachedJwksFetchedAt: ISODate | null,
  disabled: false,
  createdAt: ISODate,
  updatedAt: ISODate
}
```

Index: `{ tenantId: 1 }` unique (lookup during token verification).

### Collection: `users`

Identity only, no PII. The document's own `_id` **is** the `mentraUserId`: we use
the Mongo-generated `_id` rather than minting a separate opaque id.

```js
{
  _id: ObjectId,            // == mentraUserId (hex string externally)
  tenantId: "acme-oem",
  tenantUserId: "user-42",     // for Mentra-direct users this is the Supabase `sub`
  createdAt: ISODate
}
```

Indexes: the default `{ _id: 1 }` primary key (no separate `mentraUserId` field or
index), and `{ tenantId: 1, tenantUserId: 1 }` unique (lookup during exchange; create on
first sight).

(Implementation note: the current code mints `mu_${ulid()}` in `user.service.ts`;
switching to `_id` is a code change. v2 is pre-production, so there is no data to
migrate.)

### Collection: `refreshTokens`

```js
{
  _id: ObjectId,
  refreshTokenHash: "<bcrypt or argon2 hash>",  // never store plaintext
  mentraUserId: "507f1f77bcf86cd799439011",
  tenantId: "acme-oem",
  issuedAt: ISODate,
  expiresAt: ISODate                            // TTL index on this field
}
```

Indexes: `{ expiresAt: 1 }` with `expireAfterSeconds: 0` (Mongo TTL index, auto
deletes past-expiry docs, no background job), `{ refreshTokenHash: 1 }` unique
(lookup on refresh), `{ mentraUserId: 1, tenantId: 1 }` (revocation queries).

### Collection: `revokedJtis`

Short-lived blacklist for revoked access-token jtis.

```js
{ _id: ObjectId, jti: "<unique-id>", expiresAt: ISODate /* TTL index */ }
```

Indexes: `{ expiresAt: 1 }` with `expireAfterSeconds: 0` (drops the entry once the
access token would have expired anyway), `{ jti: 1 }` unique (lookup on every
access-token verification).

### Collection: `seenJtis`

Replay-protection cache for OEM-issued JWT jtis, TTL'd to expire shortly after the
OEM JWT's own expiry.

```js
{ _id: ObjectId, jti: "<unique-id>", tenantId: "acme-oem", expiresAt: ISODate }
```

Indexes: `{ expiresAt: 1 }` with `expireAfterSeconds: 0`, `{ jti: 1, tenantId: 1 }`
unique (lookup on every exchange). Kept separate from `revokedJtis` because the
lifetimes differ: `seenJtis` populates on every successful exchange and expires
quickly; `revokedJtis` populates only on explicit revoke.

## Token formats

**OEM-issued JWT (incoming `subject_token`).** Algorithms `EdDSA` / `RS256` /
`ES256` (`none` rejected). Required claims `iss`, `sub`, `aud`, `exp`, `iat`,
`jti`. Recommended TTL 5 minutes.

**Core access token (returned).** JWT signed by Mentra's access-token key, used for
Core-owned APIs:

```json
{ "iss": "cloud-core", "sub": "507f1f77bcf86cd799439011",
  "aud": "cloud-core", "exp": 1736815945, "iat": 1736812345,
  "jti": "01HGZ...", "tenant_id": "acme-oem",
  "scope": "audio transcription translation" }
```

Core services verify the signature against Mentra's public key, check
`aud === "cloud-core"`, check `exp`, and check `jti` is not in `revokedJtis`.
Runtime Services use a separate `cloud-runtime` token and deployment-configured
issuer/JWKS trust. TTL 1 hour.

**Mentra-issued refresh token (returned).** Not a JWT: an opaque random string (256
bits, base64url). Mentra stores a **hash** (bcrypt or argon2) in `refreshTokens`
and looks up by hash. TTL 30 days. Rotated on every refresh.

## Lifecycles

**Issue session (token exchange).** Triggered by `POST /api/client/auth/exchange`
with an OEM-signed JWT:

1. Parse the JWT (no verify yet), read `iss`.
2. Look up the OEM by `iss`; if absent or `disabled`, return `unauthorized_client`.
3. Verify the signature with the OEM's public key (stored PEM, or cached JWKS,
   fetching if stale). On failure, `invalid_grant`.
4. Validate claims: `aud === "mentra"`, `exp` in the future, `iat` within 5 min
   clock skew. On failure, `invalid_grant`.
5. Check `jti` against `seenJtis`; if seen, `invalid_grant`. Otherwise insert with
   `expiresAt = exp + 60s`.
6. Look up the user by `(tenantId, tenantUserId) = (iss, sub)`. If found, use that user's
   `_id` as the `mentraUserId`; if not, insert a new user (its `_id` is the new
   `mentraUserId`).
7. Issue the access token (1h) and refresh token (30d); store the hashed refresh
   token.
8. Return both tokens.

**Refresh.** Triggered by `POST /api/client/auth/refresh`: hash the presented
token, look up by hash; if absent or expired, `invalid_grant`; look up the OEM and
fail `unauthorized_client` if disabled; delete the old refresh token, issue a new
access + refresh token, store the new hash, return both.

**Revoke a single session.** Authorize (OEM admin own-only, Mentra admin any); look
up the session's refresh token; delete it; add outstanding access-token jtis to
`revokedJtis` with matching expiry.

**Revoke all sessions for an OEM.** Set `oems.disabled = true` (blocks future
exchanges and refreshes via the disabled checks above); enqueue an async job to
delete all `refreshTokens` and revoke outstanding jtis; return the job id.

**Key rotation (OEM-side).** Static: new public key replaces the stored one,
old-key JWTs fail immediately. JWKS URL: Mentra fetches and caches with a short TTL
(5 min); both keys are valid during the cache window if both are in the OEM's JWKS,
then old-key JWTs fail after the OEM removes the old key.

## Miniapp identity handoff

Per the Q2 decision, the auto-auth payload Mentra sends to miniapp backends carries
`tenantId` alongside `mentraUserId`:

```json
{ "mentraUserId": "507f1f77bcf86cd799439011", "tenantId": "acme-oem", ... }
```

| Policy | Behavior |
| --- | --- |
| `trust-all` | Accept any verified payload regardless of `tenantId`. Default. |
| `mentra-direct-only` | Reject if `tenantId !== "mentra"`. |
| `whitelist` | Accept only if `tenantId` is in a configured allow-list. |

How the developer sets this policy lives in the miniapp spec. From this doc's
perspective, Mentra emits the payload with `tenantId` populated; downstream policy
enforcement is the miniapp's concern. The end-to-end delivery of this identity into
a local miniapp (the miniapp-scoped token and on-device injection) is in
[`design.md`](./design.md#miniapp-auto-auth).

## Security considerations

- **Replay protection.** Every OEM-issued JWT's `jti` is recorded in `seenJtis` on
  accept; re-presentation is rejected. Entries expire shortly after the JWT's `exp`.
- **Audience validation.** Reject any JWT whose `aud` is not `"mentra"`.
- **Algorithm allowlist.** Accept only `EdDSA`, `RS256`, `ES256`; reject `none`
  (avoids the algorithm-confusion bug).
- **Issuer pinning.** `iss` selects which OEM public key to verify with, but the key
  is the source of truth: changing `iss` to another OEM still fails without that
  OEM's private key.
- **TLS required** on all endpoints; no HTTP fallback.
- **Rate limiting.** Per-OEM limits on the exchange endpoint (concrete limits TBD).
- **Audit logging.** Every exchange, refresh, and revocation emits a structured log
  with `tenantId`, `mentraUserId` (or `tenantUserId` pre-mapping), endpoint, and outcome
  (retention policy open).
- **Refresh token rotation** surfaces a leak: an attacker's use rotates the token,
  so the legitimate client's next refresh fails.
- **Refresh tokens stored hashed at rest;** a DB leak does not expose them.
- **OEM private key never leaves the OEM's backend;** Mentra holds only the public
  key.

## TEST OEM

A reference implementation and test fixture at
[`../../../../test/test-oem/`](../../../../test/test-oem/), doubling as the
canonical partner-integration example. A small standalone Bun service that mimics a
real OEM backend: tests spin it up alongside the cloud under test, register it
(once), and drive it programmatically.

- Generates an Ed25519 keypair on first run, stores the private key locally.
- Registers with Mentra at startup via `POST /api/oem/jwks`.
- `tenantId` is env-configured (default `"test-oem"`); spinning up two instances with
  different ids exercises multi-OEM scenarios (trust policies, OEM isolation).

Endpoints:

```
POST   /test-oem/mint-jwt           { tenantUserId, extraClaims? } -> { jwt }
POST   /test-oem/configure-user     { tenantUserId, displayName?, ... } -> { ok }
DELETE /test-oem/users/:tenantUserId   -> { ok }   (simulates deauthorizing a user)
GET    /test-oem/.well-known/jwks.json   -> JWKS document (JWK-URL mode)
```

Usage:

```ts
// 1. Get a JWT for a synthetic user
const { jwt } = await fetch(`${TEST_OEM_URL}/test-oem/mint-jwt`, {
  method: "POST", body: JSON.stringify({ tenantUserId: "test-user-1" }),
}).then(r => r.json());

// 2. Exchange it with Mentra
const tokens = await fetch(`${MENTRA_URL}/api/client/auth/exchange`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: jwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  }),
}).then(r => r.json());

// 3. Use tokens.access_token to call Mentra APIs as test-user-1
```

Deployment: a Bun process alongside the cloud for local dev; a sibling service in
the test namespace for CI; a `test-oem` Porter app next to `cloud-test` for test
environments.

## Open questions

- **Specific TTLs.** Proposed: 5-minute OEM-JWT, 1-hour Core access token, 30-day
  refresh token. Worth a team pass on the UX tradeoff.
- **Session id addressability.** `DELETE /api/oem/sessions/:sessionId` needs a
  stable session id: derive from the refresh-token hash, or store a separate field.
  Lean: separate field.
- **Audit log retention.** Concrete policy needed.
- **Rate limits.** Specific per-OEM limits for the token endpoint.
- **`tenant_id` in the access token.** Proposed to include it (resource servers see the
  attesting OEM without a DB lookup), at the cost of carrying OEM identity through
  the system. Lean: include it.
- **OEM JWT max clock skew.** Proposed 5 minutes.
- **Initial OEM admin assignment.** Who is the first admin at signup; the portal
  spec needs to nail this.

## Out of scope

- **OEM portal UX:** [`../../005-websites/oem-portal/`](../../005-websites/oem-portal/).
- **Migration of existing email-based Mentra users:** separate spec (see the
  identity model in [`design.md`](./design.md)).
- **Multi-region key distribution / caching:** single-region for now.
- **API-key path** (the deferred Q1 option): could be added later as a parallel
  endpoint without disturbing this design.
- **Commercial / contract terms with OEMs:** engineering only.

## Files this design implies

A sketch, confirmed when implementation lands:

```
cloud-v2/packages/core/   (auth routes + services)
  routes:    /api/client/auth/exchange, /refresh; /api/oem/me, /jwks, sessions
  services:  JWT verify (OEM-signed), JWT issue (Mentra), key resolve
             (static + JWKS URL), refresh-token store, jti tracker,
             (tenantId, tenantUserId) -> mentraUserId mapper
  schemas:   oems, users, refreshTokens, revokedJtis, seenJtis
cloud-v2/test/test-oem/    (TEST OEM service + keypair/JWT signing)
```
