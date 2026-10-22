---
status: active
owner: nicolo
last_verified: 2026-10-22
covers:
  - cloud-v2/packages/protocol/src/fleet.ts
  - cloud-v2/packages/workspace-contract/src/**
  - cloud-v2/packages/core/src/api/fleet/**
  - cloud-v2/packages/core/src/api/client/**
  - cloud-v2/packages/cloud-client/src/**
  - mobile/modules/engine/src/services/fleet/**
---

# Fleet Phase 11 (Fleet Management in Mentra Portal): context brief

Read this first for any Phase 11 question (OS-2110). It is a map and a pitfalls log, not a spec.
When it disagrees with a source of truth below, the source of truth wins; then fix this file.

## Sources of truth, in order

1. Mentra-Specs `platform/enterprise/mentra-fleet-management/spec.md` (Phase 11 criteria 2-4, 7, 9, 10,
   15-22, 26, 27), `managed-miniapp-provisioning/spec.md`, `cloud/core/workspaces/{spec,plan}.md`.
2. Sign-in plan Tasks 21-23 (`cloud/auth/web-login/plan.md`): Core portal forwarding, FleetUi contract,
   Store eligibility.
3. Design board `Mentra-Community/fleet-design-board` round 2 (`src/r2/*`, `UPDATE-2026-10-20.md`). The
   update note overrides older drawings.
4. The plan: `~/.cursor/plans/fleet_phase_11_plan_*.plan.md` (not committed; ownership map W0-W17,
   checkpoints A-H, walkthroughs, operational owners O1-O6).
5. Code: Core `cloud-v2/packages/core/src/api/fleet/fleet-forwarding.ts`; protocol
   `cloud-v2/packages/protocol/src/fleet.ts`; MFM is `fleet/` in `Mentra-Community/miniapp-store` (`dev`).

## Model

- Membership is management. A member of a workspace is managed from the moment they join. No acknowledgment
  step gates installs; the Fleet notice only informs.
- Desired state: `managed` (workspace + entries, entries may be empty) or `unmanaged`. `paused` is Phase 15
  and is not in this schema. One monotonic `revision` per account. Error, timeout, partial read or missing MFM
  is never an empty set: MFM answers 503 and the phone keeps its last complete snapshot.
- MFM scopes queries by its own copy of membership intervals (from the Core change feed plus a bootstrap read
  bounded by `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`, deployed at least 120). Records are never re-stamped.
- A query is answered only when intervals are current (catch-up to Core head, or within
  `FLEET_INTERVAL_MAX_STALENESS`); otherwise 503.
- Core signs workspace scope from the URL only: `/api/portal/fleet/workspaces/:id/*` to MFM
  `/v1/portal/workspaces/:id/*`. Organization Admins act as Owner. Fleet is not a `PORTAL_MODULE_NAMES` entry.
- One workspace per person. Cosmos RU rejects cross-collection transactions, so the guard must live in the
  memberships collection (W1 spike decides). No unique index on a populated Core collection.
- Phone: installation reasons (`bundled`, `explicit`, `manifest`, `assignment`) are stored apart from artifact
  provenance (`MiniappReleaseIdentity.source`). Withdrawal keeps data. Private data and development selections
  partition by account/Core and workspace.

## Entry points

- New protocol record kinds / ack revision / desired state -> `cloud-v2/packages/protocol/src/fleet.ts`
- Phone Fleet reporter -> `mobile/modules/engine/src/services/fleet/FleetReporter.ts`
- Portal workspace sections -> `cloud-v2/websites/portal/src/lib/routes.ts`, `pages/workspace.tsx`
- Leave / last-Owner -> `cloud-v2/packages/core/src/services/workspaces/workspace.service.ts` (`leaveWorkspace`)

## Engineering choices recorded (Nicolo's; bounded, no sign-off needed)

1. Latest versions: newest reported in the last 30 days per platform and per glasses model.
2. Mentra Live "Glasses software" is the ASG client APK version; More lists BES and MTK firmware.
3. Phone page is built (Status, Battery, Mentra App; More: OS, app version, assigned miniapp status).
4. Last-Owner copy: "You're this workspace's only Owner. Hand over ownership or delete the workspace in Mentra Portal first."
5. Failure words (reasons per Mentra-Specs #140; desired-state entries carry the miniapp `url`): storage_full
   "Not enough space"; archived "No longer available"; access_denied "No access to this miniapp"; not_a_miniapp
   "Not a miniapp"; download_failed
   "Download failed"; signature_invalid "Signature check failed"; incompatible_host "Needs a newer Mentra App";
   newer_version_installed "A newer version is installed"; manifest_conflict "Set by your organization".
6. Invitation sheet is not swipeable (deviates from the board; Decline is irreversible). Flag in the PR.
7. Update prompt buttons stack, main action on top (`UPDATE-2026-10-20.md`).
8. Overview cache: rolling-window parts only, keyed by workspace + last complete bucket + interval revision,
   15 minute TTL; "Connected now" and battery are live.
9. Usage tab deferred to Phase 12; `GET usage` API ships.
10. Undrawn copy: skeleton loading, "Something went wrong. Try again.", empty search "No results for "<query>"".

## Pitfalls log

1. Local MentraOS checkout was 125 commits behind `origin/dev`; read `origin/dev` or work in a worktree.
2. `/w/<id>` redirects to the first section and drops the query; Fleet URL is `/w/<id>/fleet?fleet=<path>`.
3. `membership.replaced` is emitted only by `scripts/migrate-store-developer-orgs.ts` (close plus open).
4. Round-1/2 review: an `unmanaged` answer on a failed Core membership check is wrong; it is 503.
5. Automatic update path in `miniappReleaseInstall.ts` calls `assertStillInstalled`, so it cannot first-install.
6. One-workspace guard = raw doc in `workspace_memberships` (`membership-guard.service.ts`, `_id: ows:<userId>`). It
   carries none of `workspaceId`/`mentraUserId`/`status`/`role`, so no membership query matches it. A duplicate-key
   error inside a transaction aborts it, so non-throwing paths (claim) pre-check with `canJoinWorkspace`.
   A guard counts only while the membership it names is still the person's active one: `initializeGuards` and the
   cleanup script write from earlier reads, so a stale guard must refuse nobody (the next join replaces it). Never
   test a guard with a membership id that has no row.
   The cleanup script writes the retained membership's row before every removal (`pinRetainedMembership`) so a
   concurrent leave of it conflicts instead of leaving the person with none; the portal turns a 401 from `/me` into
   `sessionExpired` (`PortalApiError.status`), not "Fleet unavailable".
7. Claim of imported memberships now skips a pending row when the person is in another workspace (stays pending,
   retried at later sign-ins). A person with several imported orgs gets the highest role claimed first.
8. Tests that need one person in several workspaces must write the extra membership directly (legacy state); the
   services refuse it. Create the guarded one through `createWorkspace` first.
9. CLI `workspace list`/`use` are gone; ship the CLI only after `scripts/one-workspace-cleanup.ts` has run, or
   legacy multi-workspace accounts are locked out of the CLI.
10. `/api/portal/fleet` accepts the portal session cookie only (`via === "session"`); a bearer is 403 even if valid.
11. Portal Fleet host: `cloud-v2/websites/portal/src/pages/fleet.tsx` (`/w/<id>/fleet?fleet=<path>`, apiBase
    `/api/portal/fleet/workspaces/<id>`, `/me?workspaceId=` gives an Org Admin exactly that workspace). `PortalMe` fields
    are optional: a Core that predates them reads as "Fleet not installed". `queryFn` must not be passed `fetchPortalMe`
    directly (react-query hands it a context object).
12. Portal `public/_headers` CSP is new and unverified in a browser; check sign-in, billing and Fleet load under it.
13. Admin Workspaces link needs build-time `PORTAL_URL` (set by `scripts/deploy-pages.ts`, public, not a Doppler key).
14. Portal Decline is `POST /api/{portal/,}workspaces/invitations/decline` (shared handler); the Mentra App uses
    `/api/client/workspaces/invitations/:id/decline`. Both call `declineInvitation`.
15. The Fleet UI module is `fleet/ui/` in miniapp-store (stacked PR #66 on #65): built to `fleet/ui/dist`, served by MFM
    at `/v1/portal/ui/*`. The portal title is the Fleet item (`fleetNavItem`, first `?fleet=` segment, no description);
    the module draws its own page headings. `useSearch()` is "" in server-rendered tests, so test titles via `fleetNavItem`.

## Open items

- Dates: OS-2099 includes Phase 12; Oct 30 / Nov 11 / Nov 19 are meeting evidence, not checked commitments.
- Cosmos boundary for the one-workspace guard (design is Cosmos-safe on paper; spike on Cosmos staging NOT run); named owners O1-O6; harness host readiness is uninspected.

## Tests and verification

- Guard/cleanup: `tests/one-workspace-{guard,cleanup}.integration.test.ts`. Protocol: `cd cloud-v2/packages/protocol && bun test`. Core: `cd cloud-v2 && bun run test`.
- Device evidence follows the plan's checkpoint gate; none exists yet.
