# 019 spike: the Cloud V1 dependency ledger and the auth chain

**Status:** Complete (2026-07-08). Code inventory done, all open questions
resolved into decisions (section 5), and the accepted-breakage ledger for the
V1-removal PR is recorded (section 6). spec.md is unblocked.

## Purpose

The goal of issue 019 is a mobile build with zero Cloud V1 dependency. This
spike answers: what exactly does mobile still use V1 for, what is the auth
chain we are replacing, what already has a V2 equivalent, and what has none.

## 1. The current login chain (what "replace login" replaces)

Boot sequence today (`mobile/src/app/index.tsx` handleTokenExchange):

1. Mobile signs in with **Supabase directly** (`supabase-js` embedded in the
   app: `mobile/src/utils/auth/provider/supabaseClient.ts`). Email/password,
   Google OAuth, session refresh, reset flows all run client side against
   Supabase with the anon key baked into the binary.
2. Mobile sends the Supabase token to **legacy V1** `POST /auth/exchange`
   (`restComms.exchangeToken`) and receives the legacy **coreToken**
   (HS256, `MENTRA_CORE_JWT_SECRET`).
3. The coreToken authenticates the **V1 websocket** (`/glasses-ws?token=...`,
   token in the query string) via `socketComms.setAuthCreds`.
4. Separately, cloud-client connects to **Cloud V2** by exchanging either the
   Supabase session or that same legacy coreToken at V2
   `POST /api/client/auth/exchange` (the symmetric `mentra`-tenant branch of
   `resolveSubjectIdentity`).

So V1 sits in the middle of the chain, and V2 accepts V1's token as an
identity root. Removing V1 means V2 must root identity itself (Phase 1: core
drives Supabase server side and mints V2 sessions directly).

## 2. The V1 dependency ledger (everything mobile uses V1 for)

Verified against `mobile/modules/engine/src/services/RestComms.ts` (the real
implementation; `mobile/src/services/RestComms.ts` is a re-export shim) and
`mobile/src/services/{SocketComms,WebSocketManager}.ts`.

### 2a. Legacy REST (`backend_url`, via RestComms)

| Endpoint | Method(s) | What it does | V2 equivalent today |
|---|---|---|---|
| `/auth/exchange` | exchangeToken | Supabase token -> legacy coreToken | Replaced by this issue (account module + existing V2 exchange) |
| `/api/client/min` | getMinimumClientVersion | forced-upgrade gate | EXISTS: V2 `GET /api/client/min-version` |
| `/api/client/user/settings` | loadUserSettings / writeUserSettings | server-synced app settings (`saveOnServer` settings) | none on V2 yet |
| `/api/client/calendar` | sendCalendarData | pushes phone calendar to cloud (dashboard/miniapps) | none on V2 yet |
| `/api/client/location` | sendLocationData | pushes location | none on V2 yet |
| `/api/client/notifications` (+`/dismissed`) | notifications feed | phone notifications to cloud | none on V2 yet |
| `/api/client/goodbye` | goodbye | logout/disconnect signal | V2 has session revoke; wiring differs |
| `/api/account/request`, `/api/account/confirm` | requestAccountDeletion / confirmAccountDeletion | account deletion flow | none on V2; must be part of the account module (store compliance requirement) |
| `/app/error` | sendErrorReport | bug/error reports | none on V2 yet |

### 2b. Legacy websocket (`/glasses-ws`, SocketComms + WebSocketManager)

Per the comments in `SocketComms.ts` itself:
- **The OS dashboard is still driven by Cloud V1** (packageName-level dashboard
  content). Quote: "The Cloud V1 cloud still drives the OS dashboard ... move
  it with the websocket itself once the dashboard moves to Cloud V2."
- **The V1 app bridge**: display events, photo/stream/video commands,
  `app_state_change` / `app_started` / `app_stopped` for V1 cloud apps.
- Audio/transcription for V1 cloud apps (V2 apps use cloud-client).

### 2c. Supabase direct (client-embedded)

