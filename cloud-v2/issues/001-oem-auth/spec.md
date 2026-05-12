# Cloud v2 Auth Spec

**Status:** Proposal. Pending team review.

## Why this doc

Bridge from the spike research ([`spike.md`](./spike.md)) to a concrete
design proposal. Lays out the alternatives we considered, proposes one
for each decision, explains why the others don't fit so reviewers can
push back.

## Goals

- Clean end-user UX. Whatever the OEM picks, the user experience is
  clean.
- OEM integration DX. Easy enough that an OEM team can wire it up
  without a long onboarding.
- OEMs feel ownership of their users. They control the relationship,
  the brand, and the auth flow.
- Mentra owns the miniapp store. Shared across OEMs.
- Mentra provides shared cloud services (audio, STT, TTS, AI). OEM
  users get to use these regardless of how they signed in.

## Two decisions

This work splits into two related-but-separate decisions:

1. **Q1.** How does the OEM prove who their user is, to Mentra?
2. **Q2.** How does Mentra expose user identity to miniapp backends?

We answer them in order.

---

## Q1: OEM to Mentra auth

The setup: a user is signed in to the OEM's mobile app. The OEM's
backend knows who they are. The OEM's mobile app needs to call
Mentra's backend and have Mentra know which user is calling so state,
audio streams, miniapp installs, etc. attach to the right person.

### Options considered

#### Options 1, 2, 3: SAML SSO, OIDC SSO, OAuth code flow

All three are variations on the same pattern: the user clicks a button,
gets redirected to an identity provider's sign-in screen (often in a
browser), signs in there, and comes back with proof of identity.

- **SAML SSO.** OEM runs a SAML IdP, Mentra is the SAML SP. Signed XML
  assertions flow back.
- **OIDC SSO.** Same shape with a modern JSON-based protocol. OEM is
  the OIDC issuer, Mentra is the relying party. Sub-variant: use a
  broker (WorkOS, Auth0, Clerk) for the protocol layer.
- **OAuth authorization code flow.** OEM is the authorization server.
  User clicks "Sign in with OEM", auth code comes back, exchanges for
  an access token.

**Why none of these fit.** The user already signed in when they opened
the OEM's app. There's no Mentra screen in their experience and there
shouldn't be one (the OEM owns the user-facing flow). For any of these
protocols to work we'd need to introduce a Mentra UI somewhere just so
the redirect has a starting point. That defeats OEM ownership.

These protocols are right when the receiving system has its own
user-facing UI and needs to federate authentication. Our case is the
opposite: the receiving system (Mentra) has no user-facing UI at all.

Options 4 and 5 share the same JWT-mint step on the OEM side. Both
have the OEM sign a per-user JWT with a key registered with Mentra at
onboarding:

```js
const oemJwt = await signJWT(
  {
    iss: "acme-glasses",
    sub: "acme-user-1234",
    aud: "mentra",
    exp: now() + 300
  },
  oemPrivateKey,
  "RS256"
);
```

What differs is what the client does with that JWT after the OEM mints
it.

#### Option 4: Direct-bearer JWT (LiveKit / Twilio / Agora pattern)

The mobile SDK uses the OEM-signed JWT directly as a bearer token on
every Mentra API call:

```
GET https://api.mentra.glass/v1/...
Authorization: Bearer <oem-jwt>
```

Mentra verifies the signature on every request, reads claims, and
authorizes. When the JWT expires, the SDK has to round-trip the OEM's
backend for a fresh one.

**OEM does.** Hold signing key, mint per-user JWTs, refresh on expiry.

**Mentra does.** Verify JWT signature on every request, read claims,
authorize.

**Verdict.** Worse fit for our case. Three problems:

1. **No Mentra-side revocation.** Once a JWT is signed, it's valid
   until expiry. Mentra cannot kick a user mid-session.
2. **Refresh availability.** When the JWT expires, the client has to
   round-trip the OEM's backend for a fresh one. OEM downtime
   becomes Mentra-session downtime.
3. **OEM-defined claim shape.** Every Mentra service has to read
   OEM-shaped claims, plus do `(oem_id, oem_user_id) → MentraUserId`
   resolution per request.

Works for LiveKit/Twilio because their use case is short-lived
real-time sessions where direct bearer is fine. Less fit for our
long-lived persistent service surface.

#### Option 5: JWT bearer + Token Exchange (Firebase Custom Auth pattern)

The mobile SDK exchanges the OEM JWT with Mentra's token endpoint:

```
POST https://api.mentra.glass/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<oem-jwt>
&subject_token_type=urn:ietf:params:oauth:token-type:jwt
```

Mentra verifies the OEM JWT's signature, maps `(iss, sub)` to a
`MentraUserId` (creating the record on first sight), and returns
Mentra-issued tokens:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

Subsequent Mentra API calls use the Mentra-issued `access_token`. The
SDK auto-refreshes against Mentra's refresh endpoint using the refresh
token. The OEM backend is not in the refresh path after the initial
exchange.

**OEM does.** Hold signing key. Mint a JWT once per user session. Not
in the refresh path after that.

