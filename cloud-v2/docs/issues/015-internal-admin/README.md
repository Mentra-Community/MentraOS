# 015 - Internal Admin Site and Admin CLI

**Status:** First admin site, release review queue, incident viewer, and mutation
audit log are implemented locally. Admin CLI and durable role mapping are still
draft.

## Problem

Cloud v2 needs an internal admin surface for Mentra operators. This should not
live in Console2, because Console2 is developer-facing. It should also not live
inside the enterprise portal, because portal users are external customer admins.

Internal admin replaces the old dev console's review and incident workflows.

## Product Boundary

```txt
admin.mentraglass.com
admin.dev.mentraglass.com
admin.staging.mentraglass.com
```

CLI:

```txt
mentra admin ...
```

or, if we want a separate package later:

```txt
@mentra/admin-cli
```

Initial preference: keep one `mentra` binary and gate admin commands by admin
auth/roles.

## Auth Direction

Use WorkOS for internal admin auth, but do not rely only on email domain for the
final system.

Current first slice:

- Reuses the Console2 WorkOS sealed session cookie.
- Allows explicit `CLOUD_CORE_ADMIN_EMAILS`.
- Allows domains from `CLOUD_CORE_ADMIN_EMAIL_DOMAINS`, defaulting to
  `mentraglass.com` for local internal builds.
- Sets `c.var.developer` from the signed-in WorkOS user and uses that identity
  in release decisions, registry revision metadata, and audit entries.

This intentionally avoids `CLOUD_CORE_ADMIN_TOKEN` for browser admin usage.
Role-based auth remains required before production admin launch.

Requirements:

- User must belong to a Mentra internal WorkOS org.
- User should usually have an `@mentraglass.com` email.
- User must have explicit admin role(s).
- Every mutation writes an audit log entry.

```ts
interface AdminPrincipal {
  identityUserId: string
  workosUserId: string
  roles: AdminRole[]
}

type AdminRole =
  | "admin_owner"
  | "app_reviewer"
  | "incident_responder"
  | "support_viewer"
```

## Data Models

```ts
interface AdminActionAuditLog {
  id: string
  adminUserId: string
  roleUsed: AdminRole
  action: string
  targetType: string
  targetId: string
  reason?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

interface ReviewQueueItem {
  id: string
  submissionId: string
  packageId: string
  bundleId: string
  status: "queued" | "in_review" | "approved" | "rejected" | "changes_requested"
  assignedAdminUserId?: string
  decisionReason?: string
  createdAt: string
  updatedAt: string
}

interface IncidentReport {
  id: string
  reporterUserId?: string
  packageId?: string
  bundleId?: string
  mobileUserId?: string
  deviceId?: string
  runtimeSessionId?: string
  status: "open" | "triaged" | "resolved" | "closed"
  severity: "low" | "medium" | "high" | "critical"
  summary: string
  createdAt: string
  updatedAt: string
}

interface IncidentTimelineEvent {
  id: string
  incidentId: string
  adminUserId?: string
  type: "comment" | "status_change" | "log_snapshot" | "linked_entity" | "resolution"
  body?: string
  metadata?: Record<string, unknown>
  createdAt: string
}
```

Review data references the release models in `011-miniapp-registry`.

## Admin Site Screens

1. Dashboard. Next.
2. Review queue. Implemented as a queue/table with approve, reject, publish.
3. Submission detail. Next; first slice uses inline row actions.
4. Package/bundle inspector. Next.
5. Incident list. Implemented.
6. Incident detail. Implemented.
7. User/device/session lookup. Next.
8. Enterprise/org/issuer lookup. Next.
9. Audit log. Implemented.

## Admin CLI Commands

Initial commands should cover emergency and release operations:

```txt
mentra admin whoami
mentra admin submissions list
mentra admin submissions approve <submissionId>
mentra admin submissions reject <submissionId>
mentra admin incidents list
mentra admin incidents show <incidentId>
mentra admin issuers disable <trustedIssuerId> --reason "..."
```

Admin CLI must call the same Cloud Core admin APIs as admin site and produce the
same audit logs.

## User Stories

1. An app reviewer approves a submitted bundle.
2. An app reviewer requests changes with notes visible to the developer in
   Console2.
3. An incident responder opens a report, sees linked logs/session/user/package,
   and adds timeline notes.
4. A support viewer can inspect incidents but cannot mutate package state.
5. An admin disables a compromised trusted issuer.
6. Every admin mutation is visible in the audit log.

## API Shape

```txt
GET  /api/admin/me
GET  /api/admin/submissions
POST /api/admin/submissions/:releaseId/approve
POST /api/admin/submissions/:releaseId/reject
POST /api/admin/submissions/:releaseId/publish
GET  /api/admin/incidents
GET  /api/admin/incidents/:id
POST /api/admin/incidents/:id/events
GET  /api/admin/audit-log
```

The release, report proxy, support-profile proxy, and audit routes are
implemented.

## Faults To Test

| Fault | Expected behavior |
| --- | --- |
| `@mentraglass.com` user without role | Login allowed only if desired; admin APIs forbidden |
| Admin role revoked | Existing session loses mutation permission after refresh/check |
| Duplicate approval click | Idempotent decision or clear conflict |
| Admin CLI mutation | Same auth, authorization, and audit log as admin site |
| Incident log source unavailable | Incident page still opens with partial data |

## Verification

Current local checks:

```txt
bun test tests/miniapp-release-lifecycle.integration.test.ts
curl http://localhost:3000/api/admin/health
```

The integration test covers the release state transitions that power the admin
review queue. Local HTTP smoke checks verify admin health is public and protected
admin endpoints require a Mentra/WorkOS session.

## Open Decisions

- One `mentra` binary with admin namespace vs separate `@mentra/admin-cli`.
- Whether admin site shares frontend shell/components with Console2.
- Which old incident fields must be migrated exactly from cloud v1.
- Whether internal admin auth uses the same WorkOS project as Console2/Portal or
  a separate internal project.
- How fine-grained admin roles need to be for first release.
