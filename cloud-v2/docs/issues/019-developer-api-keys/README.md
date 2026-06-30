# 019 — Mentra-owned developer API keys (take WorkOS out of the publish path)

**Status:** proposal / RFC (design only — no code in this PR)
**Owner:** _tbd_
**Reviewers:** Isaiah
**Related:** [011 miniapp registry](../011-miniapp-registry), [017 auth JWKS fallback](../017-auth-jwks-multi-env-fallback), PR #3288 (console org roles — the access gate this builds on)

## Summary

Issue and validate developer-console API keys **ourselves**, in Core + our own
database, and remove WorkOS from the miniapp-publish credential path. WorkOS
stays for interactive human login (the session JWT) only. This is the Phase-2
follow-on to the roles PR (#3288); that PR gates **who** may create/revoke keys,
this one changes **what** a key is and **where** it lives.

Not urgent, not a blocker — but we will want it: a developer's API key is the
credential that publishes miniapps to glasses, and today it is a WorkOS-managed
secret validated by a round-trip to WorkOS. We should own that.

## Why

Today the publish credential is WorkOS, not Mentra. Two WorkOS dependencies sit
in the critical path:

1. **Interactive publish** — `mentra login` mints a WorkOS **session JWT**,
   verified against WorkOS JWKS (`authenticateBearerToken`,
   `cli-auth.api.ts`). _(Out of scope here — login stays on WorkOS.)_
2. **Headless / CI publish** — an org **API key** created in the console
   (`POST /tokens` → `workos().apiKeys.createOrganizationApiKey`), stored in
   WorkOS, and validated on every request via
   `workos().apiKeys.createValidation({ value })` (`authenticateApiKeyToken`).

This RFC replaces **(2)** with Mentra-issued keys. Reasons:

- **Own the publish credential.** Publishing a miniapp to a user's glasses is a
  core Mentra primitive; its auth secret should not live in a third-party auth
  vendor's "API Keys" product.
- **No per-request vendor round-trip.** `createValidation` calls WorkOS on every
  authenticated API-key request. A local hash compare is faster and removes a
  WorkOS availability dependency from CI publishing.
- **Control the key model.** Env-pinned key strings, our own revocation,
  `lastUsedAt`, future per-key scopes — none of which we control through WorkOS.
- **It is well within what Core already does.** Core already mints and verifies
  Ed25519 miniapp tokens (`@mentra/auth`), manages refresh tokens
  (`refresh-token.model.ts`), and stores signing keys
  (`developer-signing-key.model.ts`). A hashed random secret with an indexed
  lookup is strictly simpler than the Ed25519/JWKS machinery already in place.

## Current state (what we replace)

| Surface | Today |
|---|---|
| Create | `POST /console/tokens` → `workos().apiKeys.createOrganizationApiKey({ organizationId, name })` |
| List | `GET /console/tokens` → `workos().apiKeys.listOrganizationApiKeys` |
| Revoke | `DELETE /console/tokens/:id` → `workos().apiKeys.deleteApiKey` |
| Validate | `authenticateApiKeyToken` → `workos().apiKeys.createValidation({ value })` → org via `workosApiKeyOrganizationId` |
| Transport | CLI sends `Authorization: Bearer <key>`; `authenticateConsoleSession` tries JWT verify first, falls back to API-key validation |

The CLI never needs to change — it already sends a bearer token. Only the key
**string format** and the **server-side issue/validate** change.

## Design

### Data model — `DeveloperOrgApiKey` (our DB)

```ts
{
  keyId: string;            // public id, `dak_<ulid>` — unique
  orgId: string;            // DeveloperOrg.orgId — indexed
  name: string;
  prefix: string;           // e.g. "msk_dev_dak_01HX…" head, shown as the obfuscated value
  hash: string;             // sha256(secret) — we NEVER store the secret
  last4: string | null;     // display only
  createdByUserId: string;
  createdAt: Date;
  lastUsedAt: Date | null;  // throttled update on use
  revokedAt: Date | null;   // revoke = set this; validation filters it
}
// indexes: unique { keyId }, { orgId }, { revokedAt }
```

### Key string format

```
msk_<env>_<keyId>_<secret>
   |     |       |        └─ 32 random bytes, base62  (the only secret part)
   |     |       └────────── public key id (lets us look up + revoke by id)
   |     └────────────────── env: dev | staging | prod  (hard-fails cross-env use, eases leak triage)
   └──────────────────────── "mentra secret key" brand prefix
```

- Shown **once** at creation, exactly like today. We store only `sha256(secret)`.
- Embedding `keyId` in the string makes validation an **indexed lookup**, not a
  table scan or a hash-index match.

### Issuance — `POST /console/tokens` (admin+, already gated by #3288)

1. Generate `keyId` + 256-bit `secret`.
2. Store `{ keyId, orgId, name, prefix, hash: sha256(secret), createdBy }`.
3. Return the full `msk_…` string once; the UI copies it. The list endpoint
   only ever returns `prefix`/`last4`, never the secret.

### Validation — request auth

In `authenticateConsoleSession`, on the bearer path:

- If the token starts with `msk_`, route to `authenticateMentraApiKey(token)`:
  1. Parse `env`, `keyId`, `secret`. Reject if `env !== <this Core's env>`.
  2. `findOne({ keyId, revokedAt: null })`.
  3. **Constant-time** compare `sha256(secret)` to the stored `hash`.
  4. On success return `{ authenticated: true, user: { id: \`api_key:${keyId}\`, … }, organizationId }`.
  5. Fire-and-forget, **throttled** `lastUsedAt` update (≤ once/min/key) — never block the request.
- Else fall through to the existing WorkOS JWT verify (human sessions) and,
  during migration, the WorkOS API-key fallback.

**Hash choice:** the secret is 256-bit random, so a fast hash (SHA-256) is
sufficient and keeps validation cheap on the hot path. Argon2/bcrypt buy little
against a high-entropy secret and add per-request CPU. _Open question for
Isaiah — see below._

### Org resolution (minimize blast radius)

Downstream code keys off `organizationId` = the **WorkOS** org id (the
session/api-key carries `org_id`, then `resolveDeveloperOrgForSession` maps
WorkOS org → `DeveloperOrg`). Our key already knows the `DeveloperOrg.orgId`.

- **v1 (minimal):** `authenticateMentraApiKey` looks up `DeveloperOrg.workosOrgId`
  from `orgId` and sets `organizationId` to it, so the existing resolution path
  is unchanged.
- **Later (cleaner):** carry a first-class `developerOrgId` on the auth result
  and short-circuit `resolveDeveloperOrgForSession`. Broader refactor; not v1.

## Migration / cutover (dual-stack, zero-downtime)

1. **Add, don't replace.** Ship Mentra-key issuance + validation **while still
   accepting WorkOS keys** (keep the existing fallback). New keys created in the
   console are Mentra keys; the list reads from our DB.
2. **Coexist + nudge.** Existing WorkOS keys keep validating via the fallback.
   Show a one-time "rotate to a new key" banner; optionally surface legacy WorkOS
   keys read-only with a "legacy" badge during the window.
3. **Remove WorkOS.** Once telemetry shows zero WorkOS-key validations for N
   days, delete `authenticateApiKeyToken` + every `workos().apiKeys.*` call.

No CLI release is required at any step — the bearer transport is unchanged.

## Security

- Store **only** `sha256(secret)`; constant-time compare; never log the secret.
- **Env-pinned** key strings hard-fail cross-environment use and make leaked-key
  triage trivial.
- Revocation is `revokedAt` (validation filters it); instant, no vendor call.
- Rate-limit validation failures per IP/keyId to slow brute force (256-bit
  entropy already makes guessing infeasible).
- Audit key create/revoke (reuse `admin-action-audit-log.model.ts` or a dev-org
  audit log).
- v1 keys are **org-scoped, full-access** (same as today). Per-key scopes
  (publish-only / read-only) are a future increment.

## Phases

- **2a** — model + issuance + validation + WorkOS-key fallback (dual-read); console list reads our DB. _Ship behind this; nothing breaks._
- **2b** — rotate banner + legacy-key surfacing; telemetry on WorkOS-key usage.
- **2c** — remove WorkOS API-key code + `workos().apiKeys.*`.

## Open questions for Isaiah

1. **Hash:** SHA-256 (fast, fine for 256-bit secrets) vs Argon2 (defense-in-depth)? Recommend SHA-256.
2. **Org plumbing:** map to `workosOrgId` for a minimal v1, or carry a first-class `developerOrgId` now? Recommend minimal for v1.
3. **Scopes:** org-scoped full-access for v1, per-key scopes later — agree?
4. **Key branding/format:** `msk_<env>_<keyId>_<secret>` — naming and env encoding OK?
5. **Legacy WorkOS keys:** silent fallback + rotate banner, or also list them read-only during the window?

## Out of scope

- Interactive `mentra login` (stays on WorkOS session JWTs).
- The org roles layer (PR #3288) — this RFC assumes it for the create/revoke gate.
- The WorkOS invitation-email → `localhost` redirect fix (separate).
