# Cloud v2 OEM Auth Design

**Status:** Design proposal. Pending team review.

## Why this doc

Implementation-level companion to [`spec.md`](./spec.md). The spec
picked Option 5 (signed-token integration via OAuth 2.0 Token Exchange,
RFC 8693) and Option B for the miniapp-identity handoff. This doc
specifies the concrete API endpoints, MongoDB schema, token formats,
and lifecycles needed to build it.

The OEM admin portal (login, team management, JWK registration UI) is
out of scope here and lives in `cloud-v2/issues/002-oem-portal/`. The
runtime endpoints in this doc are what the portal will eventually
call.

## How to read this

If a Redis or HTTP command appears, the plain-English meaning sits
right next to it. No looking things up. Auth jargon is glossed inline
the first time it appears in a section.

## Concepts primer

Terms used throughout this doc. Plain-English alongside each one.

- **JWT (JSON Web Token).** A small signed JSON blob carrying claims
  (key/value pairs). Example: `{ "iss": "acme-oem", "sub": "user-42",
  "exp": 1736812345 }`, signed so the recipient can verify it wasn't
  tampered with.
- **JWK (JSON Web Key).** Standard format for publishing a public key
  as JSON. Lets one party hand a public key to another in a structured,
  algorithm-aware form.
- **JWK Set URL.** A URL hosting one or more public keys in JWK format
  (e.g., `https://acme-oem.example.com/.well-known/jwks.json`). The
  verifier (Mentra) fetches this URL to learn the issuer's current
  public keys. Supports rotation: the URL response changes when the
  issuer rotates keys.
