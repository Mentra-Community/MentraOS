---
status: draft
owner: nicolo
---

# Enterprise policy + ACS guest routing

## Outcome

Ship **enterprise-controlled routing to guest ACS** for the single Mentra Call
miniapp. Cloud Core owns meeting policy. The Mentra App host classifies the
meeting URL and selects `acs-teams` or `recall`. Mentra Call mints an ACS guest
token only after the host says ACS.

This slice does **not** make an enterprise wearer join Teams as themselves.
MSAL, Entra work-account sign-in, and authenticated token exchange are a later
ticket. Stored Entra profile fields are inventory for that ticket, not inputs
to this resolver.

Replaces the temporary `TEAMS_PROVIDER` / `MENTRA_PUBLIC_TEAMS_PROVIDER` switch
for policy. Does not touch the ACS media plane (that is the rest of
[OS-1922](https://linear.app/mentralabs/issue/OS-1922/add-phone-native-acs-client-for-direct-mentra-call-teams-meetings)).

## Milestone name

**Enterprise policy + ACS guest routing**

Do not title this work “enterprise Microsoft identity” or “Teams-user join.”

## Review decisions (locked)

These replace the first draft. Do not revert them during implementation.

1. **Provider ownership is two-stage, not “optional token on join.”** The host
   exposes `session.meeting.resolve({ meetingUrl })`. Mentra Call mints a guest
   token only if `plan.provider === "acs-teams"`, then calls `join` with that
   token. `join()` stays ACS-only and still requires `token`. Do not make
   `token` optional on `join`. Token mint stays in Mentra Call’s backend until a
   later host-owned credential ticket.
2. **Wearer binding is tenant-first.** `tenantId != "mentra"` wins over any
   enrollment row. Enrollment only binds official Mentra App users
   (`tenantId === "mentra"`).
3. **Cache fails closed to Recall.** Fresh cache may be used. Expired cache is
   never used for ACS. Failed refresh or missing cache → Recall. Successful
   enroll replaces the cache immediately.
4. **Identity in this slice is always ACS guest.** `teamsEnterpriseProfile`
   is optional, unused at join time, and **not sent to the phone**. Enabling
   `acs-teams` does not require a complete Entra profile.
5. **Memberships are managed.** Portal can list and revoke wearers who enrolled.
   Revoking a QR/code does not unenroll people who already redeemed it.
6. **Enrollment redemption is idempotent, not increment-and-rollback.** Unique
   indexes plus compare-and-swap. High-entropy secrets, SHA-256 at rest,
   rate-limited redeem.
7. **Personal Teams is Recall routing, not an error.** `teams.live.com` →
   `recall`. Do not encode that as `MEETING_NOT_SUPPORTED`.
8. **Ship blocker: ACS enablement is Mentra-admin-only.** Portal cannot
   `PUT` `teamsProvider` or Entra fields. Enterprise org create is currently
   unapproved and always `active`; self-service ACS config must not ship.

## Current problem

Provider selection does not exist at runtime. Mentra Call currently supplies an
ACS guest token and the host forwards it
(`LocalMiniappRuntime.handleMeetingJoin`). `MEETING_*` has no package gate.
`enterprise_orgs` has no meeting policy and no wearer membership. Official
Mentra App users have `tenantId: "mentra"`, so tenant-only org lookup cannot
bind them to Acme. Corporate trusted-issuer users already have
`tenantId === enterprise_orgs.tenantId` (Mentra slug, not an Entra GUID).

## Non-goals

- ACS Calling SDK / WHEP / raw media (existing OS-1922 media work).
- MSAL, Entra sign-in, work vs personal Microsoft account detection.
- Host-owned ACS token minting (Porter / Core minting the ACS token).
- Separate public vs enterprise Mentra Call miniapps.
- Fleet / MDM ([OS-1469](https://linear.app/mentralabs/issue/OS-1469)).
- Putting ACS connection strings or Entra client secrets on `enterprise_orgs`
  or on the phone.
- Adding `com.mentra.call` to `SYSTEM_MINIAPP_PACKAGES`.

## Actors and data

| Actor | Binding | How they get ACS |
|---|---|---|
| Public Mentra App user | `tenantId === "mentra"`, no membership | Never (Recall) |
| Mentra App user who scanned an org QR | `tenantId === "mentra"` + active membership | If that org’s `teamsProvider` is `acs-teams` |
| Corporate trusted-issuer user | `tenantId === "acme"` (org slug) | If Acme’s `teamsProvider` is `acs-teams` |
| Same user with a Contoso enrollment row | tenant still `acme` | **Acme wins.** Enrollment is ignored |

`enterprise_orgs.tenantId` remains the Mentra customer slug. Microsoft GUIDs,
if stored, are `meetingPolicy.teamsEnterpriseProfile.entraTenantId` and are
unused here.

## Server model

### `enterprise_orgs.meetingPolicy`

```ts
meetingPolicy: {
  teamsProvider: "recall" | "acs-teams"  // default "recall"
  teamsEnterpriseProfile?: {
    entraTenantId?: string
    clientId?: string
    authority?: string
    tokenExchangeEndpoint?: string
  }
  updatedBy: string
  updatedAt: Date
}
```

- Enabling `acs-teams` does **not** require `teamsEnterpriseProfile`.
- Those Entra fields are admin-only storage for the later identity ticket.
  Guest routing does not read them. The device API does not return them.
- No ACS connection string, no client secret, no token-exchange credential.

### `enterprise_org_memberships`

Wearer enrollment roster. Not the corporate trusted-issuer population.

- Unique active membership per `mentraUserId` (partial unique index on
  `status: "active"`).
- Unique `(enterpriseOrgId, mentraUserId)`.
- `status: "active" | "revoked"`.
- `enrolledAt`, `enrolledVia: "code"`, `enrollmentCodeId`.

Trusted-issuer users do **not** need a membership row. Portal member list is
the enrollment roster only. You cannot “revoke” a corporate login here; that
user is bound by `users.tenantId` until their issuer stops authenticating them.

### `enterprise_enrollment_codes`

- Secret: `crypto.randomBytes(16)` encoded base64url (≥128 bits). **Not** a
  short human-readable PIN.
- Store `codeHash = sha256(utf8(code))` only. Return the raw code **once** on
  create.
- `maxUses`, `useCount`, `redeemedBy: mentraUserId[]`, `expiresAt`,
  `status: "active" | "revoked"`.

## Org resolution (tenant-first)

```txt
if user.tenantId != "mentra":
    org = EnterpriseOrg.findOne({ tenantId: user.tenantId, status: "active" })
else:
    org = active membership for user.mentraUserId, then that org if status "active"
otherwise:
    public user → teamsProvider "recall", orgId null
```

Disabled orgs resolve as public (Recall).

### Already in another org

- `tenantId != "mentra"`: `POST .../enroll` returns `409 corporate_tenant_bound`.
  Do not write a membership. Do not switch orgs.
- Mentra App user with an active membership for org A redeeming org B’s code:
  `409 membership_conflict`. Admin must `DELETE` the A membership first.
- Same user redeeming the same org’s code again: **200 idempotent success**.
  Do not increment `useCount` again.

## Policy mutation (ship blocker)

| Surface | GET policy | Enable ACS / write Entra fields | Codes + members |
|---|---|---|---|
| `/api/admin/...` + `adminAuth` | yes | **yes, only here** | n/a |
| `/api/portal/...` (customer) | yes, read-only | **403 forever in this slice** | yes |
| `/api/client/...` (device) | yes, public DTO only | no | enroll only |

`adminAuth` is `CLOUD_CORE_ADMIN_EMAILS` / domain allowlist
(`admin-auth.middleware.ts`). Reuse it. Mount a nested router on the existing
`/api/admin` app (same pattern as `/reports` and `/support-profiles` in
`preinstalled.api.ts`).

Do not ship portal self-service ACS enablement while `upsertPrimaryOrg` creates
`status: "active"` with no approval API.

## HTTP contracts

### Device (`userAuth`)

```txt
GET  /api/client/meeting-policy
POST /api/client/meeting-policy/enroll   { code }   rate-limited
```

GET response:

```ts
{
  orgId: string | null
  binding: "tenant" | "enrollment" | "none"
  teamsProvider: "recall" | "acs-teams"
}
```

No Entra fields. No org display secrets. Unbound users get
`{ orgId: null, binding: "none", teamsProvider: "recall" }`.

Enroll success returns the same DTO for the **new** org so the phone can
replace cache without a second GET.

Rate limit: fixed-window like `account/rate-limit.ts`, keyed by client IP and
`mentraUserId` (user is already authenticated). Suggested starting point:
10 attempts / 10 minutes / user. `429` + `rate_limited`.

### Portal (console session, not admin)

```txt
GET    /api/portal/meeting-policy
GET    /api/portal/enrollment-codes
POST   /api/portal/enrollment-codes          { maxUses, expiresAt? }
DELETE /api/portal/enrollment-codes/:id      revoke
GET    /api/portal/members
DELETE /api/portal/members/:mentraUserId     revoke membership
```

Portal GET meeting-policy may include `teamsProvider` for display. It must not
accept writes to `teamsProvider` or Entra fields.

Member DELETE sets membership `status: "revoked"`. Subsequent policy GET for
that wearer returns public Recall unless they enroll again.

### Mentra admin

```txt
GET /api/admin/enterprise-orgs
GET /api/admin/enterprise-orgs/:enterpriseOrgId/meeting-policy
PUT /api/admin/enterprise-orgs/:enterpriseOrgId/meeting-policy
    { teamsProvider, teamsEnterpriseProfile? }
```

PUT is audited (`AdminActionAuditLogModel`, same as preinstalled promotes).
Validate GUIDs / https URLs if Entra fields are present; they may all be
omitted.

## Enrollment redemption (no increment-and-rollback)

Cloud Core does not currently use Mongo transactions. **Correctness must not
depend on them.** Local/dev Mongo may be standalone.

Algorithm:

1. Reject if `user.tenantId != "mentra"` (`corporate_tenant_bound`).
2. Hash the presented code. Load active, unexpired code by `codeHash`.
3. If this `mentraUserId` already has an active membership for **this** org:
   return success (idempotent). Do not `$inc` `useCount`.
4. If they have an active membership for **another** org: `409 membership_conflict`.
5. CAS-consume the code only for a **new** redeemer:

   ```ts
   findOneAndUpdate(
     {
       _id: codeId,
       status: "active",
       expiresAt: { $gt: now },
       useCount: { $lt: maxUses },
       redeemedBy: { $ne: mentraUserId },
     },
     {
       $inc: { useCount: 1 },
       $addToSet: { redeemedBy: mentraUserId },
     },
   )
   ```

   If this returns null: code invalid, expired, revoked, or exhausted → error.
   Do not insert a membership.
6. Insert the membership. Unique indexes make a concurrent double-redeem of the
   same user collapse: duplicate key → re-read; same org is success, other org
   is conflict.
7. If membership insert fails for a reason other than this user’s unique
   constraint, **do not** invent a compensating `useCount--`. Leave the CAS
   record in `redeemedBy`; a retry hits step 3 or the `$ne` guard.

Optional later wrap of steps 5–6 in a replica-set transaction is extra safety,
not the source of truth.

## Host resolver

### URL classifier

```ts
type MeetingKind = "teams-commercial" | "teams-personal" | "zoom" | "meet" | "unknown"
```

- `teams.microsoft.com/l/meetup-join/...` and `teams.microsoft.com/meet/...`
  → `teams-commercial`
- `teams.live.com/meet/...` → `teams-personal`

### Policy cache

TTL 15 minutes. Fetch on login, on TTL expiry, and from enroll response.

```txt
fresh cache                            → use it
expired/missing + GET succeeds         → store and use
expired + GET fails                    → Recall (discard ACS; do not use stale)
no cache + GET fails                   → Recall
successful enroll                      → replace cache with enroll DTO
```

Stale `acs-teams` must never survive a failed refresh.

### Join plan

```ts
interface MeetingJoinPlan {
  provider: "recall" | "acs-teams"
  meetingKind: MeetingKind
  identity: "acs-guest" | null  // "acs-guest" iff provider is acs-teams
  reason: string
}
```

| Meeting kind | Org policy | Result |
|---|---|---|
| zoom / meet / unknown | any | `recall` |
| teams-personal | any | `recall` (routing, not an error) |
| teams-commercial | `acs-teams` | `acs-teams` + `identity: "acs-guest"` |
| teams-commercial | missing / `recall` / fetch failed | `recall` |

If a future day Recall cannot join a given URL, that is a Recall-path error
**after** routing. The resolver does not return `MEETING_NOT_SUPPORTED` for
personal Teams.

`identity` is always `"acs-guest"` on the ACS path in this milestone. Do not
add `"teams-user"` until Entra/MSAL lands.

## Miniapp contract (resolve then join)

```ts
const plan = await session.meeting.resolve({ meetingUrl })

if (plan.provider === "acs-teams") {
  const token = await getGuestToken() // Mentra Call backend, unchanged
  await session.meeting.join({
    provider: "acs-teams",
    meetingUrl,
    videoSource: { type: "whep", url: whepUrl },
    token,
  })
} else {
  joinWithRecall() // existing Mentra Call Recall path; not MEETING_JOIN
}
```

- New request: `MEETING_RESOLVE` / `miniapp_meeting_resolve`.
- `MeetingModule.join` keeps requiring `token` and `provider: "acs-teams"`.
  It is the ACS join API, not a provider switch.
- Host `handleMeetingJoin` re-checks the plan for that URL and refuses ACS join
  unless `provider === "acs-teams"`. It does **not** fall back to Recall.
  Recall never goes through `handleMeetingJoin`.
- Miniapp-supplied `provider` is not authoritative.

This is host-driven **provider** selection. It is not host-driven **credential**
ownership. OS-1922 still wants the miniapp not to see ACS tokens long-term;
that is out of this slice.

## `MEETING_*` gating

New allowlist `MEETING_CAPABLE_PACKAGES = {"com.mentra.call"}`. Apply to
resolve, join, leave, mute, update video, get state. Others get `NOT_PERMITTED`.

Do not add `com.mentra.call` to `SYSTEM_MINIAPP_PACKAGES` (camera/gallery/
settings/…). Meeting capability is not system-miniapp privilege.

## UI

**Enterprise portal:** read-only `teamsProvider`; create/revoke enrollment
codes (raw secret once); list/revoke enrolled members.

**Mentra admin console:** pick an enterprise org, set `teamsProvider`,
optionally store Entra profile fields. This is the only ACS enablement UI.

## Later ticket (not this slice)

Require complete `teamsEnterpriseProfile`, send a non-secret profile to the
phone, MSAL work/school check, `identity: "teams-user"`, host or Porter mint
via `tokenExchangeEndpoint`. Guest remains fallback when unsigned-in.

Until that ticket: naming in code comments and portal copy must say **guest
ACS routing**, not **join as a Teams user**.
