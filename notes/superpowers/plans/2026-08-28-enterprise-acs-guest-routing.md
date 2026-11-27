---
status: draft
owner: nicolo
name: enterprise policy + ACS guest routing
overview: 'Execute the enterprise-controlled guest ACS routing spec. Server-owned meeting policy (Mentra-admin-only ACS enablement), tenant-first wearer binding plus enrollment/revocation, host resolve-then-join, MEETING_* gating. No Entra/MSAL identity in this slice.'
todos:
  - id: server-policy
    content: Add meetingPolicy on enterprise_orgs; Mentra-admin GET/PUT; portal GET read-only; audit ACS writes. Ship-blocker if portal can enable ACS.
    status: pending
  - id: server-membership
    content: Memberships, high-entropy enrollment codes, tenant-first resolve, member list/revoke, conflict policy, CAS/idempotent redeem, rate-limited enroll.
    status: pending
  - id: server-client-api
    content: GET /api/client/meeting-policy and POST enroll under userAuth; public DTO has no Entra fields.
    status: pending
  - id: cloud-client
    content: Add @mentra/cloud-client meetingPolicy.get/enroll on Core.
    status: pending
  - id: mobile-classifier-cache
    content: classifyMeetingUrl plus cache with fresh-ok / expired-fail-Recall / enroll-replaces-cache.
    status: pending
  - id: mobile-resolve-join
    content: MEETING_RESOLVE then ACS join; join() keeps required token; personal Teams → recall; host refuses ACS join unless plan says acs-teams.
    status: pending
  - id: meeting-gating
    content: Gate MEETING_* with MEETING_CAPABLE_PACKAGES (com.mentra.call only).
    status: pending
  - id: sdk-cleanup
    content: Add MeetingModule.resolve; do not make join token optional; host plan wins over miniapp provider.
    status: pending
  - id: portal-admin-ui
    content: Portal Meetings (read-only policy, codes, members). Admin console ACS enablement form.
    status: pending
  - id: tests
    content: Cloud Core integration tests plus engine classifier/resolver/cache tests and miniapp resolve/join tests.
    status: pending
---

# Enterprise policy + ACS guest routing — implementation plan

> Execution checklist. Update checkboxes as work lands. Open in Plan mode with
> `@notes/superpowers/plans/2026-08-28-enterprise-acs-guest-routing.md`.

**Goal:** Mentra Call asks the host `resolve({ meetingUrl })` before minting an
ACS guest token. Commercial Teams URLs use native ACS only when a Mentra admin
has set that wearer’s enterprise org to `teamsProvider: "acs-teams"`. Everyone
else, Zoom/Meet, and personal Teams go to Recall.

**Architecture:** Cloud Core stores policy on `enterprise_orgs` and binds
wearers tenant-first (corporate `tenantId`) or via enrollment (Mentra App
users). The Mentra App caches a public policy DTO, classifies the URL, and
returns a join plan. Mentra Call mints a guest token only on the ACS plan, then
calls the existing ACS `join`. Entra/MSAL Teams-user identity is out of scope.