- **Public/private keypair.** Asymmetric crypto. The OEM keeps the
  private key secret and uses it to sign JWTs. Mentra holds the
  corresponding public key (uploaded directly or fetched from the
  OEM's JWK Set URL) and uses it to verify signatures. Only the OEM
  can produce valid signatures; anyone with the public key can verify.
- **Token Exchange (RFC 8693).** An OAuth 2.0 standard where a client
  presents a token from one issuer to a token endpoint and receives a
  different token in return, scoped to a different audience. We use
  it to swap an OEM-signed JWT for a Mentra-issued access token.
- **Access token.** A short-lived credential the client sends with
  each API request. Typically a JWT itself, signed by the issuing
  service (in our case, by Mentra).
- **Refresh token.** A longer-lived credential used only to obtain
  new access tokens. Never sent to resource servers (only to the
  token endpoint). Stored server-side so it can be revoked.
- **jti (JWT ID).** A unique identifier claim on a JWT. Lets the
  verifier reject tokens it has already seen (replay protection) or
  blacklist specific tokens for revocation.
- **Audience (`aud` claim).** Identifies the intended recipient of a
  token. The verifier checks that the audience matches itself before
  accepting; rejects otherwise. Prevents a token meant for one service
  from being replayed against another.
- **Issuer (`iss` claim).** Identifies the party that signed the token.
  Mentra uses this to look up which OEM's public key to verify with.
- **MentraUserId.** Mentra-internal opaque identifier for a user.
  Created on first sight of an `(oem_id, oem_user_id)` pair. Stable
  for the user's lifetime under that OEM.

## OEM onboarding

One integration flow. The OEM signs JWTs with their own private key;
Mentra holds the corresponding public key for verification.

### Steps

1. **OEM signs up via the portal.** Portal flow specified separately in
   `002-oem-portal/`. Output of signup is a record in the `oems`
   collection with a stable `oemId`.
2. **OEM generates a keypair locally.** Example (works in any language
   with `openssl`):
   ```
   openssl genpkey -algorithm ED25519 -out private.pem
   openssl pkey -in private.pem -pubout -out public.pem
   ```
   Plain English: "create a new private/public key pair using the
   Ed25519 algorithm; write the private key to `private.pem` and the
   matching public key to `public.pem`."
3. **OEM registers the public key with Mentra.** Two ways:
   - **Static upload:** OEM pastes the contents of `public.pem` into
     the portal. Mentra stores it on the `oems` document.
   - **JWK Set URL:** OEM hosts a JWKs file at a URL of their choosing
     and registers that URL with Mentra. Mentra fetches and caches the
     keys, refreshing periodically. Supports rotation without re-paste.
4. **OEM keeps the private key secret on their backend.** Used to sign
   JWTs identifying their users at session-start time.

### Key rotation

- **Static key:** OEM generates a new keypair, comes back to the
  portal, pastes the new public key. Mentra updates the stored key.
  Any JWTs signed with the old private key are now invalid (they
  won't verify against the new public key).
- **JWK Set URL:** OEM publishes the new key at their JWKs URL. To
  avoid a service interruption during rotation, the OEM's JWKs URL
  should include both old and new keys during a transition window
  (standard OIDC rotation practice). Mentra's cached keys refresh on
  a schedule and on verification failure.

### What the OEM does and does not need

Needs: a backend service capable of signing JWTs (every modern language
has a JWT library), a place to store the private key securely.

Does not need: a hosted JWK Set URL (static upload is sufficient),
their own OIDC issuer, any specific framework or vendor.

## Endpoints

All endpoints live under `/api/oem/`. Each one below specifies its
purpose, request shape, response shape, error cases, and the
plain-English meaning of the protocol details.

### `POST /api/oem/oauth/token`

**Purpose.** Token Exchange (RFC 8693). The OEM's mobile app presents
a JWT signed by the OEM's backend, and Mentra returns a Mentra-issued
access token and refresh token.

**Plain English:** "Swap this OEM-signed JWT for a Mentra session."

**Request.**

```
POST /api/oem/oauth/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<oem-signed-jwt>
&subject_token_type=urn:ietf:params:oauth:token-type:jwt
```

Plain English of the body fields:

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` — the
  RFC 8693 standard string that says "this is a token exchange
  request" (as opposed to other OAuth grant types like `password` or
  `authorization_code`).
- `subject_token` — the OEM-signed JWT being presented for exchange.
- `subject_token_type` — declares the format of `subject_token`. We
  only accept `urn:...:token-type:jwt`.

**OEM-signed JWT (the `subject_token`).** Required claims:

| Claim | Meaning |
| --- | --- |
| `iss` | OEM identifier (`oemId` from the `oems` collection). Mentra looks up the OEM's public key by this value. |
| `sub` | The OEM's own user identifier (`oemUserId`). Stable for the user's lifetime within that OEM. |
| `aud` | Must be `"mentra"`. Audience pinning prevents a JWT meant for another service from being replayed against us. |
| `exp` | Expiry time as Unix seconds. Must be in the future. Recommended TTL: 5 minutes from `iat`. |
| `iat` | Issued-at time as Unix seconds. |
| `jti` | Unique ID per token. Used by Mentra for replay protection. |

Optional claims (passed through, no special meaning to Mentra):

| Claim | Meaning |
| --- | --- |
| `oem_display_name` | If the OEM wants to provide a user-facing display name for downstream UIs. Mentra doesn't store this; it's available to the cloud's audio path only if the OEM chooses to send it on each exchange. |

The JWT must be signed with one of the algorithms Mentra supports:
`EdDSA` (Ed25519), `RS256`, `ES256`. Algorithm `none` is rejected.

**Response, success (200 OK).**

```json
{
  "access_token": "<mentra-issued-jwt>",
  "refresh_token": "<opaque-string>",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

Plain English: "Here's an access token valid for 3600 seconds (1
hour). Use it in the `Authorization: Bearer ...` header on subsequent
Mentra API calls. When it expires, use the refresh_token to get a new
one."

**Errors.** RFC 8693 error response format:

```json
{
  "error": "invalid_request",
  "error_description": "subject_token missing 'aud' claim"
}
```

Error codes Mentra uses:

| `error` | When it happens | HTTP status |
| --- | --- | --- |
| `invalid_request` | Malformed body, missing required claims | 400 |
| `invalid_grant` | `subject_token` signature invalid, expired, or replayed | 400 |
| `unauthorized_client` | The OEM identified by `iss` is disabled or doesn't exist | 401 |
| `unsupported_grant_type` | `grant_type` is not the token-exchange URN | 400 |
| `server_error` | Mentra-side issue (DB unavailable, key fetch failed) | 500 |

### `POST /api/oem/oauth/refresh`

**Purpose.** Exchange a refresh token for a new access token. The OEM
backend is not involved in this call; the OEM mobile SDK calls this
endpoint directly.

**Plain English:** "My access token is about to expire. Give me a new
one using this refresh token."

**Request.**

```
POST /api/oem/oauth/refresh HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<opaque-string>
```

**Response, success (200 OK).**

```json
{
  "access_token": "<new-mentra-issued-jwt>",
  "refresh_token": "<new-opaque-string>",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

The response includes a **rotated** refresh token. The old one is
invalidated. This is "refresh token rotation," standard practice for
limiting blast radius if a refresh token leaks.

**Errors.**

| `error` | When |
| --- | --- |
| `invalid_grant` | Refresh token unknown, expired, or already rotated (already used once) |
| `unauthorized_client` | The OEM that issued the original session is now disabled |

### `GET /api/oem/me`

**Purpose.** OEM admin tooling reads its own registered information.
Returns the OEM's display name, `oemId`, registered public key (or
JWK Set URL), and counts (active sessions, etc.).

**Plain English:** "Tell me about my own OEM account."

Authentication: requires an OEM admin session from the portal (out of
scope here; specified in `002-oem-portal/`).

**Response, success (200 OK).**

```json
{
  "oemId": "acme-oem",
  "displayName": "Acme Glasses",
  "publicKeyMode": "static",
  "publicKey": "<PEM-encoded-public-key>",
  "jwksUrl": null,
  "activeSessionCount": 1234,
  "createdAt": "2026-05-01T12:34:56Z"
}
```

If using JWK Set URL mode: `publicKeyMode` is `"jwks-url"`,
`publicKey` is null, `jwksUrl` contains the URL.

### `POST /api/oem/jwks`

**Purpose.** Register or rotate the OEM's public key. Replaces the
existing key on the `oems` document.

**Plain English:** "Update what public key Mentra should use to
verify my JWTs."

Authentication: requires an OEM admin session from the portal.

**Request — static key upload.**

```json
{
  "mode": "static",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

**Request — JWK Set URL.**

```json
{
  "mode": "jwks-url",
  "jwksUrl": "https://acme-oem.example.com/.well-known/jwks.json"
}
```

**Response, success (200 OK).** Returns the updated `oems` document
(same shape as `GET /api/oem/me`).

**Errors.**

| `error` | When |
| --- | --- |
| `invalid_request` | PEM doesn't parse, JWKs URL not reachable, JWKs URL doesn't return valid JWKS document |
| `forbidden` | Caller is not an admin of this OEM |

### `DELETE /api/oem/sessions/:sessionId`

**Purpose.** Revoke a single session before it would naturally expire.
Used when the OEM wants to log out one of their users from Mentra
cloud services (or when Mentra admin tooling needs to evict a session).

**Plain English:** "Kill this specific session immediately."

Authentication: requires an OEM admin session from the portal, OR a
Mentra internal admin role. The OEM can only revoke sessions issued
under their own `oemId`.

**Response, success (204 No Content).**

**Effect.** The refresh token for this session is deleted from
`refreshTokens`. The `jti` of any outstanding access token for this
session is added to `revokedJtis` (TTL'd to expire when the access
token would have naturally expired). Subsequent refresh attempts
fail; subsequent access-token verifications return 401.

### `DELETE /api/oem/sessions`

**Purpose.** Revoke all sessions for an OEM. Used when an OEM is
being terminated (terms violation, account closure, security
incident).

**Plain English:** "Kill every active session under this OEM."

Authentication: requires Mentra internal admin role only. OEMs cannot
do this to themselves via this endpoint (they can use the per-session
endpoint individually or close their account through the portal,
which triggers this).

**Response, success (202 Accepted).** The work is async (could be
many sessions). Response body includes a job ID for status tracking.

```json
{
  "jobId": "rev-job-2026-05-14-001",
  "estimatedSessions": 1234
}
```

**Effect.** Worker job deletes all `refreshTokens` for the OEM,
marks all outstanding access-token jtis as revoked, and disables the
OEM record (so future token-exchange attempts also fail).

## Data model

MongoDB. Collections, fields, indexes.

### Collection: `oems`

One document per OEM.

```js
{
  _id: ObjectId,
  oemId: "acme-oem",                       // stable, exposed externally
  displayName: "Acme Glasses",
  publicKeyMode: "static" | "jwks-url",
  publicKey: "<PEM>" | null,                // present when mode === "static"
  jwksUrl: "https://..." | null,            // present when mode === "jwks-url"
  cachedJwks: { ... } | null,               // optional cache of fetched JWKs
  cachedJwksFetchedAt: ISODate | null,
  disabled: false,
  createdAt: ISODate,
  updatedAt: ISODate
}
```

**Indexes.**

- `{ oemId: 1 }`, unique. Lookup by `oemId` during token verification.

### Collection: `users`

One document per `MentraUserId`. Identity-only, no PII.

```js
{
  _id: ObjectId,
  mentraUserId: "mu_01HGZX...",            // ULID or similar opaque ID
  oemId: "acme-oem",
  oemUserId: "user-42",
  createdAt: ISODate
}
```

**Indexes.**

- `{ mentraUserId: 1 }`, unique.
- `{ oemId: 1, oemUserId: 1 }`, unique. Lookup during token exchange
  to find existing user, or create on first sight.

### Collection: `refreshTokens`

One document per active refresh token.

```js
{
  _id: ObjectId,
  refreshTokenHash: "<bcrypt or argon2 hash>",  // never store plaintext
  mentraUserId: "mu_01HGZX...",
  oemId: "acme-oem",
  issuedAt: ISODate,
  expiresAt: ISODate                          // TTL index on this field
}
```

**Indexes.**

- `{ expiresAt: 1 }` with `expireAfterSeconds: 0`. **MongoDB TTL
  index** — plain English: "automatically delete documents whose
  `expiresAt` field is in the past." No background job needed.
- `{ refreshTokenHash: 1 }`, unique. Lookup on refresh.
- `{ mentraUserId: 1, oemId: 1 }`. Revocation queries.

### Collection: `revokedJtis`

Short-lived blacklist for revoked access-token jtis.

```js
{
  _id: ObjectId,
  jti: "<unique-id>",
  expiresAt: ISODate     // TTL index
}
```

**Indexes.**

- `{ expiresAt: 1 }` with `expireAfterSeconds: 0`. TTL index: Mongo
  auto-deletes entries past their expiry. Plain English: "stop
  tracking this jti once the access token it identifies would have
  expired anyway."
- `{ jti: 1 }`, unique. Lookup on every access-token verification.

### Collection: `seenJtis`

Replay-protection cache for OEM-issued JWT jtis. Mongo TTL'd to expire
shortly after the OEM JWT's own expiry.

```js
{
  _id: ObjectId,
  jti: "<unique-id>",
  oemId: "acme-oem",
  expiresAt: ISODate
}
```

**Indexes.**

- `{ expiresAt: 1 }` with `expireAfterSeconds: 0`. TTL index.
- `{ jti: 1, oemId: 1 }`, unique. Lookup on every token exchange.

(Kept separate from `revokedJtis` because the use cases and lifetimes
differ: `seenJtis` populates on every successful exchange and expires
quickly; `revokedJtis` populates only on explicit revoke and expires
when the access token would have.)

## Token formats

### OEM-issued JWT (incoming, the `subject_token`)

Algorithms: `EdDSA`, `RS256`, or `ES256`. Algorithm `none` rejected.

Required claims: `iss`, `sub`, `aud`, `exp`, `iat`, `jti`.
Optional claims: anything else (Mentra ignores unrecognized claims).

Recommended TTL: 5 minutes (`exp - iat = 300`). Long enough for
network round-trips and minor clock skew; short enough that a leaked
JWT has minimal exploit window.

### Mentra-issued access token (returned from token exchange)

JWT signed by Mentra's signing key. Algorithm: `EdDSA` (Ed25519).

Claims:

```json
{
  "iss": "mentra-cloud",
  "sub": "mu_01HGZX...",       // MentraUserId
  "aud": "mentra-cloud",        // resource servers verify
  "exp": 1736815945,
  "iat": 1736812345,
  "jti": "01HGZ...",
  "oem_id": "acme-oem",
  "scope": "audio transcription translation"
}
```

Plain English: every Mentra service that accepts this token verifies
the signature against Mentra's public key, checks `aud === "mentra-cloud"`,
checks `exp` is in the future, checks `jti` is not in `revokedJtis`.
If all pass, it trusts `sub` as the user identity and `oem_id` as the
attesting OEM.

TTL: 1 hour (`exp - iat = 3600`).

### Mentra-issued refresh token (returned from token exchange)

Not a JWT. An opaque random string (256 bits of entropy, base64url-encoded).

The plaintext value is only seen by the SDK that received it. Mentra
stores a **hash** (bcrypt or argon2) of the refresh token in the
`refreshTokens` collection. On refresh, Mentra hashes the presented
value and looks up by hash.

TTL: 30 days.

Refresh token rotation: every successful refresh issues a new refresh
token and invalidates the old one.

## Lifecycles

### Issue session (token exchange)

Triggered by: SDK calls `POST /api/oem/oauth/token` with an OEM-signed
JWT.

Steps Mentra performs:

1. Parse the JWT (without verifying yet). Read `iss` (OEM ID).
2. Look up the OEM in `oems` by `iss`. If not found or `disabled === true`,
   return `unauthorized_client`.
3. Verify the JWT signature using the OEM's public key. If
   `publicKeyMode === "static"`, use the stored PEM. If
   `"jwks-url"`, use the cached JWKS (fetch and cache if stale).
   On verification failure, return `invalid_grant`.
4. Validate claims: `aud === "mentra"`, `exp` in the future, `iat`
   not too far in the past (allow 5 min clock skew). If any fail,
   return `invalid_grant`.
5. Check `jti` against `seenJtis` for replay. If found, return
   `invalid_grant`. Otherwise, insert into `seenJtis` with
   `expiresAt = exp + 60s` buffer.
6. Look up the user in `users` by `(oemId, oemUserId) = (iss, sub)`.
   If found, use that `mentraUserId`. If not, generate a new ULID
   and insert. Plain English: "first time we see this user, create
   their record; thereafter, reuse it."
7. Issue a Mentra access token (1h TTL) and a refresh token (30d TTL).
   Store the hashed refresh token in `refreshTokens`.
8. Return both tokens to the client.

### Refresh access token

Triggered by: SDK calls `POST /api/oem/oauth/refresh` with the
refresh token.

Steps:

1. Hash the presented refresh token. Look up in `refreshTokens` by
   hash.
2. If not found or `expiresAt` in the past, return `invalid_grant`.
3. Look up the OEM in `oems` by the stored `oemId`. If `disabled`,
   return `unauthorized_client`. (Catches OEMs disabled mid-session.)
4. Delete the old refresh token document. Issue a new access token
   (1h TTL) and a new refresh token (30d TTL). Insert the new
   refresh token's hash into `refreshTokens`.
5. Return both tokens.

### Revoke a single session

Triggered by: admin or OEM calls `DELETE /api/oem/sessions/:sessionId`.

Steps:

1. Authorize: OEM admin can only revoke their own OEM's sessions;
   Mentra admin can revoke any.
2. Look up the session's refresh token in `refreshTokens` by some
   addressable key (TBD: session ID could be derived from the refresh
   token's hash, or stored as a separate field — open question).
3. Delete the refresh token document.
4. For any outstanding access tokens issued from this session, add
   their `jti` to `revokedJtis` with `expiresAt` matching the access
   token's expiry. Plain English: "the access token is still
   cryptographically valid, but every service that verifies it will
   look up its jti and see it's been revoked."

### Revoke all sessions for an OEM

Triggered by: Mentra admin calls `DELETE /api/oem/sessions`.

Steps:

1. Set `oems.disabled = true`. This alone is enough to block future
   token exchanges and future refreshes — the verifications in
   "Issue session" step 2 and "Refresh" step 3 catch the disabled
   flag.
2. Enqueue a background job to delete all `refreshTokens` for this
   OEM and add all outstanding access-token jtis to `revokedJtis`.
   The job is async because the OEM could have thousands of active
   sessions; deleting them all synchronously could time out the API
   call.
3. Return the job ID immediately.

### Key rotation (OEM-side)

**Static key.** OEM uploads new public key via `POST /api/oem/jwks`.
Mentra replaces the stored key. JWTs signed with the old key fail
verification from that moment.

**JWK Set URL.** OEM updates their JWKs URL response to include the
new key. Mentra fetches and caches with a short TTL (5 minutes).
During the cache window, both old and new keys are valid if both are
in the OEM's JWKS response. After the cache refreshes and the OEM
removes the old key from their JWKS, old-key JWTs fail.

## Miniapp identity handoff

Per spec.md Q2 Option B: the auto-auth payload Mentra sends to miniapp
backends carries `oemId` alongside `mentraUserId`. Miniapp developers
choose their own trust policy.

Concretely, the auto-auth payload (sent in a header or as part of the
miniapp-backend request envelope; exact mechanism is part of the
miniapp spec, not this one) includes:

```json
{
  "mentraUserId": "mu_01HGZX...",
  "oemId": "acme-oem",
  ...
}
```

Miniapp developer can configure their app's trust policy:

| Policy | Behavior |
| --- | --- |
| `trust-all` | Accept any verified payload regardless of `oemId`. Default. Preserves today's DX where miniapps "just work." |
| `mentra-direct-only` | Reject if `oemId !== "mentra"` (i.e., only accept users who came in directly through the Mentra-branded app). |
| `whitelist` | Accept only if `oemId` is in a configured allow-list. |

How the miniapp dev sets this policy lives in the miniapp spec. From
this doc's perspective: Mentra emits the payload with `oemId`
populated; downstream policy enforcement is the miniapp's concern.

## Security considerations

- **Replay protection.** Every OEM-issued JWT's `jti` is recorded in
  `seenJtis` on accept. Subsequent presentation of the same `jti` is
  rejected. Entries expire shortly after the JWT's own `exp`. Plain
  English: "you can't reuse the same token twice; we forget about it
  shortly after it would have expired anyway."
- **Audience validation.** Mentra rejects any JWT whose `aud` is not
  `"mentra"`. Prevents an OEM-issued JWT meant for another Mentra-side
  audience (or another service entirely) from being replayed against
  the token endpoint.
- **Algorithm allowlist.** Mentra accepts only `EdDSA`, `RS256`, or
  `ES256`. `none` is rejected. This avoids the classic "algorithm
  confusion" JWT bug.
- **Issuer pinning.** The `iss` claim is used to look up the OEM's
  public key, but the key is the source of truth for verification. An
  attacker who changes `iss` to point at a different OEM still fails
  verification because they don't have that OEM's private key.
- **TLS-required.** All endpoints require HTTPS. No fallback to HTTP.
- **Rate limiting.** Per-OEM rate limits on `POST /api/oem/oauth/token`
  to prevent abuse. Concrete limits TBD.
- **Audit logging.** Every token exchange, refresh, and revocation
  emits a structured log line with `oemId`, `mentraUserId` (or
  `oemUserId` before mapping), endpoint, success/failure. Retention
  policy is an open question.
- **Refresh token rotation.** Every refresh issues a new refresh token
  and invalidates the old one. If a leaked refresh token is used by
  an attacker, the legitimate client's next refresh fails (because
  the token has been rotated), surfacing the breach.
- **Refresh tokens stored hashed at rest.** A DB leak doesn't expose
  refresh tokens directly.
- **OEM private key never leaves the OEM's backend.** Mentra has only
  the public key. We have no role in protecting their private key.

## TEST OEM

A reference implementation and test fixture. Lives at
`cloud-v2/test/test-oem/`. Doubles as canonical partner-integration
example.

### What it is

A small standalone Bun service that mimics what a real OEM's backend
does. Tests spin it up alongside the cloud under test, register it
with Mentra (once), and drive it programmatically.

### Setup

- TEST OEM generates an Ed25519 keypair on first run. Stores private
  key locally (e.g., `./test-oem-private.pem`).
- TEST OEM registers itself with Mentra at startup by calling
  `POST /api/oem/jwks` with the public key. (In a real OEM flow, this
  is done via the portal once; for tests, automating it is fine.)
- TEST OEM's `oemId` is configured via env var, default `"test-oem"`.

### Endpoints

```
POST /test-oem/mint-jwt
  body: { oemUserId: string, extraClaims?: object }
  returns: { jwt: string }
  Effect: signs an OEM-format JWT for the given user, with the
          configured oemId as `iss`. Optional extra claims for tests
          that need them.

POST /test-oem/configure-user
  body: { oemUserId: string, displayName?: string, ... }
  returns: { ok: true }
  Effect: stores metadata in-memory; included in mint-jwt as
          custom claims if requested.

DELETE /test-oem/users/:oemUserId
  returns: { ok: true }
  Effect: simulates the OEM deauthorizing a user; future
          mint-jwt calls for this user fail with 404.

GET /test-oem/.well-known/jwks.json
  returns: standard JWKS document with the test OEM's public key
  Used: when tests run TEST OEM in JWK-URL mode instead of static
        key mode.
```

### Tests use it like

```ts
// 1. Get a JWT for a synthetic user
const { jwt } = await fetch(`${TEST_OEM_URL}/test-oem/mint-jwt`, {
  method: "POST",
  body: JSON.stringify({ oemUserId: "test-user-1" }),
}).then(r => r.json());

// 2. Exchange it with Mentra
const tokens = await fetch(`${MENTRA_URL}/api/oem/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: jwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  }),
}).then(r => r.json());

