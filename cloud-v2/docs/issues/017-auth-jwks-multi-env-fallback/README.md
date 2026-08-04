# 017 - @mentra/auth multi-environment JWKS fallback

**Status:** Implemented, verified, and shipped to production Merge. Ordered multi-environment fallback lives in `packages/auth/src/index.ts`; 6 new tests cover the collision, first-env hit, claim-failure-not-retried, no-key, and override cases (15/15 pass). Auth build and root `tsc -b` are clean. All four live endpoints (prod, staging, dev, debug) serve JWKS (HTTP 200). Proven against a real production miniapp (Local Merge) on a real device, see "Production verification" below. Remaining: review and the eventual npm publish of `@mentra/auth`.

## Problem

`@mentra/auth` (the package a developer drops into their miniapp backend to verify the per-miniapp tokens Cloud Core mints) resolves a single JWKS URL, hard-coded to production:

```ts
const DEFAULT_JWKS_URL = "https://core.mentraglass.com/.well-known/jwks.json";
```

A developer can override `jwksUrl`, but otherwise everything verifies against prod's public keys only. That breaks anyone whose miniapp receives tokens from a non-prod Mentra backend (dev, staging, debug), and the failure mode is subtle.

### Why it is subtle: colliding kids, different keys

Every environment serves JWKS at `/.well-known/jwks.json` (all return 200), but they use the **same `kid` values with different key material**:

| kid | prod | staging | dev | debug |
|---|---|---|---|---|
| `mentra-miniapp-1` | key A | key B | key B | key B |
| `mentra-access-1` / `cloud-core-runtime-1` | key A | key B | key C | key C |

Because the `kid` matches across environments but the key differs, a token minted by dev (kid `mentra-miniapp-1`) is **found** in prod's JWKS by `kid`, then **fails signature verification** against prod's key. So `jose` throws a signature error, not a "no matching key" error, and the developer just sees auth failing for no obvious reason. The only current workaround is manually setting `jwksUrl`.

Keys are intentionally **not** shared across environments (a dev key leak must not forge prod tokens), so we cannot rely on one URL working everywhere.

## Goal

The package should work against any Mentra backend with zero configuration: try the known environment JWKS endpoints in order (prod, staging, dev, debug) and accept the first that verifies. An explicit override still wins for self-hosted or local Core.

## Required behavior

