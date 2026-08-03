# 019 - Mentra account auth: mobile login on Cloud V2

**Status:** Docs complete, ready for review. spike.md (V1 dependency ledger +
decisions), spec.md (the /api/account contract), and design.md (implementation
plan) are all in this folder. Implementation not started.

## Goal (the actual headline)

**Make it possible to build a version of the MentraOS mobile app with zero
dependency on legacy Cloud V1.** Replacing the login system is the first and
enabling cut: identity is the thing every other legacy connection's auth flows
through, so nothing else can move off V1 while V1 still owns login. But the
end state is a V1-free build, and the spike inventories the FULL V1 surface
(not just auth) so the remaining cuts can be sequenced. Today no build flag or
code path exists that could even express "V2 only"; creating that is part of
the work.

## Problem

The MentraOS mobile app's login is a Cloud V1 era stack. The app embeds
`supabase-js` directly (`mobile/src/utils/auth/provider/supabaseClient.ts`:
password sign-in, Google OAuth, session refresh, reset flows), and legacy Cloud
V1 (`api.mentra.glass`) sits in the auth chain as the issuer of the legacy
"core token" (`MENTRA_CORE_JWT_SECRET`). Cloud V2's token exchange accepts both
of those as subject tokens (the symmetric branch of `resolveSubjectIdentity` in
`packages/core/src/services/session.service.ts`), resolving to the built-in
`mentra` tenant, while real OEMs use the asymmetric JWKS path.

We want mobile login to be a Cloud V2 concern: the app should talk only to
Cloud V2 for auth, and Cloud V1 should drop out of the chain entirely.

In V2's own architecture language, the component that authenticates end users
and issues subject tokens is "the OEM's backend" (the auth spec treats it as an
external system that calls `/api/oem/*`). For Mentra's consumer app, that role
is currently played by Supabase plus legacy Cloud V1. This issue brings
"Mentra's own OEM backend" into Cloud V2.

## Why the old system needs replacing (motivation)

This is not just a "move to V2" cleanup. The current login stack has real
security and reliability problems, several of which we hit directly during the
2026-07 debug-environment incidents. Ranked by impact:

1. **Symmetric shared secrets: any backend can forge any user.** Core verifies
   Supabase sessions with `SUPABASE_JWT_SECRET` and legacy tokens with
   `MENTRA_CORE_JWT_SECRET`, both HS256. Symmetric verification means the verify
   key is the mint key, and those secrets sit in every environment's Doppler
   config (including throwaway debug). A compromise of any environment forges
   identities valid everywhere, because HS tokens carry no issuer key identity
   and pin no environment. The V2 OEM path (asymmetric, per-env JWKS) exists to
   fix exactly this; Mentra's own login is the last thing not using it.
2. **Three token systems glued together on the client.** The phone juggles a
   Supabase session, a legacy core token, and the V2 access/refresh/runtime/
   miniapp stack, and mobile is the integration point. The failures chased this
   month were all seams between them (refresh 400 -> "re-auth required" ->
   running miniapps stuck on stale tokens; the bug-hunt "cloud token refresh"
   icon failure; "connect button fails after app restart"). Client-side identity
   assembly means every seam failure ships to users and needs an app release.
3. **Long-lived credentials at rest on the device and in URLs.** The full
   Supabase session (access + refresh + profile) sits in plain MMKV storage, and
   the legacy WS connects with the token in the query string
   (`/glasses-ws?token=...`), which lands in logs and proxies. Server-mediated
   auth shrinks what the device ever holds.
4. **No central revocation / session control.** Supabase refresh happens
   client-side against Supabase directly, so the server cannot kill sessions;
   legacy tokens are verify-only symmetric. "Log out everywhere" today spans
   three uncoordinated systems (the same revocation gap as issue 018, item 1).
5. **Third-party coupled into the app binary.** `supabase-js`, the Supabase URL,
   and the anon key are baked into the client, so key rotation or flow changes
   require an app-store release. Behind a core-owned `/api/account/*` surface,
   they become a server deploy.

In fairness, the old design was reasonable V1 pragmatism (Supabase gave OAuth,
email verification, and password reset for free). The debt came from bolting V2
alongside it rather than under it. That is why Phase 1 keeps Supabase (do not
rebuild what works) but moves the seam server-side, which removes the whole
client-glue failure class.

Scope honesty: items 1 and 2 justify this project on their own. Some of the July
pain (E11000 sign-in failures, the chimera UDP host, the debug/dev DB mixup) was
environment and ops drift, NOT login architecture; issue 019 does not fix those
(see the env-hygiene notes) and should not be sold as doing so.

## Placement decision (made)

The account module lives **inside `packages/core`** as a clearly bounded module
(`api/account/*` + `services/account/*`), NOT a separate deployable package.

Rationale:
- Every new deployable is a new Porter service x 4 environments, more domains,
  more Doppler configs, more env-group drift. The July debug-environment
  incident (stale env snapshots, shadowed vars, DB mix-ups) is the standing
  argument against growing that surface.
