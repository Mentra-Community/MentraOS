# Supabase OAuth server for Mentra sign-in

How Mentra's one Supabase project is set up to be the login server for Core's
portals (and later the Developer Console and the CLI). The product side is in
[`docs/signin.md`](../signin.md).

One Supabase project serves dev, staging and prod Core. Each environment
registers its own clients in it, and each Core accepts only its own environment's
client IDs (`CLOUD_CORE_WEB_CLIENT_IDS`).

## Project settings

| Setting | Value |
| --- | --- |
| OAuth 2.1 server | Enabled. Dynamic client registration off. |
| Site URL | `https://account.mentraglass.com` |
| Authorization path | `/oauth/authorize` |
| Signing keys | Unchanged: the project's HS256 JWT secret (see [Signing keys](#signing-keys)). |

Supabase sends people to its authorization page at the **Site URL plus the
authorization path**; it takes no absolute URL. So the Site URL is the sign-in
page's origin, and the page is `https://account.mentraglass.com/oauth/authorize`.

**Account emails.** Without a `redirect_to`, Supabase links sign-up confirmation
emails to the Site URL. Before the Site URL becomes the sign-in page, every Core
(dev, staging and prod) must send an explicit `redirect_to` on its sign-up and
resend-verification calls: `CLOUD_CORE_ACCOUNT_EMAIL_REDIRECT_URL`, set to the
page those emails land on today. That URL must be on the redirect allowlist, or
Supabase silently falls back to the Site URL.

**Issuer.** Core and every client use the `issuer` the discovery document
reports, which can differ from the host it was fetched from:

```bash
curl -s https://auth.mentra.glass/auth/v1/.well-known/openid-configuration | jq -r .issuer
```

Set each Core's `CLOUD_CORE_SUPABASE_ISSUER` to exactly that value.
`openid-client` requires the discovery URL to match the issuer, and Core compares
every token's `iss` with it.

The discovery documents, `/oauth/token` and `/oauth/userinfo` need no `apikey`.
GoTrue's user routes (`/logout`, `/user`) need the publishable key in `apikey`.

## Redirect allowlist

- `https://account.mentraglass.com/**`: the sign-in page's own redirects (Google
  and Apple sign-in returning to `/oauth/authorize`, its sign-up confirmation and
  password reset links).
- The value of `CLOUD_CORE_ACCOUNT_EMAIL_REDIRECT_URL`.

OAuth client redirect URIs are registered per client (below), not on this list.

## API keys

| Core variable | Holds | Sent as |
| --- | --- | --- |
| `SUPABASE_ANON_KEY` | The publishable key (`sb_publishable_…`), or the legacy `anon` key | `apikey` only for a new-format key; a legacy key also in `Authorization: Bearer` |
| `SUPABASE_SERVICE_ROLE_KEY` | The secret key (`sb_secret_…`), or the legacy `service_role` key | Same rule |

Core refuses at startup a secret key in `SUPABASE_ANON_KEY` or a publishable key
in `SUPABASE_SERVICE_ROLE_KEY`. Moving an environment to the new keys changes
those two values and nothing else.

## Registered clients

Every client asks for scopes `email profile` and never `openid`: on an HS256
project the code exchange then fails with HTTP 500 after creating a session.
Confidential clients authenticate with `client_secret_post`; Supabase refuses
`openid-client`'s `client_secret_basic` (the library form-encodes the client ID
and Supabase does not decode it).

| Client | One per | Type | Redirect URI | Client ID / secret held in |
| --- | --- | --- | --- | --- |
| Admin portal | Environment | Confidential, `client_secret_post` | `https://<admin portal origin>/api/admin/auth/callback` | Core: `CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID`, `CLOUD_CORE_ADMIN_PORTAL_CLIENT_SECRET` |
| Enterprise portal | Environment | Confidential, `client_secret_post` | `https://<enterprise portal origin>/api/portal/auth/callback` | Core: `CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID`, `CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_SECRET` |
| Developer Console | One (the hosted Store) | Confidential, `client_secret_post` | `https://<console origin>/api/console/auth/callback` | The Store |
| `mentra` CLI | Environment | Public (`none`) | `http://127.0.0.1:53682/callback`, `:53683`, `:53684` | The Store's CLI configuration |

For each environment, also:

- add its client IDs to that Core's `CLOUD_CORE_WEB_CLIENT_IDS`;
- add its first-party client IDs to the sign-in page's
  `ACCOUNT_FIRST_PARTY_CLIENT_IDS` (a GitHub Actions variable), then redeploy the
  sign-in page. First-party clients are approved without a consent screen.

Register a client in the dashboard (Authentication, OAuth server) or with the
admin API and the secret key:

```bash
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/oauth/clients" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"client_name": "Admin portal (dev)", "client_type": "confidential",
       "token_endpoint_auth_method": "client_secret_post",
       "redirect_uris": ["https://admin.dev.mentraglass.com/api/admin/auth/callback"],
       "grant_types": ["authorization_code", "refresh_token"]}'
```

The response carries `client_id` and, for a confidential client, `client_secret`
(shown once). Put both in the environment's Doppler config; never in a file or
a ticket. Redirect URIs match exactly: no trailing slash, query, or `localhost`
for `127.0.0.1`.

### Rotating a client secret

`POST /auth/v1/admin/oauth/clients/<client_id>/regenerate_secret` replaces the
secret at once, so sign-ins fail until Core has the new value. Without that gap:

1. Register a new client with the same redirect URI.
2. Add its ID to `CLOUD_CORE_WEB_CLIENT_IDS` and to the sign-in page's
   first-party list (redeploy the page).
3. Put the new client ID and secret in Core's Doppler config and roll Core out.
4. Remove the old ID from both lists and delete the old client
   (`DELETE /auth/v1/admin/oauth/clients/<client_id>`).

Portal sessions are Core's own and survive the rotation.

## Signing keys

The project keeps its HS256 JWT secret. Mentra's websites and the CLI request no
ID tokens, the only OAuth-server feature that needs asymmetric keys. Core
verifies Supabase tokens signed either way: HS256 with `SUPABASE_JWT_SECRET`, or
RS256 / ES256 against `CLOUD_CORE_SUPABASE_JWKS_URL` (default
`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).

To switch to asymmetric keys later:

1. Confirm every Core runs a release that verifies asymmetric Supabase tokens,
   and that no other service verifies the project's tokens with its JWT secret.
2. Create the standby asymmetric key in the dashboard.
3. Wait 20 minutes for Supabase's key caches.
4. Rotate to the new key. If the Mentra App's token exchange or portal sign-in
   errors, rotate back.

Never revoke the legacy JWT secret while Core still uses the legacy API keys, or
while Core's account-wide sign-out depends on it: that call
(`POST /auth/v1/logout?scope=global`) uses a short-lived token Core signs with
`SUPABASE_JWT_SECRET`.

## Checking a deployment

- Discovery: the `issuer` above, with no `revocation_endpoint` and no
  `end_session_endpoint`.
- An admin portal sign-in from a fresh browser asks for credentials on
  `account.mentraglass.com`, then lands back on the admin portal.
- Signing out on the sign-in page (`/signout`) leaves the portals and the CLI
  signed in.
- A Mentra App sign-up's confirmation link lands on the confirmation page, not
  the sign-in page.
