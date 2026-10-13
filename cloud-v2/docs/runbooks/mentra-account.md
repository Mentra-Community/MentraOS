# The Mentra account behind Core's sign-in server

How Mentra's one Supabase project is set up as the Mentra account behind each
Core's sign-in server, and how each environment's sign-in site is wired. The
product side is in [`docs/signin.md`](../signin.md).

One Supabase project serves dev, staging and prod Core. Supabase knows nothing of
Core's clients: each Core registers its own in `CLOUD_CORE_OIDC_CLIENTS`, and
signs its own tokens. Mentra's sign-in page signs people in to Supabase as a
first-party app and hands the access token to Core, which ends that Supabase
session once it has verified it.

## Project settings

| Setting | Value |
| --- | --- |
| OAuth 2.1 server | Off. No Mentra product uses it. |
| Site URL | `https://account.mentraglass.com`, the root of prod's sign-in site, which shows an email link's outcome. |
| Signing keys | Unchanged: the project's HS256 JWT secret (see [Signing keys](#signing-keys)). |

**Account emails.** Core sends `redirect_to` on its sign-up and
resend-verification calls when `CLOUD_CORE_ACCOUNT_EMAIL_REDIRECT_URL` is set; that
URL must be on the redirect allowlist, or Supabase silently falls back to the
Site URL. A confirmation link without one lands on the sign-in site's root, which
shows "Email verified" (or that the link has expired) and starts no session.

**Issuer.** Each Core's `CLOUD_CORE_SUPABASE_ISSUER` is exactly the `issuer` the
project's discovery document reports:

```bash
curl -s https://auth.mentra.glass/auth/v1/.well-known/openid-configuration | jq -r .issuer
```

Core compares the handed-off token's `iss` with it.

## Redirect allowlist

- `https://account.mentraglass.com/**`, `https://account.staging.mentraglass.com/**`
  and `https://account.dev.mentraglass.com/**`: each sign-in site's own redirects
  (Google and Apple sign-in returning to `/login`, and its sign-up confirmation
  links).
- The value of `CLOUD_CORE_ACCOUNT_EMAIL_REDIRECT_URL`.

## API keys

| Core variable | Holds | Sent as |
| --- | --- | --- |
| `SUPABASE_ANON_KEY` | The publishable key (`sb_publishable_…`), or the legacy `anon` key | `apikey` only for a new-format key; a legacy key also in `Authorization: Bearer` |
| `SUPABASE_SERVICE_ROLE_KEY` | The secret key (`sb_secret_…`), or the legacy `service_role` key | Same rule |

Core refuses at startup a secret key in `SUPABASE_ANON_KEY` or a publishable key
in `SUPABASE_SERVICE_ROLE_KEY`. Moving an environment to the new keys changes
those two values and nothing else. The sign-in page is built with the
publishable key (`ACCOUNT_SUPABASE_PUBLISHABLE_KEY`).

## The sign-in sites

| Environment | Site | Pages project | `CORE_URL` |
| --- | --- | --- | --- |
| dev | `account.dev.mentraglass.com` | `mentra-account-dev` | `https://core.dev.us-west-2.mentraglass.com` |
| staging | `account.staging.mentraglass.com` | `mentra-account-staging` | `https://core.staging.us-west-2.mentraglass.com` |
| prod | `account.mentraglass.com` | `mentra-account` | `https://core.mentraglass.com` |

Each is the sign-in page with the Pages Function that relays Core's sign-in
server routes (`/.well-known/openid-configuration`, `/.well-known/jwks.json`,
`/oidc/*`, `/interaction/*`) and password reset (`/api/account/password/forgot`,
`/api/account/password/reset`) to its Core. `scripts/deploy-pages.ts` sets
`CORE_URL` and deploys the site with the environment's other Pages sites. Each
environment's Core sets `CLOUD_CORE_OIDC_ISSUER` to its site.

## Signing keys

The project keeps its HS256 JWT secret. Core's sign-in server signs its own ID
and access tokens, so no Supabase signing-key change is needed for them. Core
verifies Supabase tokens signed either way: HS256 with `SUPABASE_JWT_SECRET`, or
RS256 / ES256 against `CLOUD_CORE_SUPABASE_JWKS_URL` (default
`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).

To switch to asymmetric keys later:

1. Confirm every Core runs a release that verifies asymmetric Supabase tokens,
   and that no other service verifies the project's tokens with its JWT secret.
2. Create the standby asymmetric key in the dashboard.
3. Wait 20 minutes for Supabase's key caches.
4. Rotate to the new key. If the Mentra App's token exchange or the sign-in
   page's hand-off errors, rotate back.

Never revoke the legacy JWT secret while Core still uses the legacy API keys, or
while Core's account-wide sign-out depends on it: that call
(`POST /auth/v1/logout?scope=global`) uses a short-lived token Core signs with
`SUPABASE_JWT_SECRET`.

## Checking a deployment

- Discovery at `https://<sign-in site>/.well-known/openid-configuration` reports
  the site as `issuer`, with `end_session_endpoint` and `revocation_endpoint`
  on it.
- An admin portal sign-in from a fresh browser asks for credentials on the
  environment's sign-in site, then lands back on the admin portal; the workspace
  portal then signs in without asking.
- Signing out on the sign-in site (`/signout`) leaves the portals signed in;
  logging out everywhere in the Mentra App signs them out.
- The Mentra App signs in on each platform.
- A Mentra App sign-up's confirmation link shows that the email is verified, on
  the `CLOUD_CORE_ACCOUNT_EMAIL_REDIRECT_URL` page or on the sign-in site's root.