**Mentra does.** Verify OEM JWT once at exchange. Mint and validate
Mentra access + refresh tokens.

**Verdict.** Proposed.

Three reasons:

1. **Server-side revocation.** Mentra controls session lifetime.
   Killing the refresh token in our DB invalidates the session
   immediately.
2. **Refresh independence.** SDK refreshes against Mentra. OEM
   downtime affects only new logins, not existing sessions.
3. **Mentra-defined claim shape.** Internal services see
   `MentraUserId`, `oem_id`, scopes, etc. in our shape. No
   per-request resolution.

Standard mechanism via RFC 8693, so the integration is documented,
not bespoke.

#### Option 6: Server-to-server registration API

**How it works.** Mentra issues the OEM an API key at onboarding. Just
a long random string, no public/private key pair, no signing algorithm
choice. The OEM's backend keeps it secret and uses it like any other
REST API key.

When a user signs in to the OEM's app, the OEM's backend makes one
HTTP call to Mentra:

```
POST https://api.mentra.glass/v1/oem/sessions
Authorization: Bearer mtr_oem_acme_abc123...
Content-Type: application/json

{
  "user_id": "acme-user-1234",
  "display_name": "Alice"
}
```

Mentra verifies the API key, mints a Mentra session, returns
`access_token` + `refresh_token`. The OEM's backend hands those to its
mobile app, which uses them for all Mentra calls.

**OEM does.** Hold API credentials. Call Mentra once at session start.
No JWT signing.

**Mentra does.** Verify API credentials, mint session.

**Verdict.** Secondary path. Functionally equivalent outcome to
Option 5 (a Mentra-issued session token on the wire), without
requiring the OEM to do JWT crypto.

**Why have both Option 5 and Option 6.** Some OEMs already do JWT
signing for their own systems and Option 5 fits their habits. Others
are smaller or want the path of least resistance and prefer Option 6.
The trust model is similar. Both require the OEM to keep a secret on
their backend; only the secret format differs (signing key vs API
key). The mobile SDK and Mentra services downstream see the same
Mentra-issued tokens either way.

Bespoke instead of standardized, but the protocol is small enough that
this is acceptable.

### Proposal

**Option 5 as primary integration path. Option 6 as secondary for
OEMs that prefer it.** OEM picks one at onboarding.

Reasoning:

- Option 5 is the right shape (server-side revocation, refresh
  independence, Mentra-defined claims) and is standardized via RFC
  8693, so OEMs that already do JWT signing have an off-the-shelf
  integration.
- Option 6 covers OEMs that don't want to handle keys or signing. The
  outcome on Mentra's side is identical (Mentra-issued session
  token); only the input form differs.
- Options 1, 2, 3 don't fit the architectural shape. We don't have a
  user-facing UI to redirect from.
- Option 4 is viable but has worse operational properties for our
  use case (revocation, refresh dependence).

Both Option 5 and Option 6 produce the same Mentra-issued session
token on the wire, so downstream Mentra services don't need to
distinguish them.

---

## Q2: Mentra to miniapp identity

The setup: today, Mentra auto-auths miniapp backends with the user's
Mentra email. A miniapp dev's backend gets a verified header on
inbound calls saying "this user is alice@example.com." Stable
identity, used by miniapps to key their own user state. Major DX win.

Under cloud v2, if OEM-attested users use this same handoff, miniapp
devs implicitly trust every OEM Mentra has approved. A rogue or
compromised OEM could mint a JWT for any of their users, get a Mentra
session, and that session would auto-auth into any miniapp the user
has used. The trust radius for a miniapp dev expands from one party
(Mentra) to N (Mentra plus every OEM).

This is a real architectural decision with no clever workaround.
There is no cryptographic move that lets a miniapp distinguish a
real user from an OEM impersonating their own user, because the OEM
is the source of truth for who their users are.

### Options considered

#### Option A: Same as today

**How it works.** OEM-attested users auto-auth to miniapps with
MentraUserId. Miniapp dev never knows which OEM attested.

**Verdict.** Trust radius expansion happens silently and
unilaterally. Miniapp devs who currently trust Mentra now trust every
OEM without consenting to that.

#### Option B: oem_id in handoff payload

**How it works.** The auto-auth payload to miniapp backends adds an
`oem_id` claim alongside `MentraUserId`. Default behavior preserved:
miniapps that don't read `oem_id` work exactly as today. Miniapps
that care can read `oem_id` and apply their own trust policy.

Configuration values for the miniapp dev:

- Default: trust all OEMs (preserves today's DX).
- Strict: trust only Mentra-direct users (`oem_id` absent or set to
  Mentra's reserved value).
- Whitelist: trust a specific list of OEMs.

**Verdict.** Proposed.

The trust radius is now visible. Miniapp devs who care can opt into
strict policy. Miniapp devs who don't care keep today's DX. Cheap to
implement.

#### Option C: Per-miniapp pseudonymous IDs

**How it works.** Miniapp backends see `H(MentraUserId, miniapp_id)`
instead of MentraUserId. The hash is stable per (user, miniapp), but
no two miniapps see the same identifier for the same user.
Equivalent to Apple's "Sign in with Apple" private email model.

**Verdict.** Future opt-in for privacy-sensitive miniapps.

Doesn't fix the within-miniapp impersonation problem (an OEM can
still impersonate their user inside any single miniapp), but
prevents cross-miniapp correlation if an OEM is compromised.

Not the default because it breaks today's "miniapp dev knows their
users by stable identifier" DX.

#### Option D: No auto-auth for OEM-attested users

**How it works.** OEM-attested users can use Mentra services but
must sign in separately to each miniapp through the miniapp's own
auth.

**Verdict.** Kills the auto-auth DX win and would require
miniapp devs to build per-miniapp signup flows. Available as the
strict end of Option B's policy spectrum, but not the default.

#### Option E: Per-miniapp opt-in

**How it works.** Miniapp dev decides whether their app accepts
OEM-attested identity at all, on a per-app basis. Configured in the
miniapp store metadata.

**Verdict.** Compatible with Option B. Option B is the
implementation; Option E is the configuration surface.

### Proposal

**Option B as default, with Option E as the miniapp-dev configuration
surface.** Option C available as a future opt-in for privacy-sensitive
miniapps.

Reasoning:

- Option B exposes the trust decision to miniapp devs without
  forcing a change on those who don't care.
- Default-trust-all preserves today's DX.
- Strict / whitelist policies cover miniapp devs who handle
  sensitive data.
- Option C is technically richer but breaks today's stable-identifier
  DX, so not the default. Worth shipping later as opt-in.

---

## End-to-end flow under the proposal

**At OEM onboarding (one-time):**

1. OEM signs up via the OEM portal.
2. OEM picks an integration path:
   - **Path 5 (JWT exchange):** Registers a JWK Set URL or a public
     key with Mentra.
   - **Path 6 (server API):** Receives an API key + secret pair.
3. OEM agrees to Mentra's OEM terms (out of scope here).

**At session start (every user):**

Path 5:

1. User signs in to OEM's mobile app via OEM's auth.
2. OEM backend mints JWT: `{iss: oem_id, sub: oem_user_id, aud:
   "mentra", exp: now+5min, ...}`. Signs with OEM's private key.
3. Mobile SDK calls `POST /oauth/token` (RFC 8693) with the JWT.
4. Mentra verifies signature against OEM's registered JWK, maps
   `(oem_id, oem_user_id)` to MentraUserId (creating the record on
   first sight), returns access token + refresh token.
5. SDK uses access token for all Mentra API calls.

Path 6:

1. User signs in to OEM's mobile app via OEM's auth.
2. OEM backend POSTs `/v1/oem/sessions` with API credentials + OEM
   user ID + metadata. Mentra mints session, returns access + refresh
   tokens.
3. OEM backend hands tokens to the mobile app.
4. Mobile app uses access token for all Mentra API calls.

**Per request to Mentra services:**

1. SDK sends Mentra access token in `Authorization: Bearer` header.
2. Mentra services verify and read `MentraUserId`, `oem_id`, scopes.

**Per request to miniapp backends:**

1. Mentra includes `MentraUserId` and `oem_id` in the auto-auth
   payload.
2. Miniapp backend applies its trust policy (default: trust all).

**On expiry:**

1. SDK auto-refreshes against Mentra using refresh token.
2. OEM backend not in the loop.

**On revocation:**

- Per-user: Mentra deletes refresh token, blacklists access token.
  Effective immediately for new requests.
- Per-OEM: Mentra disables the OEM's signing key / API credentials
  and bulk-revokes refresh tokens for sessions issued under that
  OEM. New token-exchange attempts fail.

---

## Open questions for team review

1. **Identifier shape.** `MentraUserId` opaque (UUID) or structured?
   Should it carry `oem_id` semantically or stay opaque?
2. **Existing email-based Mentra users.** Treat the Mentra-direct
   path as one OEM (Mentra is OEM #0), or as a separate codepath?
3. **Multi-OEM users.** Should the same human have separate
   `MentraUserId`s under separate OEMs, or do we try to unify?
   Default is separate, but with miniapp UX implications.
4. **Miniapp store login UX.** When a user opens the Mentra-owned
   miniapp store inside an OEM app, do we surface anything
   Mentra-branded, or does it stay fully OEM-skinned?
5. **Token exchange subject identifier.** Use `(oem_id, oem_user_id)`
   verbatim or hash for privacy?
6. **Metadata propagation.** What user metadata (display name, email,
   avatar) does the OEM pass at exchange time, and does that
   metadata show up in miniapp handoffs?
7. **OEM portal scope.** Just OEM credentials/keys, or also dev
   tooling (logs, support, etc.)?
8. **Audio event authentication (Phase 2 feature).** Is the Mentra
   access token sufficient, or does that need its own signing model?

---

## Out of scope

- Implementation. The design will live in `design.md`.
- Miniapp ↔ developer-server auth (Phase 2, separate concern).
- OEM portal UX. The spec defines what's configured, not the screens.
- Specific protocol-level details (claim names, token lifetimes,
  endpoint paths). Those go in `design.md`.
- OEM commercial / contract terms.