- Core already owns the identity domain: the `users` collection, session
  minting, the RFC 8693 exchange, Supabase verification, JWKS serving, and
  WorkOS console auth.
- The OEM model can still be dogfooded from inside core: the account module
  signs real Ed25519 subject tokens under a `mentra` issuer and pushes them
  through the same exchange path OEMs use, instead of growing the special-case
  HS256 branch.
- If PII/compliance/scale ever demands isolation, a well bounded module lifts
  out into a package later. The reverse (collapsing a premature service) never
  happens.

## Phasing decision (made)

- **Phase 1 - move the surface, keep Supabase behind it.** Mobile stops
  embedding `supabase-js` and stops touching legacy Cloud V1. It talks only to
  `core.../api/account/*` (signup, login, logout, forgot/change password,
  Google OAuth start/callback, session). Core drives Supabase server side and
  mints the V2 session directly. This removes Cloud V1 from the auth chain
  without rebuilding password storage, email delivery, and OAuth.
- **Phase 2 (optional, later) - swap the credential store** behind that same
  surface (native store, or WorkOS AuthKit like the consoles, pending a
  consumer-scale pricing look). Mobile does not change again.

## Deliverables

### 1. spike.md - answer the unknowns first

Questions the spike must answer, with evidence:
- Everything mobile currently uses auth for: full inventory of
  `authClient.ts` / `supabaseClient.ts` call sites, the legacy core-token
  consumers (legacy WS, anything else), and which surfaces assume a Supabase
  session object (posthog identity, sentry, bug reports, etc.).
- What Supabase features are load-bearing: email/password, Google, Apple?,
  magic links, email verification, password reset emails, account deletion.
  Which are actually enabled and used in production.
- Can core drive Supabase fully server side (admin API vs GoTrue endpoints):
  sign-in, sign-up, OAuth code exchange, reset emails. What breaks with
  captive-portal style OAuth on mobile (deep links / app links back into the
  app).
- Session model: does mobile keep ONE session (V2 access+refresh) with the
  Supabase session held server side, or does it still hold the Supabase
  refresh token? Recommendation with tradeoffs (offline login, token lifetime,
  revocation).
- Legacy coexistence: during rollout, legacy Cloud V1 still needs to
  authenticate the same user (captions v1, store, anything not yet on V2).
  How does a V2-logged-in app talk to legacy (mint a legacy-compatible token
  from core? keep dual login temporarily?).
- Migration: what happens to existing logged-in users on app update (silent
  re-exchange vs forced re-login), and the account-recovery story.
  (RESOLVED in spike.md decision 4: forced re-login, no migration ramp.)

### 2. spec.md - the contract

Must cover:
- The full `/api/account/*` endpoint surface with request/response shapes and
  error taxonomy (RFC-shaped errors like the existing auth endpoints).
- Token/claims design: what the account module issues, how it feeds the
  existing exchange (`mentra` issuer Ed25519 subject token through the OEM
  path), TTLs, refresh, revocation.
- Mobile client contract: the `authClient.ts` interface the app codes against
  (so mobile work can proceed against a stub).
- Security requirements: rate limiting, credential handling rules, jti replay
  protection (exists), device binding if any, logout-everywhere.
- Rollout/compat requirements: minimum app version gating
  (`GET /api/client/min-version` exists), feature flag, kill switch back to
  the old flow.

### 3. design.md - how it is built

Must cover:
- Module layout in core (`api/account/*`, `services/account/*`), what is
  shared with session.service vs new.
- Supabase server-side integration design (keys, which env vars per
  environment, error mapping).
- OAuth redirect flow end to end (mobile deep link scheme, state/PKCE,
  the `x-mentra-public-origin` pattern the consoles use).
- Mobile changes: replace `supabaseClient.ts` provider behind the existing
  `authClient.ts` abstraction; what dies in the legacy connection path.
- Test plan: integration tests against a mocked GoTrue, e2e on device against
  debug env, migration test for existing sessions.
- Rollout plan across debug -> dev -> staging -> prod, with the legacy
  coexistence switch.

## Non-goals (this issue)

- Replacing Supabase as the credential store (Phase 2, separate decision).
- Console/portal auth (already WorkOS, unaffected).
- Enterprise trusted-issuer path (unaffected; it is the model we are
  mirroring).

## References

- `cloud-v2/docs/issues/001-cloud-core/auth/spec.md` (exchange, caller
  convention, `/api/oem/*`)
- `packages/core/src/services/session.service.ts` (`resolveSubjectIdentity`
  symmetric branch this work will eventually retire)
- `mobile/src/utils/auth/` (authClient + supabase provider)
- Issue 014 (enterprise portal / trusted issuers), issue 017 (JWKS fallback),
  issue 018 item 1 (session revocation gap, relevant to logout-everywhere)
