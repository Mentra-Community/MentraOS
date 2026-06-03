# Miniapp auto-auth: spike

**Status:** Findings and open questions. Not a proposal yet. This is the "Miniapp
to developer-server auth (Phase 2)" that oem-auth explicitly deferred: how Mentra
injects auth into a local miniapp so it can call the developer's own backend
with no login. The user identity it carries is the sibling spike,
[`../identity/spike.md`](../identity/spike.md).

## Scope

Goal: a miniapp calls the developer's backend as the current user, with no
login, and the backend can trust who the user is.

This inherits oem-auth's Q2 decisions and does not re-open them:

- The dev-backend handoff identity is `mentraUserId` + `oemId` (the `users._id`
  per `(oemId, oemUserId)`; `oemId = "mentra"` for Mentra-direct users).
- The dev configures a trust policy on `oemId`: `trust-all` (default),
  `mentra-direct-only`, or `whitelist`.
- A per-app pseudonymous `sub = H(mentraUserId, packageName)` (Q2 Option C) is a
  future privacy opt-in.

What this spike specifies is the **mechanism** that delivers that payload to a
dev backend now that miniapps are local.

## Part 1: how v1 works today (webview token injection)

The v1 handshake injects auth into a miniapp webview so it is authenticated
against the developer's backend with no login. Full writeup in
[`cloud/.architecture/auth.md`](../../../../../../cloud/.architecture/auth.md);
summary:

The miniapp is served **remotely** from the developer's server. Two paths produce
the same `useMentraAuth() -> { userId, frontendToken }`:

- **Path A (mobile, automatic).** The phone app (holding the core token) calls
  cloud for two tokens and appends them to the webview URL:
  - `aos_temp_token`: opaque, one-time, ~60s, tied to user+packageName
    (`/auth/generate-webview-token` -> `temp-token.service`).
  - `aos_signed_user_token`: an **RS256** JWT (`sub` + `frontendToken`, ~10m,
    `/auth/generate-webview-signed-user-token`), verifiable client-side with
    Mentra's public key (hardcoded in `@mentra/react`).
  - plus a `cloudApiUrl` + HMAC checksum (`/auth/hash-with-api-key`).
- **Path B (browser).** No tokens in URL; user clicks "Sign in with Mentra" ->
  `account.mentra.glass` login -> redirect back with the same tokens.

The developer's SDK backend (`@mentra/sdk` `createMentraAuthRoutes`) then exchanges
the temp token at `POST /auth/exchange-user-token`, authenticated by the **app's
API key**, getting `{ userId }`; and/or verifies the RS256 JWT. It derives a
**`frontendToken = userId:sha256(userId + sha256(apiKey))`** and an HMAC session
cookie, both verifiable because it knows its own API key.

Trust anchors in v1: a per-app **API key** (symmetric) and a hardcoded Mentra
**public key**. `userId` is the email.

## Part 2: v2 (local miniapps)

Two shifts force a redesign:

1. **Miniapps are local.** A miniapp is a bundle running on-device in the
   Mentra Runtime (a webview plus the JS engine), not a remote server. There is
   no remote webview URL to inject tokens into; the runtime is next to the
   webview and can hand it auth directly.
2. **v2 has a real token.** The Ed25519 Mentra access token already exists (see
   [`../identity/spike.md`](../identity/spike.md)), asymmetric and verifiable with
   Mentra's public key.

Sketch to pressure-test:

1. The miniapp declares it has a backend (in `miniapp.json`), with the
   audience/key id it expects.
2. At launch, the on-device runtime (which holds the user's Mentra access token)
   obtains a short-lived **miniapp-scoped user token**: an Ed25519 Mentra-signed JWT
   with `sub = mentraUserId`, `oemId` (so the backend can apply its Q2 trust
   policy), `aud = <packageName>` (scoped to this one miniapp), short expiry. Likely
   minted by a cloud-core endpoint the runtime calls with the user's access token
   (the v2 analog of `generate-webview-signed-user-token`, but asymmetric,
   audience-scoped, keyed on `mentraUserId`). Minting stays server-side so it can
   be revoked and audited.
3. The runtime injects this token into the **local** webview directly (through
   the runtime bridge / SDK, not a URL param). `@mentra/react` `useMentraAuth()`
   reads it from the bridge.
4. The webview calls the developer's backend with
   `Authorization: Bearer <miniapp-scoped-token>`.
5. The developer's backend verifies the token against **Mentra's published public
   keys (a JWKS endpoint)**, checks `aud == its packageName`, and applies its Q2
   trust policy on `oemId`. No per-request call to Mentra, no symmetric
   `frontendToken`, no API-key hash.
6. The runtime refreshes and re-injects before expiry (it holds the user's access
   token, so it can re-request).

What this buys over v1:

- Standard asymmetric verification (JWKS) instead of the bespoke
  `userId:sha256(...)` scheme; key rotation without shipping a new SDK.
- Audience pinning to one packageName, so a token for miniapp A cannot be replayed
  against miniapp B's backend.
- `mentraUserId` instead of email as the stable identifier.

API keys do not vanish: a dev backend that calls Mentra server-to-server still
needs a credential. The proposal narrows API keys to that role and takes them out
of the per-user verification path.

Miniapps with **no backend** need none of this: the local SDK already hands them
`mentraUserId` on-device. Auto-auth only matters for miniapps that call a dev backend.

The browser path (a webview opened outside the app, or a companion web app) still
needs a "Sign in with Mentra" OAuth flow that ends in the same miniapp-scoped token.
Carry v1's Path B forward, issuing the v2 token.

## Decided (in [`../spec.md`](../spec.md))

- **Mint endpoint:** `POST /api/client/auth/miniapp-token` (cloud-core, Bearer
  access token), TTL configurable, default 1h.
- **JWKS:** `/.well-known/jwks.json` on cloud-core, separate signing keys for
  access vs miniapp tokens, `kid` rotation.
- **Audience:** per-packageName (`aud = <packageName>`).
- **Server side is specced in `../spec.md`;** this doc owns the end-to-end flow.

## Open questions

1. **Token injection bridge (client-team coordination).** Exact mechanism the
   on-device Runtime uses to pass the token (and refreshes) to the webview and the
   Crust engine, and how `useMentraAuth()` consumes it on-device vs from URL
   params on the web.
2. **API key role.** Keep API keys strictly for dev-backend-to-Mentra
   server-to-server calls, or retire them? What still needs them in v2?

## References

- [`cloud/.architecture/auth.md`](../../../../../../cloud/.architecture/auth.md):
  the full v1 webview auto-auth writeup.
- [`../identity/spike.md`](../identity/spike.md): the user identity this carries.
- [`../oem-auth/spec.md`](../oem-auth/spec.md): Q2 (miniapp identity handoff,
  trust policies, Option C) that this inherits.
- v1 code: `cloud/packages/sdk/src/app/webview/index.ts`,
  `cloud/packages/react-sdk/src/`,
  `cloud/packages/cloud/src/api/hono/routes/auth.routes.ts`.
