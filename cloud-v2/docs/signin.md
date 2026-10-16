# Mentra sign-in: Core's sign-in server

Each Core runs its own sign-in server, an OpenID Connect provider built on
panva's [`oidc-provider`](https://github.com/panva/node-oidc-provider). It is the
one place Mentra's websites and the `mentra` CLI sign in: the admin portal, the
workspace portal, the Developer Console and the CLI. Every token a website or the
CLI holds is issued by Core.

Behind the sign-in server, one identity provider checks who the person is:

- **Hosted Core** uses Supabase Auth, the Mentra account. Mentra's sign-in page
  signs the person in to Supabase and hands the access token to Core, which
  verifies it and ends that Supabase session.
- **A Mentra Private Cloud** uses the customer's identity provider (Microsoft
  Entra in the Azure reference), configured in `CLOUD_CORE_OIDC_PROVIDERS`. The
  sign-in server is a confidential client of it.

Either way, a person is the same Core user on the phone and on every website:
`("mentra", Supabase user ID)` on hosted Core, `(provider tenantId, subject
claim)` on a Private Cloud. The sign-in server's `sub` is that Core user's
`mentraUserId`.

The Supabase project's setup is in the [Mentra account runbook](runbooks/mentra-account.md).

## The issuer and the sign-in sites

| Core | Issuer, `CLOUD_CORE_OIDC_ISSUER` |
| --- | --- |
| Hosted prod | `https://account.mentraglass.com` |
| Hosted staging | `https://account.staging.mentraglass.com` |
| Hosted dev | `https://account.dev.mentraglass.com` |
| A Mentra Private Cloud | Core's own host |

Each environment is its own issuer, so a token from one environment's Core is
refused by every other.

On hosted Core, each sign-in site is a Cloudflare Pages project serving Mentra's
sign-in page (`cloud-v2/websites/account`), with a Pages Function that relays the
sign-in server's routes to that environment's Core, exactly as the portal sites
relay `/api/*`:

| Path on the sign-in site | Served by |
| --- | --- |
| `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Core: discovery, and Core's key set |
| `/oidc/*` | Core: authorization, token, userinfo, revocation and end-session |
| `/interaction/*` | Core: the sign-in steps |
| `/api/account/password/forgot`, `/api/account/password/reset` | Core's account API, for password reset |
| Everything else | The static sign-in page |

Core's responses, every `Set-Cookie` and redirect included, pass through the
relay unchanged, so the sign-in server's cookies are first-party on the sign-in
site. Core builds every URL from `CLOUD_CORE_OIDC_ISSUER`, never from `Host` or
forwarding headers.

On a Private Cloud, Core serves the sign-in server and the admin portal on its
own host, and there is no sign-in page: the sign-in step goes to the customer's
identity provider.

## The sign-in server

- **Flows.** The authorization code flow with S256 PKCE, required for every
  client, and exact redirect URIs. Refresh tokens for the clients registered for
  them; they rotate, and reusing a spent one fails and ends its grant. No
  implicit or hybrid flow, no device or client-credentials grant, no dynamic
  client registration.
- **Tokens.** Signed with Core's own key under key ID `mentra-oidc-1`, published
  in Core's key set (`/.well-known/jwks.json`), which discovery names as
  `jwks_uri`.
  - Access tokens are JWTs for Core's API: `typ` `at+jwt`, `aud`
    `urn:mentra:core`, with `client_id`. They live an hour.
  - ID tokens carry the client in `aud`, and the person's `email`,
    `email_verified` and `name` as recorded at sign-in.
  - Every verifier of Core's tokens pins the key ID and type as well as the
    issuer and audience, so a sign-in server token never passes for a phone,
    runtime or miniapp token, or the other way round.
- **Endpoints.** Discovery, authorization (`/oidc/auth`), token
  (`/oidc/token`), userinfo (`/oidc/me`, answered by Core for its access
  tokens), revocation (`/oidc/token/revocation`) and end-session
  (`/oidc/session/end`). Every response is `no-store`. The token and revocation
  endpoints answer 429 past 120 requests a minute per client and IP.
- **Sessions.** The sign-in server's own session is single sign-on across one
  environment's Mentra sites: a second site signs in without credentials.
  Signing out at the end-session endpoint ends it; each site's and the CLI's own
  session continues until it signs out. Its cookies (`__Host-mentra_oidc_session`
  and the `__Secure-` interaction cookies) are signed with
  `CLOUD_CORE_OIDC_COOKIE_KEYS` and authenticate nothing outside the sign-in
  server.
- **Storage.** Mongo collections `oidc_session`, `oidc_interaction`,
  `oidc_grant`, `oidc_authorization_code`, `oidc_refresh_token`,
  `oidc_access_token` and `oidc_replay_detection`, with TTL indexes; codes and
  tokens are stored only as their SHA-256, and a code or refresh token is
  consumed atomically, so two concurrent redemptions end its grant. How each
  person last signed in (source, subject, email and its verification) is in
  `signin_identities`.

### The sign-in steps

| Route | What it does |
| --- | --- |
| `GET /interaction/:uid` | Hosted: sends the person to the sign-in page's `/login?interaction=<uid>`. Private Cloud: starts the code flow at the customer's identity provider (S256 PKCE, `state`, `nonce`; 20 per minute per IP). A first-party client's consent step completes without a screen; any other client goes to the page's `/consent`. |
| `GET /interaction/:uid/details` | The client's name and the requested scopes, for the page. |
| `POST /interaction/:uid/supabase` | Hosted: the sign-in page's hand-off, `{access_token}` of the person's Supabase session. Answers `{redirectTo}`, the sign-in server's own continuation. Same-origin only, 30 per minute per IP. |
| `POST /interaction/:uid/consent` | `{decision: "allow" | "deny"}` from the consent screen. |
| `GET /interaction/callback/<provider id>` | Private Cloud: the customer's identity provider returns here; register it as the provider app's web redirect URI. |

At the hand-off, Core verifies the Supabase access token as the phone token
exchange does: HS256 with `SUPABASE_JWT_SECRET`, or RS256 / ES256 against the
project's key set; `iss` equal to `CLOUD_CORE_SUPABASE_ISSUER`; `aud`
`authenticated`; 30 seconds of tolerance. It refuses a token Supabase's OAuth
server issued to a client, and a session that started (its earliest `amr`
timestamp) before the person's `webSignInsRevokedAt`, however often it was
refreshed. It reads the account's `email_confirmed_at` for email verification,
records the sign-in, and ends that Supabase session
(`POST /auth/v1/logout?scope=local`); a failure there is logged and never
blocks the sign-in.

At a Private Cloud's callback, Core verifies the provider's ID token against its
configured key set: issuer, audience (the browser client ID), `azp` when there
are several audiences, algorithm, `nonce`, expiry, the directory tenant and the
subject claim.

After every sign-in, the hooks registered with `registerAfterSignInHook` run.

## Clients

Clients are registered in each Core's `CLOUD_CORE_OIDC_CLIENTS`; there is no
dynamic registration. Every configured client is first-party: it never sees a
consent screen.

```json
[
  {"clientId": "mentra-admin-prod", "kind": "admin_portal",
   "secretEnv": "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
   "redirectUris": ["https://admin.mentraglass.com/api/admin/auth/callback"]},
  {"clientId": "mentra-portal-prod", "kind": "workspace_portal",
   "secretEnv": "CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET",
   "redirectUris": ["https://portal.mentraglass.com/api/portal/auth/callback"]}
]
```

| Kind | Client | Authentication | Refresh tokens |
| --- | --- | --- | --- |
| `admin_portal` | The admin portal | `client_secret_post` | No |
| `workspace_portal` | The workspace portal | `client_secret_post` | No |
| `console` | The Developer Console | `client_secret_post` | Yes |
| `cli` | The `mentra` CLI | Public (`none`), loopback redirects on `127.0.0.1` | Yes |

- At most one client of each kind. Client IDs are 1–64 letters, digits, `_` or
  `-`.
- A confidential client's secret is in the variable `secretEnv` names, which
  must be `CLOUD_CORE_OIDC_<CLIENT>_CLIENT_SECRET` and hold at least 32
  characters. A client whose secret is unset is unknown.
- Redirect URIs match exactly and are HTTPS, except the CLI's loopback URIs (and
  loopback HTTP on an undeployed Core).

### The CLI

The `mentra` CLI signs in on a loopback port, the first free one of 53682, 53683
and 53684, so its client registers all three:

```json
{"clientId": "mentra-cli", "kind": "cli",
 "redirectUris": ["http://127.0.0.1:53682/callback", "http://127.0.0.1:53683/callback",
                  "http://127.0.0.1:53684/callback"]}
```

The CLI is a native client, and the sign-in server follows RFC 8252 for its
loopback redirects: a redirect to a registered loopback URI on another port is
accepted.

The CLI takes its issuer and client ID from `MENTRA_CLI_OIDC_ISSUER` and
`MENTRA_CLI_CLIENT_ID` on the developer's machine when both are set. Otherwise
it asks the service it targets:

- a Mentra Miniapp Store answers `GET /api/console/auth/cli-config` with its
  Core's issuer and CLI client;
- a Core without a Store (a Private Cloud) answers `GET /api/cli/config`.

`GET /api/cli/config` is unauthenticated and answers `{issuer, clientId}`: the
issuer, and the `cli` client's ID. It answers 404
`{error: "not_configured"}` when the sign-in server is off or no `cli` client is
registered. Both answers are `no-store`.

### The Developer Console

The Developer Console is a confidential client of the Core whose Store runs it;
the Store backend is its server side. Register it with the Console's callback:

```json
{"clientId": "mentra-console", "kind": "console",
 "secretEnv": "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET",
 "redirectUris": ["https://console.mentraglass.com/api/console/auth/callback"]}
```

The Store holds the same client ID and secret, the issuer and the Console's
origin. It runs the code flow with S256 PKCE, `state` and `nonce`, redeems the
code with `client_secret_post`, and keeps the person's access and refresh tokens
encrypted on its side, behind the Console's own `__Host-` session cookie. On
every Console request the Store hands the access token to Core's service API
(`POST /api/internal/workspaces/principal`), so a revocation here ends the
Console session on its next request. The Store refreshes the token before it
expires, one refresh at a time per session, since a reused refresh token ends
the grant. Signing out of the Console revokes its refresh token at
`/oidc/token/revocation`; the end-session endpoint is offered for the sign-in
site itself. See [Store integration](store-integration.md).

## The portals

The admin portal and the workspace portal are confidential clients of their
Core's sign-in server; Core runs their server side.

| Route (on the portal's origin) | What it does |
| --- | --- |
| `GET /api/admin/auth/login?return_to=…`, `GET /api/portal/auth/login?return_to=…` | Starts the code flow: scope `openid email profile`, S256 PKCE, `state` and `nonce`. `return_to` must be a relative path; anything else becomes `/`. 20 per minute per IP. |
| `GET /api/admin/auth/callback`, `GET /api/portal/auth/callback` | Redeems the code with `client_secret_post` and verifies the ID token with Core's own key: `kid`, `iss`, `aud` (and `azp`), `nonce`, expiry. Starts a portal session for `sub` and redirects to `return_to`. Any failure shows a fixed page with **Try again** and sets no session cookie. 30 per minute per IP. |
| `POST /api/admin/auth/logout`, `POST /api/portal/auth/logout` | Same-origin only. Ends the portal session and answers `{signOutUrl}`, the sign-in server's end-session endpoint. |

All three answer `Cache-Control: no-store`. The portal's callback,
`<portal origin>/api/<admin|portal>/auth/callback`, must be registered for its
client; with the sign-in server on, Core refuses to start otherwise.

### Sessions and cookies

| Cookie | Portal |
| --- | --- |
| `__Host-mentra_admin_session` | Admin portal |
| `__Host-mentra_portal_session` | Workspace portal |
| `__Host-mentra_client_tx` | Either portal, during sign-in (10 minutes) |

Cookies are opaque 256-bit values, `HttpOnly`, `Secure`, `SameSite=Lax`,
`Path=/` and host-only; Core stores only their SHA-256 (`browser_sessions`,
`login_transactions`). A portal on plain HTTP (local development) drops the
`__Host-` prefix and `Secure`. A portal session keeps no tokens.

A session ends after 7 days without use and 30 days after sign-in. Its value
rotates after 24 hours; the previous value stays valid for 60 seconds. A session
belongs to one portal: the admin portal's cookie authenticates nothing under
`/api/portal`, the workspace portal's nothing under `/api/admin`, and neither
anything under `/api/workspaces` or `/api/organization`. Unsafe requests
authenticated by a portal cookie must be same-origin (`Origin`, or
`Sec-Fetch-Site: same-origin`).

## Who may use Core's APIs

Every portal and workspace API resolves its caller, in order, to:

1. a Core key in the bearer (`msk_…` or `mak_…`, see [Workspaces and keys](workspaces.md));
2. a Core access token from this Core's sign-in server: its issuer, Core's API
   audience, an active first-party client, and not from before the person's
   revocation;
3. the route group's portal session: the admin portal's under `/api/admin`, the
   workspace portal's under `/api/portal`.

The Store's service API (`/api/internal/workspaces`) accepts the same bearers.
Phone tokens, ID tokens, miniapp tokens, Supabase tokens and another
environment's tokens are refused. `/api/workspaces` and `/api/organization` take
bearers only. Signing in grants no organization capability by itself.

A person is an Organization Admin when their **verified** email is on
`CLOUD_CORE_ADMIN_EMAILS` (exact address or plus-tagged alias) or in a domain on
`CLOUD_CORE_ADMIN_EMAIL_DOMAINS`. Core checks this on every request, so an
allowlist change applies on the next one. The email and its verification are
what Core recorded at the person's last sign-in; a changed email takes effect at
the next one.

- A Mentra account's email is verified when Supabase confirmed it
  (`email_confirmed_at`). The token's `user_metadata.email_verified` is user
  editable and never read.
- A Private Cloud provider vouches only for emails in its `verifiedEmailDomains`
  (exact match; list each subdomain), and never when the token says
  `email_verified: false`. Any other email it asserts is display data.

## Revocation

Logging out everywhere, changing or resetting the password, and deleting the
account (`revokeAllSessionsForUser`):

- set the person's `webSignInsRevokedAt`: Core refuses their Core access tokens
  issued before it, and the hand-off refuses Supabase sessions that started
  before it;
- end the person's portal sessions;
- end their sessions and grants at the sign-in server, so the sign-in site asks
  for credentials again and every client's next refresh fails;
- on hosted Core, end every Supabase session of the person. Supabase has no
  admin call for this, so Core signs a 60-second HS256 token for the person with
  `SUPABASE_JWT_SECRET` and calls `POST /auth/v1/logout?scope=global`. A failure
  is logged and never blocks the revocation.

Times are read strictly: a token issued in the revocation's own second counts as
before it.

The revocation endpoint (`/oidc/token/revocation`) revokes refresh tokens: the
Developer Console and the CLI revoke theirs when they sign out. A Core access
token is a signed JWT that Core verifies without a lookup, so revoking one there
has no effect; it lives out its hour unless the person's sign-ins are revoked
(above), or its client or sign-in source is removed.

Removing a sign-in source from configuration ends its people's portal sessions,
sign-in server sessions, access tokens and refreshes on their next request.

Deleting the account is durable and forward-only. Confirming it marks the
account deleted (the users row's tombstone), once, and the mark is never lifted;
a deleted account is no principal from then on: Core refuses its token exchange
(and so Core's account login), refresh, sign-in, portal sessions, Core access
tokens, the keys it created, and a service vouching for it. A phone access token
already issued lives out its hour; it is not a workspace principal.

The rest of the deletion (ending sessions and workspace memberships, removing
the support profile and the sign-in identity, deleting the account in the
account directory) runs right away, and every step is idempotent. Should a step
fail, or Core stop, Core finishes the deletion itself: a sweep at startup and
every minute picks up every tombstone without `accountDeletionCompletedAt` and
records that once all steps have run.

## Configuration

| Variable | Kind | Meaning |
| --- | --- | --- |
| `CLOUD_CORE_OIDC_ISSUER` | Public | The issuer: the environment's sign-in site, or a Private Cloud's own host. An origin with no path. Unset: the sign-in server is off, its routes answer 404, and portal sign-in is not configured. |
| `CLOUD_CORE_OIDC_COOKIE_KEYS` | Secret | Comma-separated keys, each at least 32 characters, that sign the sign-in server's cookies. The first signs; all verify. To rotate, add a new key in front, then remove the old one after 14 days. |
| `CLOUD_CORE_OIDC_CLIENTS` | Public | The registered clients (above). |
| `CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET`, `CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET`, `CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET` | Secret | Confidential clients' secrets, named by `secretEnv`. |
| `CLOUD_CORE_ADMIN_PORTAL_URL`, `CLOUD_CORE_ENTERPRISE_PORTAL_URL` | Public | The portals' origins. |
| `MENTRA_JWT_PRIVATE_KEY`, `MENTRA_JWT_PUBLIC_KEY` | Secret / Public | Core's signing key, which also signs the sign-in server's tokens. |

Hosted Core also needs:

| Variable | Meaning |
| --- | --- |
| `CLOUD_CORE_SUPABASE_ISSUER` | The Supabase issuer, exactly as its discovery document reports it (`…/auth/v1`). |
| `CLOUD_CORE_SUPABASE_JWKS_URL` | Optional. Supabase's key set, for tokens signed with asymmetric keys. Default `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | Also used at the hand-off to read `email_confirmed_at` and end the handed-off session, and for account-wide sign-out. |

Core refuses at startup, naming the variable: an issuer with a path, query or
fragment, or not HTTPS on a deployed Core; missing or short cookie keys; a
malformed client list or a missing or short client secret; a configured portal
whose client or callback is missing; and an HTTP Supabase issuer or key set on a
deployed Core.

### The sign-in page

`cloud-v2/websites/account` is a static site with no third-party scripts. Each
environment deploys it to its own Pages project (`mentra-account-dev`,
`mentra-account-staging`, and `mentra-account` for prod), built with the shared
Supabase project's public values and with that environment's Core as its relay
target (`CORE_URL`). The Pages workflow skips it until the GitHub Actions
variables `ACCOUNT_SUPABASE_URL` and `ACCOUNT_SUPABASE_PUBLISHABLE_KEY` are set.

| Route | What it does |
| --- | --- |
| `/login?interaction=<uid>` | Email and password, **Continue with Google**, **Continue with Apple**, with sign-up and password-reset links. The page signs in to Supabase, hands the access token to the interaction, forgets its Supabase session, and follows only the sign-in server's continuation on its own origin. |
| `/consent?interaction=<uid>` | The consent screen, for third-party clients only. |
| `/signup` | Supabase sign-up; the confirmation link returns to the sign-in in progress, or to the root. |
| `/reset` | Password reset through Core's account API: an emailed code, then a new password. It ends every session of the account, as any reset does. |
| `/signout` | Goes to the sign-in server's end-session endpoint, which asks to confirm. |
| `/` | An email link's outcome ("Email verified", or that the link has expired), or where to start signing in. |

It is served with a strict CSP (`connect-src` limited to its own origin and
Supabase), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, and
`no-store` on every sign-in route. Errors show fixed text and never echo request
parameters.

## Private Cloud configuration

The provider in `CLOUD_CORE_OIDC_PROVIDERS` that carries `browser` settings is
the identity provider behind the sign-in server; at most one may. The phone
token exchange uses the same entry, so a person's website sign-in and their
phone resolve the same Core user, keyed by `(tenantId, subjectClaim)` (`oid` for
Entra).

```json
{
  "id": "workforce",
  "protocol": "oidc",
  "providerKind": "microsoft-entra",
  "tenantId": "acme-private",
  "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
  "jwksUrl": "https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys",
  "audience": "<core-api-client-id>",
  "subjectClaim": "oid",
  "directoryTenantClaim": "tid",
  "expectedDirectoryTenantId": "<tenant-id>",
  "requiredScopes": ["mentra.session"],
  "allowedClientIds": ["<mobile-client-id>"],
  "verifiedEmailDomains": ["acme.example"],
  "browser": {
    "clientId": "<core-api-client-id>",
    "clientSecretEnv": "ENTRA_BROWSER_CLIENT_SECRET",
    "scopes": ["openid", "email", "profile"],
    "emailClaim": "email",
    "displayName": "Acme"
  }
}
```

Register `https://<core host>/interaction/callback/workforce` (the provider's
`id`) as a web redirect URI of the browser client. Set
`CLOUD_CORE_OIDC_ISSUER` and `CLOUD_CORE_ADMIN_PORTAL_URL` to Core's own HTTPS
origin, `CLOUD_CORE_ADMIN_STATIC_DIR` to the built admin portal
(`/app/admin-dist` in the image), and register the admin portal in
`CLOUD_CORE_OIDC_CLIENTS` with the callback on that origin. Core serves the
admin portal's files for GET requests outside `/api`, `/.well-known`, `/oidc` and
`/interaction`.

Core refuses at startup:

- `browser` settings without `clientId`, `displayName` or a set
  `clientSecretEnv` variable, or without `openid` in `scopes`;
- a `verifiedEmailDomains` entry that is not a lowercase domain without a
  trailing dot, a duplicate, a domain listed by two providers, or a Mentra domain
  (`mentra.glass`, `mentraglass.com`);
- a provider `tenantId` of `mentra`, or one an OEM or an enterprise already
  uses;
- more than one provider with `browser` settings, or `browser` settings together
  with `CLOUD_CORE_SUPABASE_ISSUER`.

Entra includes the `email` claim in ID tokens only when the app registration
requests it as an optional claim. A Private Cloud does not run Supabase and
depends on no Mentra-hosted service for sign-in.
