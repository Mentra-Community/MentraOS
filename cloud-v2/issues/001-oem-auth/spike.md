# Cloud v2 Auth Spike

**Status:** Complete. Findings feed [`spec.md`](./spec.md).

## Why this spike

Some OEMs will want their users to authenticate through the OEM's own
system rather than signing in to Mentra. Their app, their signup, their
brand. Today's auth model assumes the user signs in to Mentra.

We weren't experts on multi-tenant identity, and team conversations
were mixing several different patterns under loose terms like "SSO"
and "OAuth". The spike's job was to research what other companies have
built, lay out a clean option set, and feed a proposal into the spec.

## Concepts primer

Terms used throughout the auth docs. Defined here so the spec and
design can reference them without re-explaining. Skim once, refer back
as needed.

- **Authentication.** Proving who a user is.
- **Authorization.** Deciding what an authenticated user is allowed to
  do.
- **Identity Provider (IdP).** The system that owns user accounts and
  verifies passwords / passkeys / etc. Google is an IdP.
- **Relying Party (RP).** The system that trusts an IdP's verification
  instead of doing it itself.
- **OAuth 2.0.** Standard protocol for one system to grant another
  limited access on behalf of a user.
- **OpenID Connect (OIDC).** Authentication layer on top of OAuth 2.0.
  The thing behind every "Sign in with X" button.
- **SAML.** Older XML-based protocol with the same job as OIDC. Common
  in enterprise IT, rare in consumer products.
- **Single Sign-On (SSO).** A pattern, not a protocol: a user signs in
  once with one IdP and gets access to many services. Implemented
  using SAML or OIDC.
- **Federation.** Letting users from one identity system access
  another without re-creating the account. SSO is one form of
  federation.
- **JWT (JSON Web Token).** A small signed JSON blob that carries
  claims (key/value pairs).
- **Bearer token.** A token where possession alone is proof of
  authorization. Sent in `Authorization: Bearer <token>` header.
- **Symmetric signing (HS256).** JWT signed with a shared secret. Both
  sides hold the same key.
- **Asymmetric signing (RS256, ES256).** JWT signed with a private
  key, verified with a corresponding public key.
- **JWK (JSON Web Key).** Standard format for publishing a public key
  as JSON.
- **JWK Set URL.** URL hosting the current public keys for a signer.
  Lets the verifier fetch keys without manual config and handle
  rotation.
- **Access token.** Short-lived credential a client sends with each
  request to access a resource.
- **Refresh token.** Longer-lived credential used only to get new
  access tokens. Never sent to resource servers.
- **JWT Bearer Grant (RFC 7523).** Standard pattern where one system
  signs a JWT and presents it to another's token endpoint to get an
  access token. Server-to-server, no user redirect.
- **Token Exchange (RFC 8693).** Standard pattern where a client
  presents a token from one issuer and gets back a new token scoped
  to a different audience.
- **B2B2C.** A platform whose customers (businesses) have their own
  end users. Mentra's relationship with OEMs and OEM users is B2B2C.

## What we explored

Two categories of prior art:

1. **Multi-tenant SSO platforms.** Initial direction. WorkOS, Auth0
   Organizations, Stytch B2B, Frontegg, Shopify customer accounts. We
   pivoted away from these.

2. **API-platform auth.** Pivot direction. Firebase Custom Auth,
   Twilio Access Tokens, LiveKit, Agora. Right shape for our problem.

### Why we pivoted

Multi-tenant SSO assumes the user signs in via a redirect from one
app's UI to another system's login page (typically through a browser).
Federation between identity systems works because the user is
physically there to type their password into the OEM's login screen.

In our model, **the user is already signed in to the OEM's app.** The
OEM built that app and runs that auth. There is no redirect from
Mentra's side; Mentra has no UI in the user-facing flow at all. What
Mentra needs is a way for the OEM (server-side) to vouch for a user
who's calling Mentra's backend.