// 3. Use the access token to call Mentra APIs as test-user-1
```

### Deployment

For local dev: run as a Bun process alongside the cloud.
For CI: deployed as a sibling service in the test K8s namespace.
For test environments in Porter: a `test-oem` Porter app sitting next
to `cloud-test`.

### Multiple TEST OEMs

Some tests need to exercise multi-OEM scenarios (e.g., miniapp trust
policies, OEM isolation). The TEST OEM is parameterized by `oemId` via
env var, so spinning up two instances with different IDs is enough.

## Out of scope

- **OEM portal UX.** Lives in `cloud-v2/issues/002-oem-portal/`.
- **Migration of existing email-based Mentra users.** Separate spec.
  Likely treats Mentra-as-OEM-#0 but the migration story (existing
  Supabase users) is its own thing.
- **Multi-region key distribution / caching.** Single-region for now.
- **API-key path (Option 6 from spec).** Deferred. Could be added
  later as a parallel endpoint without disturbing this design.
- **Specific protocol versioning.** The endpoints live at `/api/oem/...`
  with no version prefix today. If we need breaking changes later
  we'll add a version segment.
- **Commercial / contract terms with OEMs.** Engineering only.

## Open questions

- **Specific TTLs.** Proposed: 5-minute OEM-JWT TTL, 1-hour Mentra
  access token TTL, 30-day Mentra refresh token TTL. Worth team
  discussion based on user-experience considerations (how often do
  we want users to re-authenticate at the OEM layer vs the Mentra
  layer).
- **Session ID addressability.** `DELETE /api/oem/sessions/:sessionId`
  needs a stable session identifier. Options: (a) derive from the
  refresh token's hash, (b) store as a separate field on the
  `refreshTokens` document. (b) is cleaner; (a) avoids storing
  another piece of data. My lean: (b).
- **Audit log retention.** Concrete policy needed (e.g., 90 days hot
  storage, archive to cold storage after, delete after 2 years).
- **Rate limits.** Specific limits per OEM for the token endpoint.
  Probably set generously initially and tune based on real traffic.
- **`oem_id` claim in the Mentra access token.** Proposed to include
  it, which lets resource servers see the attesting OEM without a DB
  lookup. But it also means the access token carries OEM identity
  through the system. Tradeoff between observability and minimalism.
  My lean: include it.
- **OEM JWT max clock skew.** Proposed 5 minutes. Standard, but worth
  confirming.
- **Initial OEM admin assignment.** When an OEM signs up, who's the
  first admin? Probably whoever clicked "create account," but the
  portal spec needs to nail this down.

## Files this design implies

Rough sketch, will be confirmed when implementation starts:

```
cloud-v2/packages/auth/
  src/
    routes/
      oauth-token.ts             POST /api/oem/oauth/token
      oauth-refresh.ts           POST /api/oem/oauth/refresh
      me.ts                      GET  /api/oem/me
      jwks.ts                    POST /api/oem/jwks
      sessions.ts                DELETE endpoints
    services/
      JwtVerifier.ts             OEM-signed JWT verification
      JwtIssuer.ts               Mentra-issued JWT signing
      KeyResolver.ts             public-key lookup (static + JWKS URL)
      RefreshTokenStore.ts       refreshTokens collection access
      JtiTracker.ts              seenJtis + revokedJtis access
      UserMapper.ts              (oemId, oemUserId) → MentraUserId
    schemas/
      oems.ts                    Mongo collection schemas
      users.ts
      refreshTokens.ts
      revokedJtis.ts
      seenJtis.ts
cloud-v2/test/test-oem/
  src/
    server.ts                    TEST OEM endpoints
    keypair.ts                   key generation, JWT signing
```

Treat as a sketch, not a commitment. The `cloud-v2/packages/auth/`
internal layout will be refined when the implementation starts.