`supabaseClient.ts` uses: signInWithPassword, sign-up, Google OAuth,
getSession/getUser, setSession, startAutoRefresh, onAuthStateChange, password
reset. The bug-hunt checklist ("account creation, forgot password, change
password, login w/ google") is the live feature set to preserve.

### 2d. Everything else

`backend_url` is also read by dev/UI surfaces (BackendUrl picker, VersionInfo,
NonProdWarning, app/index boot) which become V2-pointing or vestigial. Rough
scale: ~99 grep hits for legacy identifiers in `mobile/src`, but the
load-bearing consumers are the two tables above.

## 3. Tech debt in the old system (why beyond V1-independence)

Ranked; items 1-2 justify the project on their own.

1. **Symmetric shared secrets.** Both identity roots (Supabase session,
   legacy coreToken) are HS256; the verify key IS the mint key and both
   secrets exist in every environment's config. Any env compromise forges any
   user everywhere. V2's asymmetric per-env OEM path exists to fix this;
   Mentra's own login is the last holdout.
2. **Client-side identity glue.** Mobile integrates three token systems
   (Supabase, legacy coreToken, V2 access/refresh/runtime/miniapp). Every seam
   failure ships to users and needs an app release: the July refresh-400 ->
   "re-auth required" -> stale-miniapp-token incident, the bug-hunt "cloud
   token refresh" icon failure, "connect button fails after app restart."
3. **Credentials at rest and in URLs.** Full Supabase session (access +
   refresh + profile) in plain MMKV; legacy WS token in the query string,
   visible in logs.
4. **No central revocation.** Supabase refresh is client-direct so the server
   cannot kill sessions; legacy tokens are verify-only. "Log out everywhere"
   spans three uncoordinated systems (issue 018 item 1 is the same gap).
5. **Third party baked into the binary.** supabase-js + URL + anon key ship in
   the app; any rotation or flow change is an app-store release.
6. **Duplicated per-client logic.** Settings sync, min-version, error
   reporting all exist once in V1 and will exist again in V2; the migration is
   the moment to define them once.

## 4. What this implies for sequencing

1. **Cut 1 (this issue): identity.** Account module in core (per README),
   mobile logs in against `core /api/account/*`, V2 session minted directly,
   legacy `/auth/exchange` unused. Must include account deletion (2a) because
   it is a store-compliance feature living on V1 today.
2. **Cut 2: the client data feeds.** settings sync, calendar, location,
   notifications, error reports need V2 endpoints (mostly thin; the runtime
   already has related channels for V2 apps).
3. **Cut 3: the dashboard + V1 app bridge.** The largest non-auth item; the
   dashboard has to move to V2 (already anticipated by SocketComms comments).
4. **Cut 4: the V2-only build flag.** Nothing expresses "V1-free" today. Needs
   a build-time flag (e.g. `EXPO_PUBLIC_CLOUD_V2_ONLY`) that compiles out
   SocketComms/WebSocketManager/RestComms and the legacy settings UI, so the
   V1-free variant is a build target, not a runtime hope.

Cuts 2-4 are separate issues; this spike scopes them so 019 does not silently
absorb them.

## 5. Decisions (spike resolved 2026-07-08)

1. **OAuth: system browser + core-hosted flow.** Core hosts
   `GET /api/account/oauth/google/start`; the system browser (Custom Tabs /
   ASWebAuthenticationSession) runs Supabase's `/auth/v1/authorize`; the
   callback lands on core, core exchanges the code server side, mints the V2
   session, and deep-links back into the app with a one-time code. Mirrors the
   WorkOS PKCE + device flow already built for the console/CLI
   (`cli-auth.api.ts`), so every moving part has in-repo precedent and no
   provider secret touches the client. Native Google Sign-In SDK is a later UX
   optimization, not the foundation. Note: offering Google login means the App
   Store requires Sign in with Apple; the same core-hosted flow covers it as
   another provider route.
2. **Session model: V2 tokens only on device; no Supabase material at all.**
   Core does NOT persist Supabase sessions: it uses GoTrue's password grant
   transiently at login (verify, fetch identity, discard) and the GoTrue admin
   API (service key) for management flows (password/email change, reset links,
   deletion). The device holds exactly V2 access + refresh. V2 refresh already
   rolls on rotation, so active users never re-login; only fully-idle-30-days
   does. TTL stays config-driven if product wants longer.
3. **No legacy coexistence bridge.** SocketComms is being deprecated and Cloud
   V1 removal is planned for the PR immediately after this one, so a
   core-minted legacy coreToken bridge would be engineering for a two-week
   window. Decision: do not build it. When login moves to V2, the V1 websocket
   and coreToken-authenticated REST simply stop working, and we track the
   fallout in the breakage ledger below (section 6) as the work list for the
   V1-removal PR. One carve-out: account deletion moves in THIS PR (see 5.6),
   because store compliance cannot be in the broken list.
4. **Migration: none. Everyone logs in again.** On first boot after update,
   any stored Supabase/legacy material is wiped and the user lands on the new
   login screen; signing in creates their V2 session and they are migrated.
   No silent bootstrap, no migration ramp to build or retire. This also means
   the symmetric Supabase/legacy branch of `resolveSubjectIdentity` can be
   deleted in the same effort instead of lingering behind a metric (tech-debt
   item 1 dies immediately). Cost: a one-time re-login for every user on
   update, accepted as part of the same product call as decision 3.
5. **Identity side-channels: one `GET /api/account/me`.** Returns
   `{mentraUserId, email, name, avatar}`; posthog/sentry/bug-report identity
   re-points to it, keyed on `mentraUserId` (stable server id, less PII in
   third-party tools).
6. **Account deletion moves in Phase 1.** `request` sends the confirmation
   email (core already carries `RESEND_API_KEY`), `confirm` deletes the
   Supabase user (admin API) and the V2 user + sessions. Cloud V1 is a
   separate system with its own database; cloud-v2 code never talks to it.
   Any V1 record cleanup is an operational task on the V1 side, not a
   cloud-v2 code path.

Remaining sign-off: none blocking. Decision 3 accepts a short window of broken
V1 features (product call, made 2026-07-08); decision 2's idle-logout TTL is a
product knob, defaulting to current 30-day rolling.

## 6. Breakage ledger: what stops working when V1 auth goes away

When this PR lands and mobile no longer produces a legacy coreToken, the
following break by design. This list IS the work list for the V1-removal PR;
anything discovered broken later gets appended here.

| What breaks | Mechanism | Disposition (next PR) |
|---|---|---|
| OS dashboard content (HUD glasses) | dashboard is driven over the V1 WS | move dashboard to Cloud V2 (anticipated in SocketComms comments) |
| V1 cloud app bridge | display events, photo/stream/video commands, app_started/stopped over V1 WS | V2 runtime already owns these for V2 apps; delete the V1 bridge (SocketComms, WebSocketManager) |
| V1 audio uplink | `AudioCloudUplink` (island) feeding V1 apps | V2 path exists (cloud-client); delete V1 uplink |
| Device event routing to V1 | `DeviceEventRouter`, `MantleManager` V1 hooks | re-point or delete with the bridge |
| Server-synced user settings | `/api/client/user/settings` (coreToken auth) | add V2 settings sync endpoint or accept local-only until then |
| Calendar / location / notifications feeds | RestComms pushes (coreToken auth) | add V2 client-data endpoints; dashboard/miniapps consuming them move with the dashboard |
| Error reports | `/app/error` | add V2 equivalent or route to existing report tooling |
| Legacy `/auth/exchange` + `goodbye` | replaced by the account module | delete client code |
| Min-version check | `/api/client/min` | already exists on V2 (`/api/client/min-version`); just re-point |
| Account deletion | `/api/account/request|confirm` | NOT allowed to break; moves in this PR (decision 5.6) |
