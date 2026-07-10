# 019 design: how the account module is built

**Status:** Draft for review. Implements spec.md; decisions in spike.md 5.

## 1. Module layout (packages/core)

```
src/api/account/
  account.api.ts        // signup/login/logout/me/password/email/delete routes
  oauth.api.ts          // /oauth/:provider/start, /oauth/callback, /oauth/complete
src/services/account/
  account.service.ts    // orchestration: gotrue calls -> subject token -> session
  gotrue.client.ts      // typed server-side Supabase GoTrue client + error map
  one-time-code.service.ts // OTC + email codes (reset, deletion, oauth otc)
src/models/
  account-code.model.ts // hashed one-time codes, TTL-indexed like refreshTokens
```

Mounted under `/api/account` in `api/app.ts`. Rate limiting via a small
middleware over a Mongo TTL counter (no new infra; swap for Redis later if
needed).

Note: while implementing this, `session.service.ts` was split — the crypto key
loading + JWKS moved to `services/signing-keys.service.ts` (it had accreted key
management alongside session lifecycle). The account subject-token key lives
there with the access/miniapp keys. Dependency direction: signing-keys <- token
minting <- session.

## 2. GoTrue (Supabase) server-side integration

Core talks to GoTrue with two credentials, both server-only Doppler secrets
per environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (token grant), and
`SUPABASE_SERVICE_ROLE_KEY` (admin API). The anon key stops shipping in the
app entirely.

| Need | GoTrue call |
|---|---|
| verify email+password | `POST /auth/v1/token?grant_type=password` (transient; response discarded after identity read) |
| signup | `POST /auth/v1/signup` (GoTrue sends the verification email) |
| resend verification | `POST /auth/v1/resend` |
| password reset code | `POST /auth/v1/admin/generate_link` type `recovery` (core emails the code via Resend rather than the raw link) |
| password/email change | `PUT /auth/v1/admin/users/{id}` |
| OAuth authorize | `GET /auth/v1/authorize?provider=...&redirect_to=<core callback>` |
| OAuth code exchange | `POST /auth/v1/token?grant_type=pkce` (core-held verifier for the core<->GoTrue leg) |
| delete user | `DELETE /auth/v1/admin/users/{id}` |

Error mapping lives in `gotrue.client.ts` (GoTrue error -> spec error code);
nothing GoTrue-shaped leaks past the service layer, which is what makes the
Phase 2 credential-store swap a service-internal change.

## 3. Keys, identity, and session minting

- New per-env keypair `MENTRA_ACCOUNT_JWT_PRIVATE_KEY` /
  `MENTRA_ACCOUNT_JWT_PUBLIC_KEY` (Ed25519, kid `mentra-account-1`), added to
  each environment's Doppler config and served in the well-known JWKS.
- A startup migration inserts the `oems` row for tenantId `mentra`
  (`publicKeyMode: "static"`, the account public key), idempotent like the
  existing startup migrations.
- `account.service.ts` flow for any successful verification:
  1. read identity from GoTrue (user id, email, verified flag),
  2. mint a 60s Ed25519 subject token (iss `mentra`, sub = Supabase user id,
     jti, exp),
  3. call the existing `createSession({subjectToken})` so jti replay
     protection, findOrCreateUser (tenantId `mentra`, tenantUserId = Supabase
     user id: SAME identity mapping as today, so existing V2 user rows are
     reused, not duplicated), and refresh-token persistence all run unchanged.
- Cleanup in the same PR (enabled by no-migration, spike decision 4): delete
  the symmetric Supabase/legacy branch of `resolveSubjectIdentity` and the
  `MENTRA_OEM_ID` refresh special case (the new oems row covers it).

## 4. OAuth end to end

```
app                core                        Supabase/provider
 |-- generate verifier+challenge
 |-- open browser: GET /api/account/oauth/google/start?state&code_challenge
 |                  |-- persist {state, challenge} (account-code, 10m)
 |                  |-- 302 --> GoTrue /authorize?provider=google
 |                                     ... Google login ...
 |                  <-- 302 callback?code=...   (redirect_to = core)
 |                  |-- exchange code with GoTrue (server side)
 |                  |-- identity -> subject token -> V2 session
 |                  |-- store TokenResponse under OTC (60s, single use,
 |                  |     bound to code_challenge)
 |                  |-- 302 --> com.mentra://auth/callback?code=OTC&state
 |<-- deep link opens app
 |-- POST /oauth/complete {code: OTC, code_verifier}
 |                  |-- verify S256(verifier) == challenge, burn OTC
 |<-- TokenResponse (V2 access+refresh)
```

