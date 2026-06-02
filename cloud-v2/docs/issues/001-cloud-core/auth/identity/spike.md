# Mentra user identity: spike

**Status:** Findings and open questions. Not a proposal yet. Covers identity for
Mentra's own users (consumer app, Dev Console, App/MiniApp Store) and how OEM
users fit. The developer auto-auth mechanism is a sibling spike,
[`../auto-auth/spike.md`](../auto-auth/spike.md).

## Scope

User identity for:

1. **Mentra's own users**: the Mentra consumer app, plus the Dev Console and the
   App/MiniApp Store websites, which all use the same sign-in.
2. **OEM users**: an OEM's app, identity owned by the OEM. Already specced in
   [`../oem-auth/`](../oem-auth/).

The `MentraUserId` and OEM identity model are settled by oem-auth and inherited
here:

- `MentraUserId` is an opaque ULID (`mu_...`), created on first sight of an
  `(oemId, oemUserId)` pair. The same human via two OEMs is two different
  `MentraUserId`s.
- Mentra-direct users carry the reserved `oemId = "mentra"`.

## Part 1: how v1 works today (the core token)

- The user signs in through **Supabase** (email/password, Google, etc.) at
  `account.mentra.glass` or in the mobile app (legacy Authing also supported).
- The client posts the Supabase token to cloud `POST /auth/exchange-token`. Cloud
  verifies it (`SUPABASE_JWT_SECRET`), `findOrCreateUser(email)`, and issues a
  **core token**: a JWT signed with the symmetric `AUGMENTOS_AUTH_JWT_SECRET`
  (HS256), claims `{ sub, email, organizations, defaultOrg }`
  (`cloud/packages/cloud/src/utils/generateCoreToken.ts`,
  `.../api/hono/routes/auth.routes.ts`).
- **`userId` is the email.** Everything downstream keys on it.
- **The same flow backs every Mentra-direct surface, not just the consumer app.**
  The Store exchanges at `POST /api/store/auth/exchange-token`
  (`api/hono/store/store.auth.api.ts`); the Dev Console verifies the same core
  token in `console.middleware.ts`, keyed on `email` and carrying
  `organizations` / `defaultOrg` for the dev org model. One identity system
  across consumer app, Dev Console, and Store.

Properties worth noting: symmetric secret (only cloud can verify), identity ==
email, no asymmetric/JWKS story.

## Part 2: v2

v2 already has the **Ed25519 Mentra access token** (from oem-auth): claims
`sub = mentraUserId`, `oemId`, `sessionId`, `jti`, with `aud`/`iss`, 1h expiry
and a rotating refresh token, verifiable by any service with Mentra's public key
(`packages/shared/src/auth.ts`). v2 should unify all user identity on this token
and on `mentraUserId`, retiring the symmetric core token and email-as-id.

### Mentra's own users

"Mentra's own users" spans the consumer app, the Dev Console, and the Store, all
on one identity today (Supabase + core token, Part 1). v2 keeps them on a single
identity system and unifies them on the Mentra access token. Architecturally
Mentra's app is just the first consumer of the OEM Toolkit (Mentra is "OEM
zero"). Two ways to issue the token:

- **(a) Mentra as its own OEM.** Supabase is Mentra's identity provider; a small
  Mentra-side issuer mints an OEM-style subject JWT that goes through the same
  `POST /api/oem/oauth/token` exchange. One code path for everyone.
- **(b) Dedicated Mentra login.** A direct endpoint that takes the Supabase
  session and issues the same Ed25519 access token without the OEM exchange
  shape.

Either way the output is the same token format. Lean: (a), so there is a single
issuance and revocation path.

The Dev Console surface carries one extra dimension: developer **organization**
membership (today the core token's `organizations` / `defaultOrg`). In v2 that
should be an org/profile lookup owned by `dev-console-service`, not a token
claim, so the access token stays the same shape for every surface.

### OEM users

Already specced: the OEM mints an install JWT, exchanges it via RFC 8693 for the
Mentra access token; Mentra maps `(oemId, oemUserId)` to an opaque `MentraUserId`
ULID, created on first sight ([`../oem-auth/design.md`](../oem-auth/design.md)).
Identity is owned by the OEM. The dev-backend handoff carries `mentraUserId` +
`oemId` per Q2 Option B (see [`../auto-auth/spike.md`](../auto-auth/spike.md)).

## Open questions

1. **Mentra-user issuance:** Mentra-as-its-own-OEM with reserved
   `oemId = "mentra"` (single exchange path) vs a dedicated Mentra login endpoint.
   Lean: as-its-own-OEM.
2. **Email-to-`mentraUserId` migration.** v1 keyed users (and dev backends) on
   email. oem-auth `design.md` flags migration of existing email-based Mentra
   users as a **separate spec**; track it there.
3. **Dev org model.** Confirm `organizations` / `defaultOrg` moves to
   `dev-console-service` rather than the access token.

## References

- [`../oem-auth/design.md`](../oem-auth/design.md): the Mentra access token shape
  and the `(oemId, oemUserId) -> mentraUserId` mapping.
- [`../auto-auth/spike.md`](../auto-auth/spike.md): the developer auto-auth
  mechanism that consumes this identity.
- v1 code: `cloud/packages/cloud/src/utils/generateCoreToken.ts`,
  `.../api/hono/routes/auth.routes.ts`,
  `.../api/hono/store/store.auth.api.ts`,
  `.../api/hono/middleware/console.middleware.ts`.
- `packages/shared/src/auth.ts` (cloud-v2): the access-token verifier.
