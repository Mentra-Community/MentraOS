# Mentra user identity: spike

**Status:** The identity model and the migration bridge are decided (below).
Covers identity for Mentra's own users (consumer app, Dev Console, App/MiniApp
Store) and how OEM users fit. The developer auto-auth mechanism is a sibling
spike, [`../auto-auth/spike.md`](../auto-auth/spike.md).

## Scope

User identity for:

1. **Mentra's own users**: the Mentra consumer app, plus the Dev Console and the
   App/MiniApp Store websites, which all use the same sign-in.
2. **OEM users**: an OEM's app, identity owned by the OEM. Already specced in
   [`../oem-auth/`](../oem-auth/).

The `MentraUserId` and OEM identity model are settled by oem-auth and inherited
here:

- `MentraUserId` is the `users` document's Mongo `_id` (an ObjectId, surfaced as
  its hex string), created on first sight of an `(oemId, oemUserId)` pair. We use
  the DB-generated `_id` rather than minting a separate id. The same human via two
  OEMs is two different `MentraUserId`s.
- Mentra-direct users carry the reserved `oemId = "mentra"`, and their `oemUserId`
  is the Supabase `sub` (stable, unlike email).

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
  token in `console.middleware.ts`, keyed on `email`. One identity system across
  consumer app, Dev Console, and Store.

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
zero"), so Mentra issues its users' tokens as **its own reserved OEM**
(`oemId = "mentra"`): a Mentra-side issuer presents the user's Supabase identity
to the same exchange (the core token during transition, a Supabase session at the
end state). One issuance and revocation path for every surface. See the migration
bridge below.

### OEM users

Already specced: the OEM mints an install JWT, exchanges it via RFC 8693 for the
Mentra access token; Mentra maps `(oemId, oemUserId)` to a `MentraUserId` (the
`users._id`), created on first sight ([`../oem-auth/design.md`](../oem-auth/design.md)).
Identity is owned by the OEM. The dev-backend handoff carries `mentraUserId` +
`oemId` per Q2 Option B (see [`../auto-auth/spike.md`](../auto-auth/spike.md)).

## Migration bridge: core token to v2 access token

During the v1 to v2 transition the client needs to authenticate to both clouds:
the legacy v1 path (existing miniapps, the v1 WS/REST) still wants the core token,
and the v2 path (cloud-runtime, the cloud-client) wants the Mentra access token.
The low-debt bridge keeps the existing login unchanged and derives the v2 token
from the core token:

1. The client logs in exactly as today (Supabase to core token at v1) and uses
   the core token for the v1 path, unchanged.
2. Cloud Core v2 exposes the RFC 8693 exchange where, for the reserved `mentra`
   OEM, the **subject token is the core token**. Mentra is "OEM zero," and its
   "OEM-signed JWT" is the core token it already issues.
3. Cloud Core verifies the core token (it knows the shared secret), maps
   `(oemId = "mentra", oemUserId = the Supabase sub carried in the core token)` to
   a `MentraUserId`, and returns the v2 access + refresh tokens.
4. The client now holds both tokens at once: core token for v1, access token for
   v2 (cloud-runtime plus miniapp-token minting).

Two details:

- **Mentra-as-OEM verifies with the shared secret, not a registered public key.**
  Every other OEM registers an asymmetric key; Mentra's own subject token (the
  core token) is HS256, so the exchange has one internal issuer (`mentra`) that
  verifies against the shared `AUGMENTOS_AUTH_JWT_SECRET`.
- **`oemUserId` for Mentra-direct is the Supabase `sub`** (stable), which the core
  token already carries as its own `sub`.

End state: once v2 is primary, swap the subject token from "core token" to a
Supabase session (direct Mentra login), same endpoint, and retire the core-token
bridge.

## Tracked separately

- **Email-to-`mentraUserId` migration.** v1 keyed users (and dev backends) on
  email. oem-auth `design.md` flags migrating existing email-based Mentra users as
  a separate spec; track it there.

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
