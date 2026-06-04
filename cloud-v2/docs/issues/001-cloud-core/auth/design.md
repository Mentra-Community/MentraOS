# Cloud Core Auth: design

**TL;DR:** How the v2 auth system is built across cloud-core, the cloud-client,
on-device, and the developer SDK, so the full set of code changes is understood
from spec + design alone. Covers the identity model (who `mentraUserId` is and the
v1 to v2 migration bridge) and the miniapp auto-auth flow (dev-backend auth + the
on-device token injection). The wire contract (endpoints, token shapes, JWKS) is
in [`spec.md`](./spec.md); the built OEM-exchange subsystem is in
[`oem-auth.md`](./oem-auth.md).

New here? Read [`README.md`](./README.md) for the map and [`concepts.md`](./concepts.md)
for the from-zero primer (JWTs, asymmetric signing, JWKS, audiences, exchange).

## End to end, in one pass

1. A user signs in. For an OEM user the OEM's backend mints a short-lived subject
   JWT; for a Mentra user the subject is the existing core token (transition) or a
   Supabase session (end state).
2. The **cloud-client** exchanges the subject token at
   `POST /api/client/auth/exchange` for a Mentra **access token** (+ refresh), and
   owns refresh from there. The access token carries `sub = mentraUserId`, `oemId`.
3. For each running miniapp, the cloud-client mints a **miniapp-scoped token**
   (`POST /api/client/auth/miniapp-token`, `aud = <packageName>`), caches it, and
   refreshes before expiry.
4. The on-device runtime injects the miniapp token into the bundle (webview +
   Crust engine). The raw access token never reaches a bundle.
5. The bundle calls its developer backend with the miniapp token. The backend
   verifies it against Mentra's **JWKS**, checks `aud`, and applies its `oemId`
   trust policy. No per-request call to Mentra.

Identity throughout is `mentraUserId` (the `users._id`) + `oemId`.

## Identity model

### `mentraUserId` and the `(oemId, oemUserId)` mapping

`mentraUserId` is the `users` document's Mongo `_id` (an ObjectId, surfaced as its
hex string), created on first sight of an `(oemId, oemUserId)` pair. We use the
DB-generated `_id` rather than minting a separate id. The same human reached via
two OEMs is two different `mentraUserId`s. The mapping and the `users` schema are
specified in [`oem-auth.md`](./oem-auth.md#collection-users).

### Mentra's own users (OEM zero)

"Mentra's own users" spans the consumer app, the Dev Console website, and the
App/MiniApp Store website. Today all three use **one** identity system: Supabase
sign-in plus a core-token exchange (not three separate systems). v2 keeps them on a
single identity system and unifies them on the Mentra access token.

Architecturally Mentra's app is just the first consumer of the OEM Toolkit (Mentra
is "OEM zero"), so Mentra issues its users' tokens as its own **reserved OEM**
(`oemId = "mentra"`): a Mentra-side issuer presents the user's Supabase identity to
the same exchange. For Mentra-direct users the `oemUserId` is the Supabase `sub`
(stable, unlike email). One issuance and revocation path for every surface.

### OEM users

An OEM owns its users' identity. The OEM mints a subject JWT, exchanges it via RFC
8693 for the Mentra access token; Mentra maps `(oemId, oemUserId)` to a
`mentraUserId`, created on first sight. The dev-backend handoff carries
`mentraUserId` + `oemId` (the miniapp auto-auth flow below). Full mechanics in
[`oem-auth.md`](./oem-auth.md).

### How v1 works today (the core token)

Context for the migration bridge below. In v1:

- The user signs in through **Supabase** at `account.mentra.glass` or in the
  mobile app. The client posts the Supabase token to cloud
  `POST /auth/exchange-token`; cloud verifies it (`SUPABASE_JWT_SECRET`),
  `findOrCreateUser(email)`, and issues a **core token**: a JWT signed with the
  symmetric `AUGMENTOS_AUTH_JWT_SECRET` (HS256), claims
  `{ sub, email, organizations, defaultOrg }`.
- **`userId` is the email**; everything downstream keys on it.
- The same flow backs every Mentra-direct surface: the Store exchanges at
  `POST /api/store/auth/exchange-token`, the Dev Console verifies the same core
  token in `console.middleware.ts`, both keyed on email. One identity system across
  consumer app, Dev Console, and Store, with a symmetric secret (only cloud can
  verify) and no asymmetric/JWKS story.

### Migration bridge: core token to v2 access token

During the v1 to v2 transition the client authenticates to both clouds: the legacy
v1 path (existing miniapps, the v1 WS/REST) still wants the core token, and the v2
path (cloud-runtime, the cloud-client) wants the Mentra access token. The low-debt
bridge keeps the existing login unchanged and derives the v2 token from the core
token:

1. The client logs in exactly as today (Supabase to core token at v1) and uses the
   core token for the v1 path, unchanged.
2. Cloud Core v2 exposes the RFC 8693 exchange where, for the reserved `mentra`
   OEM, the **subject token is the core token**. Mentra is "OEM zero," and its
   "OEM-signed JWT" is the core token it already issues.
