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
  (same pattern as the console Pages proxy) or `CORE_PUBLIC_URL` otherwise.
- Browser: Android Custom Tabs / iOS ASWebAuthenticationSession via
  `expo-web-browser` (already an Expo app); scheme `com.mentra` is registered.
- Apple provider is the same route pair; Supabase handles the Apple client
  secret; required by App Store review because Google login is offered.

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

## 6. Account deletion fan-out

`delete/confirm` runs, in order: revoke all V2 sessions, delete V2 user row,
delete GoTrue user (admin API), then while V1 exists call V1's internal
deletion endpoint server-to-server (env `LEGACY_CORE_URL` +
`LEGACY_DELETE_SECRET`; both live only in core's Doppler). V1 fan-out failures
are logged and retried by a small reconciliation job rather than failing the
user-facing request (the user's V2 identity is already gone).

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

## 9. Phase 2 seam (for the record)

Everything Supabase-specific is behind `gotrue.client.ts` + the
`tenantUserId = Supabase user id` mapping. A Phase 2 credential-store swap
(native store or WorkOS AuthKit) replaces that client and keeps
`tenantUserId` stable by importing the same subject ids, with no mobile or
session-model change. Not scheduled; recorded so the boundary is respected.
