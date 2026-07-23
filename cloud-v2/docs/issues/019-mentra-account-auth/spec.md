# 019 spec: the /api/account contract

**Status:** Draft for review. Gated on spike.md (complete); design.md describes
implementation. All decisions referenced here are spike.md section 5.

## Principles

- Same conventions as the existing auth endpoints: JSON bodies, RFC-shaped
  errors `{ error: <code>, error_description: <text> }` (oauth.types), and the
  standard `TokenResponse` (`access_token`, `refresh_token`, `token_type:
  "Bearer"`, `expires_in`) so mobile reuses the cloud-client token store
  unchanged (1h access, 30d rolling refresh).
- The device ends up holding V2 tokens only. No Supabase material ever reaches
  the client (spike decision 2).
- Login endpoints never reveal whether an email exists (uniform errors and
  uniform timing on `login`, `password/forgot`, `signup` conflicts).
- Every account endpoint is rate limited per IP and per email (design.md picks
  the mechanism; the contract just guarantees 429 with `rate_limited`).

## Error codes

Reused: `invalid_request`, `invalid_grant`, `unauthorized_client`,
`server_error`. Added for account flows:

| code | meaning | HTTP |
|---|---|---|
| `invalid_credentials` | wrong email/password (never distinguishes which) | 401 |
| `verification_required` | account exists but email not verified | 403 |
| `weak_password` | GoTrue policy rejection, description passes through | 400 |
| `email_taken` | signup conflict (only after verified-email check; see note) | 409 |
| `code_invalid` | OTC/reset/deletion code wrong, expired, or used | 400 |
| `rate_limited` | too many attempts | 429 |

Note on `email_taken` vs enumeration: signup returns the same
"check your email" success shape whether the address is new or already
registered; `email_taken` is only returned for authenticated email-change
conflicts.

## Endpoints

All under `/api/account`. "auth" means a valid V2 access token (Bearer).

### Credentials

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `POST /signup` | none | `{email, password}` | `202 {status: "verification_sent"}` (uniform; see enumeration note) |
| `POST /verify/resend` | none | `{email}` | `202` uniform |
| `POST /login` | none | `{email, password}` | `200 TokenResponse` or `invalid_credentials` / `verification_required` |
| `POST /logout` | auth | `{everywhere?: boolean}` | `204`; `everywhere` revokes all of the user's refresh tokens |
| `GET /me` | auth | - | `200 {mentraUserId, email, name?, avatarUrl?}` (spike decision 5) |

### Password and email

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `POST /password/forgot` | none | `{email}` | `202` uniform (sends code email) |
| `POST /password/reset` | none | `{email, code, newPassword}` | `200 TokenResponse` (reset logs the user in; all other sessions revoked) |
| `POST /password/change` | auth | `{currentPassword, newPassword}` | `204`; other sessions revoked |
| `POST /email/change` | auth | `{newEmail, password}` | `202 {status: "verification_sent"}`; applies on verified click |

### OAuth (Google, Apple)

Flow (spike decision 1): system browser, core-hosted, PKCE between app and
core, one-time code back via deep link.

| Endpoint | Auth | Params | Returns |
|---|---|---|---|
| `GET /oauth/:provider/start` | none | `state`, `code_challenge` (S256) | `302` into the provider flow (via Supabase authorize) |
| `GET /oauth/callback` | none | provider params | `302 com.mentra://auth/callback?code=<otc>&state=<state>` |
| `POST /oauth/complete` | none | `{code, code_verifier}` | `200 TokenResponse` |

- `provider` is `google` or `apple` (Apple is required by App Store policy
  once Google is offered).
- The one-time code is single use, 60 second TTL, bound to the
  `code_challenge` from `start`. `complete` verifies the `code_verifier`
  against it (PKCE), so an intercepted deep link is useless without the
  in-app verifier.
- The callback deep link uses the existing app scheme `com.mentra` (from
  `mobile/app.config.ts`).

### Account deletion (spike decision 6; ships in Phase 1)

| Endpoint | Auth | Body | Returns |
|---|---|---|---|
| `POST /delete/request` | auth | - | `202` (sends confirmation code email) |
| `POST /delete/confirm` | auth | `{code}` | `204`; deletes Supabase user, V2 user + sessions, fans out to V1 deletion server side while V1 exists |

## Token and identity design

- Internally, a successful credential/OAuth verification mints a short-lived
  (60s, jti-bearing) **Ed25519 `mentra-account` subject token** and feeds it
  through the SAME code path as OEM token exchange, producing the standard V2
  session. No new session semantics; the account module is "Mentra's OEM
  backend" running in-process (README placement decision).
- The `mentra` tenant gets a real `oems` row (static public key = the account
  signing key). Refresh authorization then works through the normal OEM check,
  and the `MENTRA_OEM_ID` special case plus the symmetric Supabase/legacy
  branch of `resolveSubjectIdentity` are deleted (spike decision 4: no
  migration ramp, so nothing needs them).
- `/.well-known/jwks.json` gains the `mentra-account-1` public key (audit
  visibility; verification is in-process).

## Mobile client contract

The existing `authClient.ts` interface is kept; a new provider implements it
against `/api/account/*` so screens change minimally:

| authClient method | maps to |
|---|---|
| `signUp` | `POST /signup` |
| `resendSignupEmail` | `POST /verify/resend` |
| `signInWithPassword` | `POST /login` |
| `resetPasswordForEmail` | `POST /password/forgot` |
| `resetPasswordByCode` | `POST /password/reset` |
| `updateUserPassword` | `POST /password/change` |
| `updateUserEmail` | `POST /email/change` |
| `googleSignIn` / `appleSignIn` | `GET /oauth/:provider/start` -> browser -> `POST /oauth/complete` |
| `getUser` / `getSession` | `GET /me` + local V2 token state |
| `signOut` | `POST /logout` |
| `startAutoRefresh` / `stopAutoRefresh` | cloud-client refresh loop (already exists); no separate auth refresher |
| `onAuthStateChange` | driven by local token-state transitions |

Removed from mobile: `supabase-js`, the anon key, `restComms.exchangeToken`,
`updateSessionWithTokens` (Supabase deep-link session hand-off).

## Rollout and compatibility

- This is a breaking-cutover app release (spike decisions 3 and 4): on first
  boot the app wipes stored Supabase/legacy auth material and shows the new
  login screen. No dual-stack window in the client.
- Server ships first, dark, to all environments (new endpoints are additive).
- The app release that switches to `/api/account` sets the forced-upgrade
  floor via the existing `GET /api/client/min-version` so stragglers on the
  old flow are upgraded rather than half-broken.
- The breakage ledger (spike section 6) is the accepted V1 fallout list; only
  account deletion is exempt (it moves with this work).

## Security requirements summary

- PKCE mandatory on OAuth; state validated; one-time codes single-use/60s.
- No tokens in URLs except the single-use OTC in the deep link (bound to PKCE).
- Uniform responses/timing on unauthenticated email-bearing endpoints.
- Password reset and change revoke all other sessions.
- `logout everywhere` supported from day one (refresh-token deletion by user).
- jti replay protection on account subject tokens (mechanism already exists
  for exchange).
- Rate limiting on all unauthenticated endpoints (per IP and per email).
