# User Auth: spike

**Status:** Findings and open questions. Not a proposal yet. This surfaces how
user auth works in v1, how it should work in v2, and the design space for the one
genuinely new piece: developer "auto auth" into local mini apps.

## Scope

User identity and auth across three audiences:

1. **Mentra's own users** (the Mentra consumer app).
2. **OEM users** (an OEM's app, identity owned by the OEM).
3. **Developers** who want Mentra to inject auth into their mini app so the mini
   app can call the developer's own backend, without the user logging in.

Audience 2 (OEM users) is already specced in [`./oem-auth/`](./oem-auth/).
Importantly, oem-auth already decided the **identity model** and the **miniapp
trust handoff** in its "Q2: Mentra to miniapp identity" section, and explicitly
deferred "Miniapp to developer-server auth (Phase 2, separate concern)." This
doc is that Phase 2, plus the Mentra-user issuance piece. It **inherits** Q2's
decisions rather than re-opening them:

- `MentraUserId` is an opaque ULID (`mu_...`), created on first sight of an
  `(oemId, oemUserId)` pair (oem-auth `design.md`, `users` collection). So the
  same human via two OEMs is two different `MentraUserId`s. This is settled.
- Mentra-direct users carry the reserved `oemId = "mentra"`.
- The auto-auth handoff to a dev backend carries `{ mentraUserId, oemId, ... }`,
  and the dev configures a trust policy: `trust-all` (default), `mentra-direct-only`,
  or `whitelist`. This spike does not change that; it specifies the *mechanism*
  that delivers that payload to a dev backend now that mini apps are local.

## Part 1: how it works in v1 today

### User identity (the core token)

- The user signs in through **Supabase** (email/password, Google, etc.) at
  `account.mentra.glass` or in the mobile app. Legacy Authing is also supported.
- The client posts the Supabase token to cloud `POST /auth/exchange-token`. Cloud
  verifies it (`SUPABASE_JWT_SECRET`), `findOrCreateUser(email)`, and issues a
  **core token**: a JWT signed with the symmetric `AUGMENTOS_AUTH_JWT_SECRET`
  (HS256), claims `{ sub, email, organizations, defaultOrg }`.
  (`cloud/packages/cloud/src/utils/generateCoreToken.ts`,
  `.../api/hono/routes/auth.routes.ts` `exchangeToken`.)
- **`userId` is the email.** Everything downstream keys on email
  (`c.get("email")` is used as the user id).
- The mobile app holds the core token and sends it as `Authorization: Bearer`
  to cloud; `validateCoreTokenMiddleware` verifies it with the shared secret.

Properties worth noting: symmetric secret (only cloud can verify), identity ==
email, no asymmetric/JWKS story.

### Developer "auto auth" (webview token injection)

This is the v1 handshake that injects auth into a mini app webview so it is
authenticated against the developer's backend with no login. Full writeup in
[`cloud/.architecture/auth.md`](../../../../../cloud/.architecture/auth.md); summary:

The mini app is a **remote** web app (the developer's server). Two paths produce
the same result, `useMentraAuth() -> { userId, frontendToken }`:

- **Path A (mobile, automatic).** The phone app (holding the core token) calls
  cloud for two tokens and appends them to the webview URL:
  - `aos_temp_token`: opaque, one-time, ~60s, tied to user+packageName
    (`/auth/generate-webview-token` -> `temp-token.service`).
  - `aos_signed_user_token`: an **RS256** JWT (`sub` + `frontendToken`, ~10m,
    `/auth/generate-webview-signed-user-token`), verifiable client-side with
    Mentra's public key (hardcoded in `@mentra/react`).
  - plus a `cloudApiUrl` + HMAC checksum (`/auth/hash-with-api-key`).
- **Path B (browser).** No tokens in URL; user clicks "Sign in with Mentra" ->
  `account.mentra.glass` login -> redirect back with the same tokens
  (`/api/account/oauth/...`).

The developer's SDK backend (`@mentra/sdk` `createMentraAuthRoutes`) then:
- exchanges the temp token at cloud `POST /auth/exchange-user-token`,
  authenticated by the **app's API key** (`validateAppApiKeyMiddleware`),
  getting back `{ userId }`; and/or verifies the RS256 JWT.
- derives a **`frontendToken = userId:sha256(userId + sha256(apiKey))`** and an
  HMAC session cookie, both verifiable by the dev backend because it knows its
  own API key.

The trust anchors in v1: a per-app **API key** (symmetric, issued from the Dev
Console) for the dev backend, and a hardcoded Mentra **public key** for
client-side JWT checks. `userId` is the email.

## Part 2: what changes in v2

Two structural shifts force a redesign:

1. **Mini apps are local.** In v2 a mini app is a bundle that runs on-device in
   the Mentra Runtime (a webview plus the JS engine), not a remote server. There
   is no remote webview URL for the phone to inject tokens into. The runtime is
   right next to the webview and can hand it auth directly.
2. **v2 already has a real token.** The oem-auth work
   ([`./oem-auth/`](./oem-auth/)) established a **Mentra access token**:
   an **Ed25519 (EdDSA)** JWT, claims `sub = mentraUserId`, `oemId`,
   `sessionId`, `jti`, with `aud`/`iss`, 1h expiry and a rotating refresh token,
   verifiable by any service holding Mentra's public key
   (`packages/shared/src/auth.ts`). This is asymmetric and is what the runtime
   transport already verifies.

So v2 should: unify all user identity on the **Mentra access token** and
`mentraUserId` (retire the symmetric core token and email-as-id), and rebuild
auto auth around asymmetric, audience-scoped tokens the dev backend verifies via
a public key, retiring the `frontendToken` API-key hash.

### Audience 1: Mentra's own users

Mentra's consumer app is, architecturally, just the first consumer of the OEM
Toolkit (Mentra is "OEM zero"). Two ways to issue it a Mentra access token:

- **(a) Mentra as its own OEM.** Supabase is Mentra's identity provider; a small
  Mentra-side issuer mints an OEM-style subject JWT that goes through the same
  `POST /api/oem/oauth/token` exchange. One code path for everyone.
- **(b) Dedicated Mentra login.** A direct endpoint that takes the Supabase
  session and issues the same Ed25519 access token without the OEM exchange
  shape.

Either way the output is the same access token format. Lean: (a), so there is a
single issuance and revocation path. Open question below.

### Audience 2: OEM users

Already specced: the OEM mints an install JWT, exchanges it via RFC 8693 for the
Mentra access token; Mentra maps `(oemId, oemUserId)` to an opaque `MentraUserId`
ULID, created on first sight (oem-auth `design.md`). Identity is owned by the OEM.
Nothing new here; user-auth just consumes the same token, and the dev-backend
handoff carries `mentraUserId` + `oemId` per Q2 Option B.

### Audience 3: developer auto auth into local mini apps (the new work)

Goal unchanged from v1: a mini app calls the developer's backend as the current
user, with no login, and the backend can trust who the user is. What changes is
the mechanism, because the mini app is local and we now have asymmetric tokens.

Sketch to pressure-test:

1. The mini app declares it has a backend (in `miniapp.json`), with the
   audience/key id it expects.
2. At launch, the on-device runtime (which holds the user's Mentra access token)
   obtains a short-lived **app-scoped user token**: an Ed25519 Mentra-signed JWT
   with `sub = mentraUserId`, `oemId` (so the backend can apply its Q2 trust
   policy), `aud = <packageName>` (scoped to this one app), short expiry. Likely
   minted by a cloud-core endpoint the runtime calls with
   the user's access token (the v2 analog of
   `generate-webview-signed-user-token`, but asymmetric, audience-scoped, and
   keyed on `mentraUserId`). Minting stays server-side so it can be revoked and
   audited.
3. The runtime injects this token into the **local** webview directly (through
   the runtime bridge / SDK, not a URL param, since there is no remote URL). The
   `@mentra/react` `useMentraAuth()` reads it from the bridge.
4. The webview calls the developer's backend with
   `Authorization: Bearer <app-scoped-token>`.
5. The developer's backend verifies the token against **Mentra's published
   public keys (a JWKS endpoint)**, checks `aud == its packageName`, and applies
   its Q2 trust policy on `oemId` (`trust-all` / `mentra-direct-only` /
   `whitelist`). No per-request call to Mentra, no symmetric `frontendToken`, no
   API-key hash.
6. The runtime refreshes and re-injects before expiry (it holds the user's
   access token, so it can re-request).

This is the same identity and trust model oem-auth Q2 already chose; the SDK
helper (`@mentra/react` `useMentraAuth()` and the backend verifier) just reads it
from a JWKS-verified JWT instead of the v1 temp-token/`frontendToken` dance. For
privacy-sensitive apps, oem-auth's Option C (a per-app pseudonymous
`sub = H(mentraUserId, packageName)`) can be layered on later without changing
this mechanism.

What this buys us over v1:
- Standard asymmetric verification (JWKS) instead of the bespoke
  `userId:sha256(...)` scheme; key rotation without shipping a new SDK.
- Audience pinning to one packageName, so a token for app A cannot be replayed
  against app B's backend.
- `mentraUserId` instead of email as the stable identifier.

API keys do not disappear entirely: a dev backend that needs to call Mentra
server-to-server (cloud-core or runtime APIs on the user's behalf) still needs a
credential. The proposal narrows API keys to that server-to-server role and
takes them out of the per-user verification path. Decide below.

Mini apps with **no backend** need none of this: the local SDK already hands them
`mentraUserId` on-device. Auto auth only matters for apps that call out to a dev
backend.

The browser path (a webview opened outside the app, or a companion web app) still
needs a "Sign in with Mentra" OAuth flow that ends in the same app-scoped token.
Carry the v1 Path B forward, issuing the v2 token.

## Already settled by oem-auth (not open)

- Identity model: `MentraUserId` is an opaque ULID per `(oemId, oemUserId)`. Not
  email-based.
- Dev-backend handoff identity + trust: `mentraUserId` + `oemId` with a dev trust
  policy (`trust-all` default), and Option C pseudonymous IDs as a future opt-in.
- Migration of existing email-based Mentra users is acknowledged in oem-auth
  `design.md` as a **separate spec**; track it there, not here.

## Open questions

1. **Mentra-user issuance:** Mentra-as-its-own-OEM with reserved `oemId = "mentra"`
   (single exchange path) vs a dedicated Mentra login endpoint. Lean:
   as-its-own-OEM.
2. **JWKS.** v1 hardcoded the public key in the SDK; v2 should publish a JWKS URL
   for rotation. Where is it hosted (cloud-core), and what is the cache/rotation
   policy for dev backends?
3. **Who mints the app-scoped token:** a cloud-core endpoint (revocable, audited,
   one round trip at launch) vs a delegated on-device key (no round trip, harder
   to revoke). Lean: cloud-core endpoint.
4. **Token injection into the local webview.** Exact bridge mechanism the runtime
   uses to pass the token (and refreshes) to the webview, and how
   `useMentraAuth()` consumes it on-device vs from URL params on the web.
5. **API key role.** Keep API keys strictly for dev-backend-to-Mentra
   server-to-server calls, or retire them? What still needs them in v2?
6. **Audience granularity.** Per-packageName audience (safest) vs a shared
   "miniapp" audience. Lean: per-packageName.
7. **Where the dev-server auth mechanism is specced.** oem-auth says the handoff
   "exact mechanism is part of the miniapp spec." Decide whether the Phase 2
   mechanism in this doc lands here (user-auth) or in the mini-app platform spec.

## References

- [`cloud/.architecture/auth.md`](../../../../../cloud/.architecture/auth.md): the full
  v1 webview auto-auth writeup.
- v1 code: `cloud/packages/cloud/src/api/hono/routes/auth.routes.ts`,
  `.../utils/generateCoreToken.ts`, `.../services/core/temp-token.service.ts`,
  `cloud/packages/sdk/src/app/webview/index.ts`,
  `cloud/packages/react-sdk/src/`.
- [`./oem-auth/design.md`](./oem-auth/design.md): the Mentra access token shape
  and the RFC 8693 exchange (audience 2, and the token v2 unifies on).
- [`../../002-cloud-runtime/protocol.md`](../../002-cloud-runtime/protocol.md):
  the runtime transport that already verifies the Mentra access token.
- `packages/shared/src/auth.ts` (cloud-v2): the access-token verifier and claim
  shape.
