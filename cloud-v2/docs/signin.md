# Mentra sign-in for Core's portals

Each Core deployment trusts one identity provider for its websites:

- **Hosted Core** uses Supabase Auth, the Mentra account. Mentra's sign-in page,
  `https://account.mentraglass.com`, is the authorization page of Supabase's
  OAuth 2.1 server for every Mentra web client.
- **A Mentra Private Cloud** uses the customer's own identity provider (Microsoft
  Entra in the Azure reference), configured in `CLOUD_CORE_OIDC_PROVIDERS`.

The admin portal and the workspace portal are confidential OpenID Connect
clients of that provider. Core runs their server side: it redeems the
authorization code, verifies who signed in, maps the person to the same Core user
the Mentra App has, and keeps its own session. The browser never holds an
identity-provider token. Core never runs a login server.

The Supabase project's own setup (OAuth server, Site URL, clients, keys) is in
the [Supabase OAuth runbook](runbooks/supabase-oauth.md).

## How a portal signs in

| Route (on the portal's origin) | What it does |
| --- | --- |
| `GET /api/admin/auth/login?return_to=…`, `GET /api/portal/auth/login?return_to=…` | Starts the authorization code flow (S256 PKCE, `state`). `return_to` must be a relative path; anything else becomes `/`. 20 per minute per IP. |
| `GET /api/admin/auth/callback`, `GET /api/portal/auth/callback` | Redeems the code with `client_secret_post`, verifies the person, starts a portal session and redirects to `return_to`. Any failure shows a fixed page with **Try again** and sets no session cookie. 30 per minute per IP. |
| `POST /api/admin/auth/logout`, `POST /api/portal/auth/logout` | Same-origin only. Ends the portal session and answers `{signOutUrl}`: the identity provider's sign-out (`CLOUD_CORE_IDP_SIGNOUT_URL`), or `null`. |

All three answer `Cache-Control: no-store`. Redirect and callback URLs come only
from configuration, never from `Host` or forwarding headers.

- **Hosted Core.** Portals ask Supabase for `email profile`, never `openid`.
  Supabase issues no ID tokens on an HS256 project, and a code exchange that asks
  for `openid` fails. Core verifies the access token from its own code exchange,
  requires its `client_id` to be that portal's client, then ends that Supabase
  session (`POST /auth/v1/logout?scope=local`): the portal keeps no Supabase
  tokens. The sign-in page keeps its own session, so the next Mentra site signs
  in without a credential prompt.
- **Private Cloud.** The admin portal asks the provider for `openid email
  profile` with a `nonce`, and Core re-verifies the ID token against the
  provider's configured key set: issuer, audience (the browser client ID), `azp`
  when there are several audiences, algorithm, `nonce`, expiry, the directory
  tenant and the subject claim.

### Sessions and cookies

| Cookie | Portal |
| --- | --- |
| `__Host-mentra_admin_session` | Admin portal |
| `__Host-mentra_portal_session` | Workspace portal |
| `__Host-mentra_client_tx` | Either portal, during sign-in (10 minutes) |

Cookies are opaque 256-bit values, `HttpOnly`, `Secure`, `SameSite=Lax`,
`Path=/` and host-only; Core stores only their SHA-256 (`browser_sessions`,
`login_transactions`). A portal on plain HTTP (local development) drops the
`__Host-` prefix and `Secure`.

A session ends after 7 days without use and 30 days after sign-in. Its value
rotates after 24 hours; the previous value stays valid for 60 seconds. A session
belongs to one portal: the admin portal's cookie authenticates nothing under
`/api/portal`, the workspace portal's nothing under `/api/admin`, and neither
anything under `/api/workspaces` or `/api/organization`. Unsafe
requests authenticated by a portal cookie must be same-origin (`Origin`, or
`Sec-Fetch-Site: same-origin`).

### Who may use the portal APIs

Every portal API resolves its caller, in order, to:

1. a Core key in the bearer (`msk_…` or `mak_…`, see [Workspaces and keys](workspaces.md));
2. an identity-provider access token from this environment's web clients;
3. the route group's portal session: the admin portal's under `/api/admin`, the
   workspace portal's under `/api/portal`.

`/api/workspaces` and `/api/organization` take bearers only. Signing in grants
no organization capability by itself: the admin portal opens only the pages the
caller's capabilities allow, and each admin route checks its own capability.

A person is an Organization Admin when their **verified** email is on
`CLOUD_CORE_ADMIN_EMAILS` (exact address or plus-tagged alias) or in a domain on
`CLOUD_CORE_ADMIN_EMAIL_DOMAINS`. Core checks this on every request, so an
allowlist change applies on the next one.

- A Mentra account's email is verified when Supabase confirmed it
  (`email_confirmed_at`). The token's `user_metadata.email_verified` is user
  editable and never read.
- A Private Cloud provider vouches only for emails in its `verifiedEmailDomains`
  (exact match; list each subdomain), and never when the token says
  `email_verified: false`. Any other email it asserts is display data.

Workspace and organization administration is done by people; a key gets 403
there.

### Revocation

Logging out everywhere, changing or resetting the password, and deleting the
account (`revokeAllSessionsForUser`) also:

- set the person's `webSignInsRevokedAt`, so Core refuses identity-provider
  tokens from earlier sign-ins, including a Supabase token refreshed after the
  revocation (Core compares the session start, the earliest `amr` timestamp);
- end the person's portal sessions;
- on hosted Core, end every Supabase session of the person. Supabase has no
  admin call for this, so Core signs a 60-second HS256 token for the person with
  `SUPABASE_JWT_SECRET` and calls `POST /auth/v1/logout?scope=global`. A failure
  is logged and never blocks the revocation.

Removing a sign-in source from configuration ends its portal sessions on their
next request.

Deleting the account is durable and forward-only. Confirming it marks the
account deleted (the users row's tombstone), once, and the mark is never lifted;
a deleted account is no principal from then on: Core refuses its token exchange
(and so Core's account login), refresh, portal sign-in, portal sessions,
identity-provider tokens, the keys it created, and a service vouching for it. A
phone access token already issued lives out its hour; it is not a workspace
principal.

The rest of the deletion (ending sessions and workspace memberships, removing
the support profile, deleting the account in the account directory) runs right
away, and every step is idempotent. Should a step fail, or Core stop, Core
finishes the deletion itself: a sweep at startup and every minute picks up every
tombstone without `accountDeletionCompletedAt` and records that once all steps
have run. The person never has to sign in again to retry.

## Hosted Core configuration

| Variable | Kind | Meaning |
| --- | --- | --- |
| `CLOUD_CORE_SUPABASE_ISSUER` | Public | The Supabase issuer, exactly as its discovery document reports it (`…/auth/v1`). Unset: portal sign-in is not configured. |
| `CLOUD_CORE_SUPABASE_JWKS_URL` | Public | Optional. Supabase's key set, for tokens signed with asymmetric keys. Default `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. |
| `CLOUD_CORE_WEB_CLIENT_IDS` | Public | Comma-separated client IDs of this environment's web clients (its admin portal, workspace portal, Console and CLI). A token issued to any other client, another environment's included, is refused. |
| `CLOUD_CORE_ADMIN_PORTAL_URL` | Public | The admin portal's origin. Its callback is `${CLOUD_CORE_ADMIN_PORTAL_URL}/api/admin/auth/callback`. |
| `CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID` | Public | The admin portal's Supabase client ID. |
| `CLOUD_CORE_ADMIN_PORTAL_CLIENT_SECRET` | Secret | Its client secret. |
| `CLOUD_CORE_ENTERPRISE_PORTAL_URL`, `…_CLIENT_ID`, `…_CLIENT_SECRET` | Public / Secret | The same for the workspace portal (`portal.mentraglass.com`). |
| `CLOUD_CORE_IDP_SIGNOUT_URL` | Public | Optional. The sign-in page's `/signout`, offered after a portal sign-out. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | As before | Also used to read `email_confirmed_at`, to end the portal's Supabase session, and for account-wide sign-out. |

Core refuses at startup an HTTP Supabase issuer or key set, or an empty
`CLOUD_CORE_WEB_CLIENT_IDS` while the issuer is set, on a deployed Core
(`CLOUD_CORE_ENVIRONMENT` dev, staging or prod). With none of these variables set,
Core starts and serves everything else; a portal's sign-in page answers "Sign-in
is not configured".

### The sign-in page

`cloud-v2/websites/account` is a static site deployed to the Cloudflare Pages
project `mentra-account` (`account.mentraglass.com`). One Supabase project serves
dev, staging and prod, so one page serves all three and deploys like production:
from `main`, or by a manual dispatch of the Pages workflow with environment
`prod` and site `account`. Its public build-time values are GitHub Actions
variables:

| Variable | Value |
| --- | --- |
| `ACCOUNT_SUPABASE_URL` | The Supabase project URL the page calls (`https://auth.mentra.glass`). |
| `ACCOUNT_SUPABASE_PUBLISHABLE_KEY` | The project's publishable key. |
| `ACCOUNT_FIRST_PARTY_CLIENT_IDS` | Every environment's first-party client IDs, comma separated. They are approved without a consent screen. |

Until all three are set, the Pages workflow skips the site.

The page signs in with email and password, Google or Apple; follows only the
`redirect_url` Supabase returns; and, when its stored session has been revoked
elsewhere, signs out locally and shows sign-in again. `/signout` ends only the
page's own Supabase session (`scope: "local"`), so the Developer Console and the
CLI stay signed in. It loads no third-party scripts and is served with a strict
CSP, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, and `no-store` on
`/oauth/*`.

## Private Cloud configuration

The provider in `CLOUD_CORE_OIDC_PROVIDERS` that carries `browser` settings is
the admin portal's identity provider; at most one may. The phone token exchange
uses the same entry, so a person's admin portal sign-in and their phone resolve
the same Core user, keyed by `(tenantId, subjectClaim)` (`oid` for Entra).

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

| Variable | Meaning |
| --- | --- |
| `CLOUD_CORE_ADMIN_PORTAL_URL` | The admin portal's origin. When Core serves the portal, Core's own HTTPS origin. Register `${CLOUD_CORE_ADMIN_PORTAL_URL}/api/admin/auth/callback` as a web redirect URI of the browser client. |
| `CLOUD_CORE_ADMIN_STATIC_DIR` | The built admin portal (`/app/admin-dist` in the image). Core serves it for GET requests outside `/api` and `/.well-known`. |
| `CLOUD_CORE_IDP_SIGNOUT_URL` | The provider's sign-out URL, for example `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/logout`. |
| The variable named by `browser.clientSecretEnv` | The browser client's secret, from the customer's secret manager. |

Core refuses at startup:

- `browser` settings without `clientId`, `displayName` or a set
  `clientSecretEnv` variable, or without `openid` in `scopes`;
- a `verifiedEmailDomains` entry that is not a lowercase domain without a
  trailing dot, a duplicate, a domain listed by two providers, or a Mentra domain
  (`mentra.glass`, `mentraglass.com`);
- a provider `tenantId` of `mentra` or `workos`, or one an OEM or an enterprise
  already uses;
- more than one provider with `browser` settings, or `browser` settings together
  with `CLOUD_CORE_SUPABASE_ISSUER`.

Entra includes the `email` claim in ID tokens only when the app registration
requests it as an optional claim. A Private Cloud does not run Supabase and
depends on no Mentra-hosted service for sign-in.