**Tech stack:** Cloud Core (Hono, Mongoose, `adminAuth` / `userAuth` /
portal console session), `@mentra/cloud-client`, Mentra App engine,
`@mentra/miniapp` meeting module, enterprise portal, admin console.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-28-enterprise-acs-guest-routing-design.md`

**Ticket:** [OS-1922](https://linear.app/mentralabs/issue/OS-1922/add-phone-native-acs-client-for-direct-mentra-call-teams-meetings)
(identity/policy layer only; media plane is separate).

Do not implement until this plan is approved. This file is the execution
checklist, not a license to start coding.

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `cloud-v2/packages/core/src/models/enterprise-org.model.ts` | Modify | Nested `meetingPolicy` |
| `cloud-v2/packages/core/src/models/enterprise-org-membership.model.ts` | Create | Wearer enrollment roster |
| `cloud-v2/packages/core/src/models/enterprise-enrollment-code.model.ts` | Create | Hashed high-entropy codes |
| `cloud-v2/packages/core/src/services/enterprise/enterprise.service.ts` | Modify | Policy read for portal; no customer ACS write |
| `cloud-v2/packages/core/src/services/enterprise/enterprise-membership.service.ts` | Create | Enroll CAS, resolveOrgForUser, list/revoke |
| `cloud-v2/packages/core/src/services/meeting-policy.service.ts` | Create | Public client DTO |
| `cloud-v2/packages/core/src/api/portal/enterprise.api.ts` | Modify | Read policy; codes; members |
| `cloud-v2/packages/core/src/api/admin/enterprise-meeting-policy.api.ts` | Create | Mentra-admin list orgs + GET/PUT policy |
| `cloud-v2/packages/core/src/api/admin/preinstalled.api.ts` | Modify | `app.route("/enterprise-orgs", ...)` behind existing `adminAuth` |
| `cloud-v2/packages/core/src/api/client/meeting-policy.api.ts` | Create | GET policy, POST enroll (rate-limited) |
| `cloud-v2/packages/core/src/api/app.ts` | Modify | Mount `/api/client/meeting-policy` |
| `cloud-v2/packages/core/src/migrations/startup.migrations.ts` | Modify | `createIndexes` for new models |
| `cloud-v2/packages/cloud-client/src/modules/core/meeting-policy.ts` | Create | Typed `get` / `enroll` |
| `cloud-v2/packages/cloud-client/src/modules/core/core.ts` | Modify | Expose `core.meetingPolicy` |
| `mobile/modules/engine/src/services/meeting/classifyMeetingUrl.ts` | Create | URL classifier |
| `mobile/modules/engine/src/services/MeetingPolicyService.ts` | Create | Fetch + MMKV cache |
| `mobile/modules/engine/src/services/meeting/MeetingAccountResolver.ts` | Create | Join plan |
| `mobile/modules/engine/src/services/LocalMiniappRuntime.ts` | Modify | `MEETING_RESOLVE`, gating, join re-checks plan |
| `mobile/modules/miniapp/src/protocol.ts` | Modify | `MEETING_RESOLVE` |
| `mobile/modules/miniapp/src/modules/meeting.ts` | Modify | `resolve()`; `join` token stays required |
| `cloud-v2/websites/portal/src/App.tsx` | Modify | Meetings page: read-only provider, codes, members |
| `cloud-v2/websites/admin/src/App.tsx` | Modify | Enterprise ACS enablement page |
| `cloud-v2/tests/meeting-policy.integration.test.ts` | Create | HTTP tests |
| Mentra Call miniapp (external repo, later) | Modify | Call `resolve` before minting a guest token |

---

## Conventions

- `enterprise_orgs.tenantId` stays the Mentra slug (`acme`). Microsoft GUIDs
  are `entraTenantId` if stored.
- No ACS connection string or Entra client secret on `enterprise_orgs` or the
  phone.
- Client policy DTO is `{ orgId, binding, teamsProvider }` only.
- Enrollment secrets are ≥128-bit random, shown once, SHA-256 at rest.
- ACS enablement writes are Mentra-admin-only. Portal PUT of `teamsProvider` is
  a ship blocker.
- Do not add `com.mentra.call` to `SYSTEM_MINIAPP_PACKAGES`.
- Do not make `MeetingModule.join` token optional.
- Cloud Core has no Mongo transaction usage today; CAS + unique indexes are the
  redemption design. Do not increment `useCount` then best-effort rollback.

---

## Phase 1: Enterprise-org meeting policy

### Task 1: Schema

**Files:** `enterprise-org.model.ts`

- [ ] Add nested `meetingPolicy` with `teamsProvider` enum `recall` \|
      `acs-teams`, default `recall`.
- [ ] Add optional `teamsEnterpriseProfile` (`entraTenantId`, `clientId`,
      `authority`, `tokenExchangeEndpoint`) plus `updatedBy`.
- [ ] Do **not** require the Entra subdocument to set `acs-teams`.

### Task 2: Mentra-admin write path (ship blocker)

**Files:** `enterprise-meeting-policy.api.ts`, `preinstalled.api.ts`,
`enterprise.service.ts`

- [ ] `GET /api/admin/enterprise-orgs`
- [ ] `GET /api/admin/enterprise-orgs/:enterpriseOrgId/meeting-policy`
- [ ] `PUT /api/admin/enterprise-orgs/:enterpriseOrgId/meeting-policy`
- [ ] Mount the router with `app.route("/enterprise-orgs", ...)` on the existing
      admin app so `adminAuth` applies.
- [ ] Validate Entra fields only when present (GUID / https). All may be omitted.
- [ ] Write `AdminActionAuditLogModel` on PUT.
- [ ] Portal `PUT` for `teamsProvider` / Entra fields must not exist. Add a test
      that a portal session cannot change provider (404 or 403).

### Task 3: Portal read

**Files:** `enterprise.api.ts`

- [ ] `GET /api/portal/meeting-policy` returns current `teamsProvider` for the
      caller’s org.
- [ ] No portal write handler for policy.

---

## Phase 2: Membership + enrollment + member revocation

### Task 1: Models and indexes

**Files:** new membership/code models, `startup.migrations.ts`

- [ ] `enterprise_org_memberships` with partial unique `{ mentraUserId }` where
      `status: "active"`, plus unique `(enterpriseOrgId, mentraUserId)`.
- [ ] `enterprise_enrollment_codes` with unique `codeHash`, `maxUses`,
      `useCount`, `redeemedBy[]`, `expiresAt`, `status`.
- [ ] `createIndexes()` on startup.

### Task 2: `resolveOrgForUser` (tenant-first)

**Files:** `enterprise-membership.service.ts`

- [ ] `tenantId != "mentra"` → active org by that slug; ignore memberships.
- [ ] `tenantId == "mentra"` → active membership → that org if active.
- [ ] Else public / no org.
- [ ] Disabled org → no org (Recall).

### Task 3: Enrollment codes

**Files:** membership service, `enterprise.api.ts`

- [ ] `POST /api/portal/enrollment-codes` generates `crypto.randomBytes(16)`
      base64url, stores SHA-256, returns raw code **once**.
- [ ] `GET /api/portal/enrollment-codes` lists metadata (never the secret).
- [ ] `DELETE /api/portal/enrollment-codes/:id` revokes the code only (does not
      unenroll redeemers).

### Task 4: Member list and revoke

**Files:** membership service, `enterprise.api.ts`

- [ ] `GET /api/portal/members` — enrollment roster only, not trusted-issuer
      users inferred from `tenantId`.
- [ ] `DELETE /api/portal/members/:mentraUserId` sets membership `revoked`.
- [ ] After revoke, that wearer is public until they enroll again.

### Task 5: Redeem (CAS, idempotent)

**Files:** membership service, client API (phase 3)

- [ ] Implement the spec algorithm: corporate reject; same-org idempotent
      success without `$inc`; other-org `409 membership_conflict`; CAS
      `findOneAndUpdate` with `useCount < maxUses` and `redeemedBy $ne user`
      **before** insert.
- [ ] Do not increment-then-rollback.
- [ ] Unique-index races: re-read; same org success, other org conflict.

---

## Phase 3: Policy / enrollment client APIs

### Task 1: Device routes

**Files:** `meeting-policy.api.ts`, `app.ts`, rate-limit helper

- [ ] `GET /api/client/meeting-policy` (`userAuth`) returns public DTO.
- [ ] Unbound user → `{ orgId: null, binding: "none", teamsProvider: "recall" }`.
- [ ] `POST /api/client/meeting-policy/enroll` `{ code }`.
- [ ] Rate-limit enroll (IP + `mentraUserId`), `429 rate_limited`.
- [ ] Enroll 200 body is the new policy DTO (phone replaces cache).
- [ ] Entra fields never appear on this surface.

### Task 2: cloud-client

**Files:** `meeting-policy.ts`, `core.ts`, tests

- [ ] `MeetingPolicy` class with `get()` / `enroll(code)` like `SupportProfiles`.
- [ ] Wire `cloud.core.meetingPolicy`.
- [ ] Engine passthrough `cloudClientService.core.meetingPolicy`.

---

## Phase 4: Policy cache + URL classifier + resolver

### Task 1: Classifier

**Files:** `classifyMeetingUrl.ts` + unit tests

- [ ] `teams-commercial` / `teams-personal` / `zoom` / `meet` / `unknown`.
- [ ] `teams.live.com` is personal, not an error.

### Task 2: Cache

**Files:** `MeetingPolicyService.ts`

- [ ] MMKV cache, 15-minute TTL.
- [ ] Fresh → use. Expired + success → store. Expired + fail → Recall, do not
      keep ACS. No cache + fail → Recall.
- [ ] Enroll response replaces cache immediately.
- [ ] Fetch after login.

### Task 3: Resolver

**Files:** `MeetingAccountResolver.ts`

- [ ] Routing table from the spec, including personal Teams → `recall`.
- [ ] `identity: "acs-guest"` only when provider is `acs-teams`.

---

## Phase 5: Explicit resolve → token mint → join

### Task 1: Protocol + runtime

**Files:** `protocol.ts`, `LocalMiniappRuntime.ts`, `meeting.ts`

- [ ] Add `MEETING_RESOLVE` / `miniapp_meeting_resolve`.
- [ ] `MeetingModule.resolve({ meetingUrl })` → `MeetingJoinPlan`.
- [ ] `join()` still requires `token` and `provider: "acs-teams"`.
- [ ] `handleMeetingJoin` re-resolves (or uses current plan) and **refuses** ACS
      join unless provider is `acs-teams`. No Recall fallback inside this
      handler.
- [ ] Miniapp `provider` field is not authoritative.

### Task 2: Mentra Call (external, can lag the host PR)

- [ ] Call `resolve` first; mint guest token only on `acs-teams`; else existing
      Recall path.

---

## Phase 6: `MEETING_*` permission gating

**Files:** `LocalMiniappRuntime.ts`

- [ ] `MEETING_CAPABLE_PACKAGES = new Set(["com.mentra.call"])`.
- [ ] Gate resolve, join, leave, mute, update video, get state.
- [ ] Others → `NOT_PERMITTED`.
- [ ] Do not add `com.mentra.call` to `SYSTEM_MINIAPP_PACKAGES`.

---

## Phase 7: SDK cleanup

**Files:** `mobile/modules/miniapp/src/modules/meeting.ts` + tests

- [ ] Export `MeetingJoinPlan` / `MeetingResolveOptions`.
- [ ] Keep join token required.
- [ ] Map `NOT_PERMITTED` / `NOT_IMPLEMENTED` as today.

---

## Phase 8: Portal + admin UI

### Task 1: Portal Meetings page

**Files:** `cloud-v2/websites/portal/src/App.tsx`

- [ ] Nav item. Read-only provider badge.
- [ ] Create code (show secret once), revoke codes.
- [ ] Member table + revoke.
- [ ] Copy: this routes wearers to **guest ACS**, not “join as a Teams user.”

### Task 2: Admin ACS enablement

**Files:** `cloud-v2/websites/admin/src/App.tsx`

- [ ] Nav item. Org picker. Toggle `recall` / `acs-teams`.
- [ ] Optional Entra fields with helper text: stored for a later identity
      ticket, unused by guest routing.
- [ ] This is the only UI that can enable ACS.

---

## Phase 9 (later, not this PR): Entra/MSAL authenticated enterprise identity

Then require a complete profile, consume `tokenExchangeEndpoint`, MSAL
work/school check, `identity: "teams-user"`. Guest remains fallback.

---

## Tests

Run: `bun test` in `cloud-v2/`; `mobile/modules/engine/scripts/test.sh`;
`bun test` in `mobile/modules/miniapp/`.

### Cloud Core

- [ ] Public user → recall DTO.
- [ ] `tenantId=acme` + Contoso membership row → Acme.
- [ ] Mentra user + enroll → that org’s provider; enroll body replaces policy.
- [ ] Second org code → `409 membership_conflict`.
- [ ] Same code twice → 200, `useCount` unchanged on second call.
- [ ] Member DELETE → subsequent GET is recall.
- [ ] Disabled org → recall.
- [ ] Exhausted / expired / revoked code → error, no membership.
- [ ] Enroll rate limit → 429.
- [ ] Portal cannot PUT `teamsProvider`.
- [ ] Admin PUT `acs-teams` without Entra profile succeeds.
- [ ] Client GET never includes Entra fields.

### Engine

- [ ] URL table including `teams.live.com` → recall plan.
- [ ] Cache expired + fail → recall, not stale ACS.
- [ ] Enroll invalidates/replaces cache.
- [ ] Non-`com.mentra.call` → `NOT_PERMITTED`.
- [ ] `handleMeetingJoin` with a Recall-plan URL → reject, no ACS join.

### Miniapp SDK

- [ ] `resolve` payload / response shapes.
- [ ] `join` still requires token.

---

## Risks (remaining)

- ACS raw media is Microsoft public preview / no SLA. Unchanged; media plane
  is not this slice.
- Enrollment codes are bearer secrets: high entropy, hash, cap, expiry, rate
  limit, revoke memberships separately from codes.
- **Policy mutation is a ship blocker, not a residual risk.** ACS enablement
  must stay Mentra-admin-only before this ships.
- Mentra Call’s guest-token mint is still miniapp-owned. This slice makes
  provider selection coherent; credential ownership is a follow-up.