That's the API-platform auth pattern: the developer's backend signs
short-lived per-user tokens, the developer's client uses them to call
the platform. LiveKit, Twilio, Firebase, and Agora all converged on
the same recipe.

## Prior art summary

### Multi-tenant SSO platforms (don't fit our shape)

| Product / pattern    | What it does                                     | Why not for us                                            |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| WorkOS Organizations | Brokers OIDC/SAML to per-tenant IdPs             | Assumes user-facing redirect; we have no Mentra UI        |
| Auth0 Organizations  | Same shape, layered on user-first Auth0 platform | Same                                                      |
| Stytch B2B           | API-first, Organizations + Members model         | Same                                                      |
| Frontegg             | Bundled tenancy + admin UI                       | Same, plus tightly coupled to provided UI components      |
| Shopify Customer     | Started with own auth, evolved to OIDC merchants | Useful arc to study, but the redirect assumption holds    |

### API-platform auth (right shape)

| Product         | Signing               | Token model                             | Notes                                          |
| --------------- | --------------------- | --------------------------------------- | ---------------------------------------------- |
| LiveKit         | HS256 (shared secret) | Direct bearer, no exchange              | Token is the session; permissions in claims    |
| Twilio Access   | HS256                 | Direct bearer                           | Per-product grants (Voice, Video, Sync, etc.)  |
| Agora           | HS256                 | Direct bearer, channel-scoped           | SDK has expiry-warning callback for refresh    |
| Firebase Custom | RS256 (asymmetric)    | Custom token exchanged for ID + refresh | Max 1h custom token TTL, SDK auto-refresh      |

## Architectural options identified

Six architectural options surface from the research. The spec
evaluates each.

1. **SAML SSO.** OEM as SAML IdP, Mentra as service provider. Standard
   enterprise federation.
2. **OIDC SSO.** OEM as OIDC issuer, Mentra as RP. Same shape as SAML,
   modern protocol. Sub-variant: use a broker (WorkOS, Auth0, Clerk)
   instead of building federation ourselves.
3. **OAuth authorization code flow.** OEM as authorization server. The
   "Sign in with X" pattern.
4. **Direct-bearer JWT.** LiveKit / Twilio / Agora pattern. OEM signs
   JWT, client uses as bearer to Mentra, no exchange.
5. **JWT bearer + Token Exchange.** Firebase Custom Auth pattern. OEM
   signs JWT, client exchanges with Mentra for Mentra-issued access
   token + refresh token.
6. **Server-to-server registration API.** OEM backend posts to Mentra
   with API credentials and the OEM's user ID, gets back a session.
   No JWT crypto required of the OEM.

Options 1, 2, 3 are the SSO family. Options 4, 5, 6 are the
API-platform family.

## Key trade-off axes

Three axes recur across the API-platform options:

- **Symmetric vs asymmetric signing.** Symmetric is simpler;
  asymmetric has cleaner rotation and smaller blast radius if a key
  leaks.
- **Direct bearer vs exchange.** Direct bearer is simpler; exchange
  gives Mentra control over session revocation and lets refresh
  happen without round-tripping the OEM's backend.
- **JWT-based vs API-call-based.** JWT requires the OEM to sign
  things; API-call avoids that but is bespoke instead of standardized.

## A second decision surfaced during research

While reviewing the implications of OEM-attested users, we surfaced
a separate question that the spec needs to address.

**What identity does Mentra expose to miniapp backends for
OEM-attested users?** Today, Mentra auto-auths miniapp backends with
the user's Mentra email, a major DX feature for miniapp devs. Under
cloud v2, if OEMs attest users, miniapp backends would implicitly
trust every OEM Mentra has approved. A rogue OEM could mint a token
for any of their users and read that user's data on every miniapp
they've used.

Possible approaches fall out of the OEM-auth design but are
fundamentally a miniapp-side decision. The spec covers this as a
parallel question.

## What feeds into the spec

- The six architectural options above, each evaluated.
- The three trade-off axes for the API-platform options.
- The miniapp-identity question.
- A proposal: which option to pick, and why the others don't fit.