- The public callback URL is built from `x-mentra-public-origin` when proxied
  (same pattern as the console Pages proxy); otherwise it is derived from the
  request as `x-forwarded-proto` + Host. TLS terminates at the ingress (the
  pod sees plain http), but ingress-nginx sets `x-forwarded-proto` itself —
  overwriting any client-supplied value — and preserves Host, so this yields
  the public https origin with zero per-environment config.
- Browser: Android Custom Tabs / iOS ASWebAuthenticationSession via
  `expo-web-browser` (already an Expo app); scheme `com.mentra` is registered.
- Apple provider is the same route pair; Supabase handles the Apple client
  secret; required by App Store review because Google login is offered.

### Deployment prerequisites (Supabase configuration)

Two requirements discovered the hard way after the merge (PR #3382); neither
is enforced by code, both fail at runtime if missed — plus a note on how core
builds the redirect URL:

- **`SUPABASE_URL` (section 2) must point at the project's ACTIVE custom
  domain, `https://auth.mentra.glass`.** The old `https://auth.augmentos.org`
  returns Cloudflare error 1014 "CNAME Cross-User Banned": Supabase allows one
  custom domain per project, and that hostname is no longer registered as it.
- **The core OAuth callback must be in the Supabase Auth redirect allowlist**
  (dashboard -> Authentication -> URL Configuration -> Redirect URLs):
  `https://<core public host>/api/account/oauth/callback` plus a `?*` glob
  variant, for every environment/origin that runs the flow. If an entry is
  missing, GoTrue silently falls back to the Site URL (an old "Email
  verified!" landing page) and the flow dead-ends before the core `/callback`
  leg. Per-developer Porter deployments (e.g. `porter.isaiah.yaml` ->
  `core.isaiah.us-west-2.mentraglass.com`) need covering too; the dashboard
  caps the number of entries, so use its glob support instead of one pair per
  origin: `https://core.*.us-west-2.mentraglass.com/api/account/oauth/callback**`
  covers debug/dev/staging and all per-developer deployments in one entry
  (`*` matches a single label, `**` matches the empty string or any query
  string). Prod is NOT matched by that pattern (no environment label in
  `core.us-west-2.mentraglass.com` / `core.mentraglass.com`) and needs its
  own entry for whichever public host serves core.
- **No public-origin env var is needed.** `publicOrigin()` derives the origin
  from the request (PR #3401): the `x-mentra-public-origin` header when
  proxied, otherwise `x-forwarded-proto` + Host. TLS terminates at the Porter
  nginx ingress (the pod sees plain http), but ingress-nginx sets
  `x-forwarded-proto` itself — overwriting any client-supplied value — and
  preserves Host, so the derived origin is the correct public https one in
  every environment with zero config. (An earlier `CORE_PUBLIC_URL` env
  fallback was never set anywhere, so the request-URL fallback emitted
  `http://` origins that GoTrue rejected against the https-only allowlist,
  with the same silent Site-URL fallback as above.)
  Debug tip for all of this: GoTrue's `GET /auth/v1/verify?token=bogus&
  type=signup&redirect_to=<url>` runs the same allowlist check and 303s to
  `<url>` on match or to the Site URL on mismatch, so allowlist entries can
  be probed with curl without completing an OAuth login; the `redirect_to`
  core actually emits is visible in the Location header of
  `GET /api/account/oauth/google/start?state=x&code_challenge=y`.

## 5. Mobile changes

- New `CoreAccountAuthProvider` implementing the existing `authClient.ts`
  interface (mapping table in spec.md), backed by `/api/account/*` and the
  cloud-client token store. Screens keep calling `authClient`.
- Deleted: `mobile/src/utils/auth/provider/supabaseClient.ts`, `supabase-js`
  dependency, the anon key from config, `restComms.exchangeToken()` call in
  `app/index.tsx` (`handleTokenExchange` becomes "ensure V2 session").
- First-boot cutover: if legacy/Supabase auth material exists in storage, wipe
  it and route to login (spike decision 4). One-line version gate: the release
  also bumps the server `min-version` floor.
- Identity side-channels (posthog, sentry, bug reports) read `GET /me` state
  keyed on `mentraUserId` (spike decision 5); single sweep of call sites.
- V1 surfaces broken by this (dashboard, V1 bridge, settings sync, feeds) are
  NOT patched here; they are the spike section 6 ledger for the V1-removal PR.

## 6. Account deletion

`delete/confirm` runs, in order: revoke all V2 sessions, delete the V2 user
row, delete the GoTrue user (admin API). Cloud V1 is a separate system with
its own database and cloud-v2 code has no knowledge of it: there is no
server-to-server fan-out, no legacy env vars, no reconciliation job. If V1
records need cleanup while V1 still exists, that is handled on the V1 side
as an operational task.

## 7. Testing

- **Integration (bun test, mock GoTrue):** a `Bun.serve` GoTrue stub (same
  pattern as the trusted-issuer JWKS test) covering: signup/verify/login happy
  path, invalid_credentials uniformity, reset revokes other sessions, OAuth
  complete with good/bad verifier, OTC single-use and expiry, deletion
  cascade, and that login mints a session whose refresh works (regression
  for the enterprise-refresh class of bug).
- **Contract tests:** the new provider's authClient methods against a live
  local core (mirrors the existing e2e harness scripts under
  `cloud-v2/scripts`).
- **Device e2e (debug env):** fresh install -> signup -> verify -> login ->
  glasses connect -> logout everywhere; Google OAuth round trip through the
  real browser; password reset from email code; account deletion.
- **Negative proof discipline:** each security assertion (OTC replay, PKCE
  mismatch, enumeration uniformity) gets a test that fails when the guard is
  removed, per this repo's established practice.

## 8. Rollout

1. Server lands dark on debug -> dev (additive endpoints; nothing calls them).
2. Device e2e on debug (the account module exercises debug's own DB).
3. Server to staging -> prod via the normal branch flow.
4. Mobile release flips to `/api/account/*`; same release wipes legacy auth
   state on first boot; server `min-version` floor raised.
5. Post-cutover cleanup PR (the V1-removal PR): delete symmetric exchange
   branch usage remnants, SocketComms/WebSocketManager/RestComms, and work the
   spike section 6 ledger.

## 9. OEM reference parity (a hard requirement, not a nicety)

The account module is a REFERENCE implementation of "how to build an OEM
backend." Mentra must not be a privileged tenant: everything the module does
must be doable by an external OEM against public surfaces, so this code can be
handed to OEMs as the example for both their backend and their mobile client.

The mapping:

| Account module does | An external OEM does |
|---|---|
| verifies credentials via GoTrue | verifies credentials however they like |
| holds `MENTRA_ACCOUNT_JWT_PRIVATE_KEY` | holds their own signing key |
| `mentra` oems row (static public key, seeded by migration) | their oems row, registered with Mentra |
| signs subject JWT `iss/aud = mentra`, sub, jti, iat, exp | signs the identical shape with `iss = <their tenantId>` |
| calls `createSession(subjectToken)` in-process | POSTs the token to the PUBLIC `/api/client/auth/exchange` (either from their backend, server-side broker style, or from their app) |
| returns the V2 TokenResponse from `/api/account/login` | returns the V2 TokenResponse from their own `/login` |

The only difference is topological: an in-process function call instead of an
HTTP hop to the exchange endpoint, and `createSession` IS that endpoint's
implementation, so the semantics are identical.

Enforced by tests in `tests/account-auth.integration.test.ts`:
- "OEM parity: the mentra subject token works through the PUBLIC exchange
  endpoint" - if Mentra ever grows a private path the public endpoint cannot
  serve, this fails.
- "OEM parity: a DISABLED mentra oems row blocks refresh like any OEM" -
  refresh authorization goes through the same oems-row check as every OEM (the
  old `mentra` early-return is now only a transitional fallback for
  environments whose seed migration has not run, and dies at the V1 cutover).

The `/api/account/*` endpoints themselves are Mentra's OEM-backend surface
(mounted in core for ops reasons, per the README placement decision); an
external OEM builds their equivalents on their own backend and never calls
ours. The mobile client pattern is likewise symmetric: the app calls "my OEM
backend's login," stores V2 tokens, and hands them to cloud-client; nothing in
the client knows Mentra's backend is special.

## 10. Phase 2 seam (for the record)

Everything Supabase-specific is behind `gotrue.client.ts` + the
`tenantUserId = Supabase user id` mapping. A Phase 2 credential-store swap
(native store or WorkOS AuthKit) replaces that client and keeps
`tenantUserId` stable by importing the same subject ids, with no mobile or
session-model change. Not scheduled; recorded so the boundary is respected.