3. Cloud Core verifies the core token (it knows the shared secret), maps
   `(oemId = "mentra", oemUserId = the Supabase sub carried in the core token)` to
   a `mentraUserId`, and returns the v2 access + refresh tokens.
4. The client now holds **both** tokens at once: core token for v1, access token
   for v2 (cloud-runtime plus miniapp-token minting).

Two details:

- **Mentra-as-OEM verifies with the shared secret, not a registered public key.**
  Every other OEM registers an asymmetric key; Mentra's own subject token (the core
  token) is HS256, so the exchange has one internal issuer (`mentra`) that verifies
  against the shared `AUGMENTOS_AUTH_JWT_SECRET`.
- **`oemUserId` for Mentra-direct is the Supabase `sub`** (stable), which the core
  token already carries as its own `sub`.

End state: once v2 is primary, swap the subject token from "core token" to a
Supabase session (direct Mentra login), same endpoint, and retire the bridge. The
v1 webview auth path (temp token, `frontendToken`, the API-key hash) is replaced by
the asymmetric JWKS flow (see auto-auth below); it stays until v1 is retired.

**Tracked separately:** v1 keyed users (and dev backends) on email. Migrating
existing email-based Mentra users to `mentraUserId` is its own spec.

## Miniapp auto-auth

How Mentra injects auth into a local miniapp so it can call the developer's own
backend with no login. This is the "miniapp to developer-server auth" the OEM-auth
work deferred; the identity it carries is the model above.