- Ship an **ordered list** of Mentra JWKS URLs and verify against each in order; first success wins.
- **Fall through on key-mismatch errors only** (`ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, `ERR_JWKS_NO_MATCHING_KEY`, `ERR_JWKS_MULTIPLE_MATCHING_KEYS`). A claim failure (expired, wrong audience, wrong issuer) means the right key already verified the signature, so reject immediately. Never retry those across environments.
- **Preserve the override.** An explicit single URL (`jwksUrl` option or `MENTRA_AUTH_JWKS_URL` env) skips the fallback entirely. This is how self-hosters and local Core keep working.
- **Cache per endpoint** (each `createRemoteJWKSet` caches with its own cooldown). Steady state: a prod miniapp only ever fetches prod; a dev miniapp fetches prod+staging+dev once, then is cached.

### Config / precedence

1. `options.jwksUrls: string[]` (ordered list; also the test injection point).
2. `options.jwksUrl: string` (single; back-compat override).
3. env `MENTRA_AUTH_JWKS_URLS` (comma-separated, ordered).
4. env `MENTRA_AUTH_JWKS_URL` (single).
5. Default: the built-in Mentra environment list (prod, staging, dev, debug).

### Default list

```
https://core.mentraglass.com/.well-known/jwks.json                 # prod
https://core.staging.us-west-2.mentraglass.com/.well-known/jwks.json # staging
https://core.dev.us-west-2.mentraglass.com/.well-known/jwks.json     # dev
https://core.debug.us-west-2.mentraglass.com/.well-known/jwks.json   # debug
```

## Out of scope / do not touch

- No server-side changes. Do not modify how any environment signs tokens or which `kid`s it uses. Debug is read-only here.
- A cleaner long-term fix is unique per-environment `kid`s (so a single merged JWKS resolves unambiguously and no fallback loop is needed), but that changes every environment's signing config, including debug, so it is deferred.

## Verification

- `bun test cloud-v2/packages/auth/src/index.test.ts`, including new cases:
  - token from env B verifies even when env A (tried first) has the same `kid` with a different key (the collision case).
  - token signed by env A still verifies without falling through.
  - expired / wrong-audience token rejects immediately and is not retried across environments.
  - token whose `kid` exists in no environment rejects.
  - explicit `jwksUrl` override skips the fallback.
- `cd cloud-v2 && bun run typecheck`.

### Real-token verification (true end to end)

A miniapp that uses the auto-auth system receives a real, environment-signed
token in its `Authorization` header: `cloud-client` mints it via
`POST /api/client/auth/miniapp-token` using the connected device's user session,
then delivers it to the miniapp backend. `mentra dev` alone cannot mint one (it
has no user identity); a real device session pointed at the environment is what
produces it.

`scripts/verify-token-env.ts` takes such a token, fetches every Mentra
environment's live JWKS, and reports which environment's key validates the
signature (the exact decision the fallback makes), then runs the real
`createMentraAuth().verifyToken()` path.

```
bun run packages/auth/scripts/verify-token-env.ts <token>
# or: MENTRA_TOKEN=<token> bun run packages/auth/scripts/verify-token-env.ts
```

To capture a real token: open any auto-auth miniapp on a device (phone or the
harness emulator) pointed at the target environment, and copy the bearer token
the miniapp backend receives (log `Authorization` in the backend, or read it
from the runtime logs).

Demonstrated so far:
- Self-test (mock environment placed second, behind prod): prod is tried first
  and rejected with `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` (same `kid`, wrong
  key), the verifier falls through and the second environment `PASS`es, and
  `verifyToken()` returns the right user/tenant/package. This exercises the real
  collision with real EdDSA crypto.
- Live: against the four real endpoints, a token not signed by any Mentra
  environment is rejected by all four (each reachable, each a signature
  mismatch). A genuine dev-minted token will flip the `dev` line to `PASS`.

## Production verification (Local Merge, real device)

This bug was hit in the wild and fixed end to end on 2026-06-30.

Symptom: the Local Merge miniapp (`com.mentra.local-merge`) showed "AI offline
backend" on a Pixel 8. Captions worked, but Merge's insight calls to its backend
(`merge3.mentraglass.com`) returned 401. Device logcat, repeatedly:

```
[com.mentra.local-merge] console.log: 'LocalMerge: insight backend failed: backend 401'
```

Root cause (textbook case of this issue):
- The phone's cloud-v2 Core (`cloud_core_url`) was **staging**, so `cloud-client`
  minted a **staging**-signed `local-merge` token.
- The Merge backend verifies with `@mentra/auth`, and its prod Doppler config had
  `MENTRA_AUTH_JWKS_URL` pinned to a single environment. A single-URL env value
  overrides the fallback, so Merge only accepted one environment's key. Same
  `kid`, different key -> `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` -> 401.

Fix (two parts, both required):
1. Deployed the new `@mentra/auth` to `merge3` via the `merge-prod` Porter
   workflow (commit `4263725e5`). The Merge Dockerfile builds `@mentra/auth` from
   source (`COPY cloud-v2/packages/auth` then `bun run build`), so no npm publish
   was needed. Merge's backend code already calls `createMentraAuth({ packageName })`
   with no `jwksUrl`, so the new default fallback list took effect automatically.
2. Removed `MENTRA_AUTH_JWKS_URL` from the `local-merge` `prd` and `dev` Doppler
   configs so the single-URL override no longer suppresses the fallback.
   (`MENTRA_AUTH_ISSUERS=cloud-core,mentra` was left as is.)

Verified: `merge3.mentraglass.com/healthz` -> 200 on the new build; a tokenless
`POST /api/insights` -> 401 (auth still enforced); and on the device Merge began
returning insights again with no further `backend 401` log lines. Note this is
strictly safer for prod users too: prod is tried first in the fallback, so
prod-minted tokens are unaffected.

