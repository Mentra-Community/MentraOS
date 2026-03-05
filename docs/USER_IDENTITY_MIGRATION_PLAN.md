## User Identity Migration Plan

This document describes a phased plan to move MentraOS away from using `email` as the primary user identifier and toward a canonical `userId` (UUID) plus flexible identifiers (email, phone, OAuth, etc.).

---

## Goals

- **Introduce a stable `userId`**: Use a UUID field as the canonical, opaque user identifier.
- **Make `email` optional**: Treat email as one of several identifiers, not the primary key.
- **Support multiple identifiers**: Allow email, phone, OAuth IDs, Supabase IDs, etc. per user.
- **Roll out safely**: Migrate schema, data, and call sites in stages without breaking existing flows.

---

## Phase 1 – Introduce `userId` (no behavior change)

**Objective:** Add the new identity shape while keeping current behavior intact.

- **Model changes**
  - Add `userId: string` to `User`:
    - `required: true`, `unique: true`, `index: true`
    - `default: () => randomUUID()`
  - Keep `email` required in the schema for now (no breaking change to existing code).
- **Statics / helpers**
  - Add `User.findByUserId(userId)` (not yet widely used).
- **Serialization**
  - Update `toJSON` to expose `id = userId || _id` so clients can start relying on the new ID.
- **Data**
  - New records get `userId` automatically via default.
  - Existing records only get `userId` when they are next saved (no backfill yet).

**Exit criteria**

- New users always have a non-null `userId`.
- All tests pass with the new field present.
- No behavior change for existing flows (email still required and used everywhere).

---

## Phase 2 – Backfill data and start using `userId`

**Objective:** Ensure every user has a `userId` and begin treating it as the primary key internally.

- **Migration**
  - Write a one-off script to:
    - Scan all users.
    - For any document missing `userId`, set `userId = randomUUID()`.
  - Run in batches in lower environments first, then production.
- **Indexes**
  - Add a unique index on `userId` after the backfill completes.
- **Code changes**
  - Prefer `userId` for:
    - JWT/session subjects and tokens.
    - Service-to-service calls and background jobs.
  - Introduce `findByUserId` into new or refactored flows (auth, device pairing, dashboards).
- **Monitoring**
  - Add logging/metrics to track usage of `findByUserId` vs `findByEmail`.

**Exit criteria**

- 100% of users have a non-null `userId`.
- Core auth/session paths use `userId` as the canonical identifier.
- No unique index violations on `userId` in production.

---

## Phase 3 – Add identifiers array & deprecate email as key

**Objective:** Allow multiple identifiers per user and move past email as the main identity handle.

- **Schema changes**
  - Add `identifiers: { type, value, provider?, verifiedAt? }[]` to the `User` model.
  - Add unique sparse index:
    - `({ "identifiers.type": 1, "identifiers.value": 1 }, { unique: true, sparse: true })`.
  - Make `email` optional and sparse:
    - `required: false`
    - `unique: true, sparse: true`
- **Helpers**
  - Add statics:
    - `User.findByIdentifier(type, value)`.
  - Add instance helper:
    - `user.addIdentifier(type, value, provider?)`.
- **Data migration**
  - For each user with an `email` value:
    - Ensure an identifier entry `{ type: "email", value: email }` exists.
  - Run ahead of enabling the unique index to avoid collisions.
- **Code changes**
  - New identity flows:
    - Use `findByIdentifier` for Supabase/OAuth/other external IDs.
    - Keep `findByEmail` as a compatibility wrapper around `findByIdentifier("email", email)`.
  - Gradually refactor existing logic that assumes email is present to tolerate email-less users.

**Exit criteria**

- All email-bearing users have an `"email"` identifier row.
- New identity sources (Supabase, OAuth, etc.) never use email as their primary key.
- Identifier-based lookups are the default for new and refactored features.

---

## Phase 4 – Make email truly optional & clean up

**Objective:** Treat email strictly as a contact method / identifier and remove legacy assumptions.

- **API and types**
  - Update public contracts:
    - `userId: string` required wherever a user identifier is needed.
    - `email?: string` optional in all APIs and TypeScript types.
  - Add/adjust endpoints:
    - Prefer `userId` in path/query parameters instead of email.
    - Keep email-based endpoints only where user experience demands it (e.g. “forgot password”).
- **Refactors**
  - Search and update:
    - `User.findOne({ email: ... })` → `findByUserId` or `findByIdentifier`.
    - Any use of email as a cross-model foreign key → swap to `userId` (or `_id`) where appropriate.
  - Mark email-based helpers (`findByEmail`, `findOrCreateUser(email)`) as deprecated in JSDoc.
    - Keep only for UX flows that truly need email; remove once all callers are migrated.
- **Indexes and constraints**
  - Revisit indexes that depend on email (e.g. `email + runningApps`).
  - Adjust or replace them with `userId`-centric constraints if the original constraint assumed email was always present.

**Exit criteria**

- Core flows (auth, device pairing, dashboard, logs) do not rely on email being present.
- All primary identity operations are based on `userId` and/or `identifiers`.
- Remaining email-based behavior is explicitly UX-driven, not foundational to identity.

---

## Rollout and Safety Checklist

**Before enabling identifiers and email-optional:**

- [ ] Phase 1: `userId` field added, tests passing.
- [ ] Phase 2: Backfill complete, `userId` unique index green.
- [ ] Phase 3: Identifiers array populated for all existing emails.

**Before treating email as optional in production:**

- [ ] Auth/session middlewares consume `userId` as the canonical subject.
- [ ] New APIs and internal services use `userId` instead of email for identity.
- [ ] Frontend and mobile clients treat `user.id`/`user.userId` as the stable key.
- [ ] UIs handle users without email gracefully (no crashes, clear messaging).

Once all phases are complete, MentraOS will have a stable, opaque user identity (`userId`) and a flexible identifier system that can grow with new auth providers and contact methods without further schema upheaval.
