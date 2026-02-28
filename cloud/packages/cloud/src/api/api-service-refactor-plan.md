# API + Services Refactor Plan

Author: Isaiah
Status: Draft (working notes).

## Overview

We currently serve multiple audiences (client/mobile, store/public, console/dev portal, sdk/3rd‑party backends) through a tangled set of legacy routes and a bloated service (`app.service.ts`). Handlers often mix business logic and middleware, and several features rely on WebSockets where REST would be simpler and safer. This plan splits APIs and services by audience, adds clean routes, and keeps legacy routes as shims so nothing breaks while we migrate.

## Problem

- Routes mix handler logic, auth, and business rules; unclear ownership and naming.
- `app.service.ts` contains catalog, developer CRUD, runtime webhooks, security, and validation.
- Duplicated behaviors (e.g., API key validation) with inconsistent logging.
- Validation drift (tool/settings schemas don’t match in different modules).
- Confusing preinstalled/uninstallable behavior.
- Heavy middleware side effects (org mutation/creation during auth).
- WS used for one‑shot actions (harder to reason about, version, and debug).
- Webhook auth passes hashed API key in a header (weak pattern).

## Goals

- Organize by audience and mirror this in APIs and services:
  - APIs: `src/api/{client|store|console|sdk}`
  - Services: `src/services/{client|store|console|sdk}`
- Keep handlers small; move logic into services.
- Keep legacy routes wired as shims during migration; no new features added there.
- Canonicalize security (API key/JWT) and validation (tool/settings) in one place each.
- Shift client actions to REST where possible; keep WS for streaming.
- Fix easy bugs/smells while moving (no behavior regressions for legacy routes).

## Audiences → Services (no shared/)

- client
  - Service: `src/services/client/app.service.ts`
  - Responsibilities: end‑user app actions and reads (installed list, install/uninstall, start/stop).
  - New routes live under `/api/client/*`.
- store
  - Service: `src/services/store/catalog.service.ts`
  - Responsibilities: public/published catalog, app details, search, preinstalled composition.
  - New routes live under `/api/store/*`.
- console
  - Services:
    - `apps.service.ts` (org‑scoped CRUD: create/update/delete/getByPackage/move‑org/regenerate API key)
    - `publishing.service.ts` (status transitions, publish workflow)
    - `assets.service.ts` (Cloudflare Images upload/delete)
    - `validation.service.ts` (canonical tool/settings validation)
    - `sharing.service.ts` (share link + tracking)
  - New routes live under `/api/console/*`.
- sdk
  - Services:
    - `auth.service.ts` (validate API key/JWT, hashWithApiKey; scrub secrets in logs)
    - `tool-webhooks.service.ts` (tool/stop webhooks with signing + retries)
  - New routes live under `/api/sdk/*` (only if/when needed; WS continues to use these services internally).

## What the current UIs call (quick map)

- Store site
  - Catalog (store): GET `/api/apps/public`, `/api/apps/available?organizationId=`, `/api/apps/:packageName`, `/api/apps/search?q=`
  - Client actions (client): GET `/api/apps/installed`; POST `/api/apps/install/:pkg`, `/api/apps/uninstall/:pkg`, `/api/apps/:pkg/start`, `/api/apps/:pkg/stop`
  - Auth/user: POST `/api/auth/exchange-token`, `/api/auth/exchange-store-token`; GET `/api/user/me`
- Console site
  - Console auth/orgs: `/api/dev/auth/*`, `/api/orgs/*` (+ invites/members)
  - Console apps: `/api/dev/apps` (list), `/api/dev/apps/:pkg` (get/update/delete), `/api/dev/apps/register`, `/api/dev/apps/:pkg/api-key`, `/publish`, `/move-org`
  - Console images: POST `/api/dev/images/upload`, DELETE `/api/dev/images/:imageId`
  - Console sharing: GET/POST `/api/dev/apps/:pkg/share`
  - Client actions reused: `/api/apps/installed`, `/api/apps/install/:pkg`, `/api/apps/uninstall/:pkg`

## Plan (incremental, no breaking changes)

1. Create audience services + audience routers
   - Add service files and thin API handlers that delegate to existing logic.
   - No behavior changes; legacy routes stay wired.
2. Move implementations domain‑by‑domain
   - Extract from `app.service.ts` into the audience services (catalog → store, end‑user actions → client, dev CRUD/publish → console, auth/webhooks → sdk).
   - Legacy routes become shims calling the new services.
3. Canonicalize and harden
   - Security: `sdk/auth.service.ts` becomes single source for validateApiKey/JWT/hashWithApiKey; remove duplicate implementations and sensitive logs.
   - Validation: `console/validation.service.ts` becomes single schema; fix null guards and align parameter shapes.
   - Preinstalled: decide uninstallable semantics and enforce.
   - Webhooks: add signed requests (e.g., `X-Signature: HMAC_SHA256(payload, apiKey)`), keep legacy header during a grace period.
4. Shift client flows to REST
   - Continue to support WS for streaming; avoid new one‑shot actions over WS.
5. Clean up
   - Remove deprecated code/routes once traffic has moved and we have confidence.

## Compatibility

- Keep all legacy routes intact as shims during migration.
- Maintain response shapes and auth semantics for existing endpoints.
- Introduce new routes under `/api/{client|store|console|sdk}`; prefer these in new code.
- Log deprecation warnings in legacy paths to guide migration (no noise to end users).

## Low‑risk fixes to include during the move

- Remove any plaintext API keys from logs.
- Fix `activationPhrases` null/undefined handling in validation.
- Align tool/settings schema to a single canonical shape.
- Clarify and fix preinstalled uninstallable behavior.
- Improve webhook robustness (retries, timeouts consistent with comments).

## Assumptions to confirm

- Preinstalled apps should NOT be uninstallable.
- Canonical tool/settings schema should match the `@mentra/sdk` types currently used.
- Webhook signing approach: HMAC over raw JSON payload using apiKey as the secret (acceptable short‑term).
- Audience boundaries:
  - client = end‑user actions (install/uninstall/start/stop)
  - store = read‑only catalog
  - console = developer ownership, publishing, assets
  - sdk = app backend auth and webhooks

## Questions

- Any mobile/client flows that must remain WS‑only for now?
- Should org creation currently happening in dev auth middleware be moved immediately, or gated behind a flag before moving to explicit endpoints?
- Any SDK consumers that can’t accept a parallel signed header during the webhook grace period?
- OK to make `store/catalog.service.ts` the source of truth for preinstalled?

## Done criteria

- Audience services and routers exist; legacy routes delegate only.
- SDK auth and console validation are single‑sourced.
- Webhooks are signed; sensitive logs scrubbed.
- Preinstalled uninstallable semantics are clear and enforced.
- Client actions available via REST; WS kept for streaming.
