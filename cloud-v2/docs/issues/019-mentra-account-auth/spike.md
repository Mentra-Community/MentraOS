# 019 spike: the Cloud V1 dependency ledger and the auth chain

**Status:** First pass complete (code inventory, 2026-07-08, branch
`mentra-account-auth` @ dev f77623007). Remaining spike questions are listed at
the bottom; they need product answers or live-system checks, not more grepping.

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

Verified against `mobile/modules/island/src/services/RestComms.ts` (the real
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

## 5. Open questions (need answers before spec.md)

- **OAuth redirect mechanics.** Google sign-in server side: core drives the
  OAuth dance and deep-links back into the app (`state`/PKCE, app links). What
  does Supabase GoTrue support server side vs what must stay client-initiated?
  This is the riskiest unknown of Phase 1.
- **Session model on device.** Does mobile hold ONLY V2 access+refresh (and
  core holds the Supabase session server side), or keep the Supabase refresh
  token on device as a recovery root? Tradeoffs: revocation vs offline login
  vs "logged out after 30 days idle."
- **Legacy coexistence during rollout.** Until cuts 2-3 land, a V2-logged-in
  app still needs the V1 websocket. Options: core mints a legacy-compatible
  coreToken (requires core to hold MENTRA_CORE_JWT_SECRET, extending the
  symmetric debt temporarily) vs mobile keeps the Supabase session until V1
  dies. Needs a decision with security signoff.
- **Migration of logged-in users.** On app update, silent re-exchange from the
  stored Supabase session vs forced re-login. What percent of sessions survive?
- **Identity side-channels.** posthog/sentry/bug-report identity currently
  read the Supabase user object; inventory and re-point them.
- **Account deletion flow ownership.** V1 owns request/confirm today; the
  account module must own it before any V1-free build ships to stores.