It inherits the OEM-auth trust decisions and does not re-open them: the dev-backend
handoff identity is `mentraUserId` + `oemId`; the dev configures a trust policy on
`oemId` (`trust-all` default, `mentra-direct-only`, or `whitelist`); a per-app
pseudonymous `sub = H(mentraUserId, packageName)` is a future privacy opt-in. See
[`oem-auth.md`](./oem-auth.md#miniapp-identity-handoff).

### How v1 works today (webview token injection)

Context. The v1 handshake injects auth into a remotely-served miniapp webview so it
is authenticated against the developer's backend with no login. Two paths produce
the same `useMentraAuth() -> { userId, frontendToken }`:

- **Path A (mobile, automatic).** The phone app appends two tokens to the webview
  URL: a one-time `aos_temp_token` (~60s, tied to user+packageName) and an RS256
  `aos_signed_user_token` (`sub` + `frontendToken`, verifiable client-side with
  Mentra's hardcoded public key), plus a `cloudApiUrl` + HMAC checksum.
- **Path B (browser).** No tokens in URL; "Sign in with Mentra" ->
  `account.mentra.glass` login -> redirect back with the same tokens.

The developer's SDK backend exchanges the temp token (authenticated by the app's
**API key**) for `{ userId }`, and derives a
`frontendToken = userId:sha256(userId + sha256(apiKey))`. Trust anchors: a per-app
API key (symmetric) and a hardcoded Mentra public key; `userId` is the email.

### v2 (local miniapps)

Two shifts force the redesign: miniapps are now **local** (a bundle running
on-device in the Runtime, no remote webview URL to inject into), and v2 has a
**real asymmetric token** (the Ed25519 access token, verifiable via JWKS). The
mechanism:

1. The miniapp declares it has a backend (in `miniapp.json`), with the
   audience/key id it expects.
2. At launch, the on-device runtime (holding the user's access token) obtains a
   short-lived **miniapp-scoped token**: an Ed25519 Mentra-signed JWT with
   `sub = mentraUserId`, `oemId`, `aud = <packageName>`, short expiry. Minted by
   `POST /api/client/auth/miniapp-token` (see [`spec.md`](./spec.md)). Minting is
   server-side so it can be revoked and audited.
3. The runtime injects the token into the bundle's two JS contexts (the webview and
   the Crust engine), not via a URL param; `useMentraAuth()` reads it from the
   bridge. See "On-device injection" below.
4. The webview calls the developer's backend with
   `Authorization: Bearer <miniapp-scoped-token>`.
5. The developer's backend verifies the token against Mentra's **JWKS**, checks
   `aud == its packageName`, and applies its trust policy on `oemId`. No
   per-request call to Mentra, no symmetric `frontendToken`, no API-key hash.
6. The runtime refreshes and re-injects before expiry.

What this buys over v1: standard asymmetric verification (JWKS) with key rotation
that needs no SDK reship; audience pinning so a token for miniapp A cannot be
replayed against miniapp B's backend; `mentraUserId` instead of email. Miniapps
with **no backend** need none of this; the local SDK already hands them
`mentraUserId` on-device. The browser path (a webview outside the app, or a
companion web app) still needs a "Sign in with Mentra" OAuth flow that ends in the
same miniapp-scoped token (v1's Path B carried forward, issuing the v2 token).

### On-device injection

The miniapp receives only the **miniapp-scoped token**; the access token stays in
the cloud-client and is never handed to a bundle. The on-device Runtime obtains the
scoped token from `cloud.auth.getMiniappToken(packageName)` and delivers it.

- **Two JS contexts.** The Runtime runs a bundle in a WebView (UI) and the Crust
  engine (JavaScriptCore / QuickJS, headless logic). A call to the developer
  backend can come from either, so both receive the same token from the same
  Runtime-held source.
- **Delivery.** The SDK's `session.connect()` handshake returns `mentraUserId` and
  the initial miniapp token alongside the session info. The WebView gets it through
  the runtime bridge; `@mentra/react` `useMentraAuth()` reads `{ mentraUserId,
  token }`. The Crust engine gets it from the host via the engine bridge and
  exposes the same shape plus an authed-fetch helper. On the web fallback, the
  "Sign in with Mentra" OAuth flow ends with the same token, so `useMentraAuth()`
  is identical either way.
- **Refresh.** The Runtime re-mints before expiry (via `getMiniappToken`, which
  caches and refreshes per packageName) and pushes the new token to both contexts
  through a dedicated auth-update message; the SDK swaps it in transparently.

```ts
// developer's miniapp (web or headless), via the SDK
const { mentraUserId, token } = useMentraAuth()
await fetch("https://api.theirapp.com/...", {
  headers: { Authorization: `Bearer ${token}` },
})
```

## Components and the code changes

### 1. Cloud Core (`packages/core`)

- **Exchange** `POST /api/client/auth/exchange` (RFC 8693). Add the reserved
  internal **`mentra` OEM** issuer: route on `subject_token_type` and verify the
  Mentra subject tokens with the shared secrets (`AUGMENTOS_AUTH_JWT_SECRET` for
  the core token, `SUPABASE_JWT_SECRET` for a Supabase session), versus the
  OEM-JWT path which verifies against the OEM's registered key. Map
  `(oemId, oemUserId)` to the user record.
- **Refresh** `POST /api/client/auth/refresh` (rotating refresh token).
- **Miniapp-token mint** `POST /api/client/auth/miniapp-token`: verify the access
  token, mint an Ed25519 JWT with `aud = packageName`, configurable TTL. No
  install check.
- **JWKS** `GET /.well-known/jwks.json`: publish both public keys with `kid`.
- **Two Ed25519 signing keys** (access-token key, miniapp-token key) in config.
- **`user.service.ts`:** `mentraUserId` is the `users._id` (drop the
  `mu_${ulid()}` mint and the separate `mentraUserId` field/index).

### 2. Cloud-client auth module (`@mentra/cloud-client`, `cloud.auth`)

- Construct with a subject token (or a `getSubjectToken()` callback). On first use
  call `/exchange`; own refresh via `/refresh`.
- `getMiniappToken(packageName)`: call the mint endpoint, cache per package,
  re-mint before expiry.
- Expose `identity { mentraUserId, oemId }` (decoded from the access token).
- Never expose the access token to a bundle.

### 3. On-device runtime (the bundle host)

- The miniapp connect handshake returns `mentraUserId` + the initial miniapp token
  (from `cloud.auth.getMiniappToken`).
- Inject the miniapp token into the bundle's two JS contexts (webview + Crust), and
  refresh/re-inject before expiry (mechanism in "On-device injection" above).
- The cloud-client is wired in at the runtime's `configureRuntime` hook
  ([`../../004-cloud-client/architecture.md`](../../004-cloud-client/architecture.md)).

### 4. Developer SDK and backend verifier

- The frontend SDK (`@mentra/react` `useMentraAuth()`, and the local SDK in the
  Crust context) reads `{ mentraUserId, token }` from the bridge on device, or from
  the "Sign in with Mentra" OAuth redirect on the web.
- The backend verifier (replacing the v1 `createMentraAuthRoutes` temp-token
  exchange): fetch the JWKS, verify the signature and `aud == packageName`, apply
  the `oemId` trust policy. No per-request call to Mentra, no API-key hash.

## Implementation order

1. Cloud Core: the `_id` change, the exchange (Mentra-as-OEM), the mint endpoint,
   JWKS, the two signing keys.
2. Cloud-client `auth` module (exchange, refresh, `getMiniappToken`).
3. On-device injection + the runtime transport wiring.
4. Developer SDK verifier + `useMentraAuth`.

## Open

- **API key role.** Keep API keys strictly for dev-backend-to-Mentra
  server-to-server calls, or retire them entirely? They are already out of the
  per-user verification path; this is only about whether any role remains.
- **Injection details.** The precise auth-update message format on each bridge (the
  WebView channel and the Crust engine bridge), and whether `useMentraAuth()` and
  the local SDK share one implementation. Finalized during implementation.

## References

- [`spec.md`](./spec.md): the endpoint and token contract.
- [`concepts.md`](./concepts.md): the from-zero primer for every term used here.
- [`oem-auth.md`](./oem-auth.md): the built OEM-exchange subsystem (verification,
  replay protection, data model, the miniapp identity handoff and trust policy).
- [`cloud/.architecture/auth.md`](../../../../../cloud/.architecture/auth.md): the
  full v1 webview auto-auth writeup.
