---
status: active
owner: nicolo
last_verified: 2026-10-23
covers:
  - cloud-v2/packages/protocol/src/fleet.ts
  - cloud-v2/packages/workspace-contract/src/**
  - cloud-v2/packages/core/src/api/fleet/**
  - cloud-v2/packages/core/src/api/client/**
  - cloud-v2/packages/cloud-client/src/**
  - mobile/modules/engine/src/services/fleet/**
---

# Fleet Phase 11 (Fleet Management in Mentra Portal): context brief

Read first for any Phase 11 question (OS-2110). A map and pitfalls log, not a spec; the sources below win over this file.

## Sources of truth, in order

1. Mentra-Specs `platform/enterprise/mentra-fleet-management/spec.md` (Phase 11 criteria 2-4, 7, 9, 10, 15-22, 26, 27), `managed-miniapp-provisioning/spec.md`, `cloud/core/workspaces/{spec,plan}.md`.
2. Sign-in plan Tasks 21-23 (`cloud/auth/web-login/plan.md`); design board `Mentra-Community/fleet-design-board` r2 (`UPDATE-2026-10-20.md` overrides drawings).
3. Plan `~/.cursor/plans/fleet_phase_11_plan_*.plan.md` (not committed: owners W0-W17, checkpoints A-H, O1-O6).
4. Code: Core `cloud-v2/packages/core/src/api/fleet/fleet-forwarding.ts`; protocol `cloud-v2/packages/protocol/src/fleet.ts`; MFM is `fleet/` in `Mentra-Community/miniapp-store` (`dev`).

## Model and entry points

- Membership is management; the Fleet notice only informs. Desired state is `managed` (maybe empty) or `unmanaged` (`paused` is Phase 15); one monotonic `revision` per account. Error, timeout, partial read or no MFM is never an empty set: MFM answers 503, the phone keeps its snapshot.
- MFM scopes queries by its own copy of membership intervals (Core change feed + bootstrap, `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`, deployed >= 120); records are never re-stamped; stale intervals mean 503.
- Core signs scope from the URL only: `/api/portal/fleet/workspaces/:id/*` -> MFM `/v1/portal/workspaces/:id/*`. Org Admins act as Owner. Fleet is not a `PORTAL_MODULE_NAMES` entry. One workspace per person; no unique index on a populated collection.
- Install reasons (`bundled`, `explicit`, `manifest`, `assignment`) are stored apart from artifact provenance (`MiniappReleaseIdentity.source`). Withdrawal keeps data. Private data and dev selections partition by account/Core/workspace.
- Phone Connected = it REPORTED (receipt time `lastReportedAt`) within 20 min, not "last seen" (`phoneStatus`, `fleet/src/query/workspace.service.ts`; `fleet/tests/workspace-queries.integration.test.ts`). Glasses: connected + 10 min.
- Phone: `mobile/modules/engine/src/services/fleet/{FleetReporter,fleetCollector,assignmentReconciler}.ts`, reasons in `AppRegistry.ts` (`hasAssignmentReason`), `services/miniappDataPartition.ts`.
- Portal: `cloud-v2/websites/portal/src/{lib/routes.ts,pages/workspace.tsx,pages/fleet.tsx}`; Invited list `cloud-v2/packages/workspace-ui/src/components/invitations-panel.tsx`; leave/last-Owner Core `services/workspaces/workspace.service.ts` (`leaveWorkspace`).

## Engineering choices recorded (Nicolo's; bounded, no sign-off needed)

1. Latest versions: newest reported in the last 30 days per platform and per glasses model. 2. Mentra Live "Glasses software" is the ASG client APK version; More lists BES and MTK firmware.
3. Phone page is built (Status, Battery, Mentra App; More: OS, app version, assigned miniapp status).
4. Last-Owner copy: "You're this workspace's only Owner. Hand over ownership or delete the workspace in Mentra Portal first."
5. Failure words (reasons per Mentra-Specs #140): storage_full "Not enough space"; archived "No longer available"; access_denied "No access to this miniapp"; not_a_miniapp "Not a miniapp"; download_failed "Download failed"; signature_invalid "Signature check failed"; incompatible_host "Needs a newer Mentra App"; newer_version_installed "A newer version is installed"; manifest_conflict "Set by your organization".
6. Invitation sheet is not swipeable (deviates from the board; Decline is irreversible). Flag in the PR. 7. Update prompt buttons stack, main action on top.
8. Overview cache: rolling-window parts only, keyed by workspace + last complete bucket + interval revision, 15 min TTL; "Connected now" and battery are live.
9. Usage tab deferred to Phase 12; `GET usage` API ships. 10. Undrawn copy: skeleton loading, "Something went wrong. Try again.", empty search "No results for "<query>"".

## Pitfalls log

1. Local MentraOS checkout was 125 commits behind `origin/dev`; read `origin/dev` or use a worktree.
2. `/w/<id>` redirects to the first section and drops the query; Fleet URL is `/w/<id>/fleet?fleet=<path>`.
3. `membership.replaced` is emitted only by `scripts/migrate-store-developer-orgs.ts`. 4. An `unmanaged` answer on a failed Core membership check is wrong; it is 503.
5. `miniappReleaseInstall.ts` automatic update calls `assertStillInstalled`, so it cannot first-install.
6. One-workspace guard = raw doc in `workspace_memberships` (`membership-guard.service.ts`, `_id: ows:<userId>`) lacking `workspaceId`/`mentraUserId`/`status`/`role`, so no membership query matches it. A duplicate key aborts a transaction, so a claim inserts a guard only when the person holds no active membership; a guard counts only while its membership is the active one (never test one with a membership id that has no row). Cleanup writes the retained membership's row before each removal (`pinRetainedMembership`). A 401 from `/me` is `sessionExpired`, not "Fleet unavailable".
7. The claim picks one membership across legacy identities with the email (highest role, earliest), discards the other pending ones (`membership.removed`, keys revoked; web-login rule 4). A discarded last Owner promotes the next live member; none = ownerless, logged.
8. A test with one person in several workspaces writes the extra membership directly (services refuse it); create the guarded one through `createWorkspace` first.
9. CLI `workspace list`/`use` are gone; ship the CLI only after `scripts/one-workspace-cleanup.ts` has run.
10. `/api/portal/fleet` accepts the portal session cookie only (`via === "session"`); a bearer is 403 even if valid.
11. `pages/fleet.tsx` apiBase `/api/portal/fleet/workspaces/<id>`; `/me?workspaceId=` gives an Org Admin that workspace. `PortalMe` fields are optional: an older Core reads as "Fleet not installed". Never pass `fetchPortalMe` as a `queryFn`.
12. Portal `public/_headers` CSP: Fleet loads with no violation locally (2026-10-22); real sign-in/billing under it unverified.
13. Admin Workspaces link needs build-time `PORTAL_URL` (`scripts/deploy-pages.ts`, public, not a Doppler key).
14. Portal Decline is `POST /api/{portal/,}workspaces/invitations/decline`; the Mentra App uses `/api/client/workspaces/invitations/:id/decline`; both call `declineInvitation`.
15. The Fleet UI is `fleet/ui/` in miniapp-store (built to `fleet/ui/dist`, served at `/v1/portal/ui/*`). The MODULE draws every page header (title + search/Add on lists, back + subject on details); the portal passes no title for Fleet (test with `render("/w/<id>/fleet")`; `parseRoute` ignores the query). Trim glasses pictures to the glasses (`fleet/ui/test/glasses.test.ts`) or the shared 150x40 box shrinks them.
16. W9 storage: user data was keyed by Mentra user id only in the default MMKV that logout's `storage.clearAll()` (`src/utils/LogoutUtils.ts`) wipes: `LocalMiniappStorage.ts` (`mentraos_localstorage_<userId>_<pkg>_<key>`), `BlobStore.ts` metadata (files in `Documents/mentra_blobs/<userId>/<pkg>/` survive). Dev selections are global keys (`<pkg>_dev_*`, `dev_apps_index`, `Documents/lmas/<pkg>/dev-*`) in `AppRegistry.ts`, `MiniappLauncher.ts`, `devMiniappLaunch.ts`, `devMiniappSnapshot.ts`, `miniappdev/scanner.tsx`, `applet/dev-offline.tsx`. Release identity/pins live in the `mentra-miniapp-installations` MMKV (survives logout). WebView DOM storage is not partitioned. W9 partitions via `miniappDataPartition.ts` and swaps dev selections per context.
17. An assigned install's provenance is `direct_download`, which `bootstrap.isInstalledMiniappAllowed` and `AppRegistry.getActiveVersion` treat as a developer release under a workspace `localMiniappPolicy`; Phase 16 needs a URL provenance. Compare installs against released versions on disk. State: `mentra-fleet` MMKV (`fleet.assignments.v1/`).
18. `engine.ts` sets `registryInventorySource`, starts the reporter and `startAssignmentReconciler(fleetDesiredStateClient)` (`CloudClientService.ts`); stop is the reverse. `AppRegistry` notifies on first load and assignment/reason writes, not inside an install transaction's `apply`. Real `WorkspaceApi`: `mobile/src/services/fleet/cloudWorkspaceApi.ts`, installed by `MantleManager` before `engine.start()`. Inventory drops entries without `bundleSha256`. `isMiniappAccessRevoked` gates `stores/apps.ts` (`start`, `ensureRunning`, `setForeground`).
19. Fleet sheets mount at sign-in before `MantleManager` wires the client: first look is "not wired" or `session_changed`; `onWorkspaceApiReady` and `pass()` re-looking on `session_changed` make the sheet show. Never present an invitation from a pass whose `mine()` was dropped (offers plain Join, not leave-first).
20. Revocation reaches the phone only as a 401/403 from an assigned URL; `resolveMiniappUrl` sends no credentials, so a private host cannot tell a removed member from anyone. A removed member's private miniapp is withdrawn (uninstalled once idle), not stopped. Device run 2026-10-22: `/tmp/fleet-e2e/phone/` (local).
21. Local stack: `cloud-v2/scripts/fleet-local-stack.ts` + store `fleet/scripts/{dev-stack,seed}.ts` (`--keep-alive` keeps "connected now" past 10 min). Use `--state <dir>` and `FLEET_LOCAL_*_MONGO_URL` to leave another stack alone. The static portal server must send a Content-Type or the module script is refused. The seed sends a not-connected person's records in process with an old receipt time; over HTTP they are received now and read Connected.

## Open items

- Phone battery (spec: person card, Devices > Phones, phone page): the protocol `phone` snapshot has no battery (`battery` is glasses only), `phoneRow` returns `battery: null`. Needs protocol field, collector read, MFM store.
- Members > Invited keeps the page description line as shipped. Cosmos spike for the one-workspace guard NOT run; owners O1-O6; harness host readiness uninspected.
- Phone access to private miniapp URLs (pitfall 20): who authenticates, and whether removal must stop running private code before idle. Undecided.
- Dates: OS-2099 includes Phase 12; Oct 30 / Nov 11 / Nov 19 are meeting evidence, not commitments.

## Tests and verification

- Guard/cleanup: `tests/one-workspace-{guard,cleanup}.integration.test.ts`. Protocol: `cd cloud-v2/packages/protocol && bun test`. Core: `cd cloud-v2 && bun run test`. Portal: `cd cloud-v2/websites/portal && bun test src && bun run typecheck`.
- Device evidence: Android SM-S906U against the local stack, flows (a)-(f), (h), (i), URL-401 revocation (2026-10-22); no iOS, glasses or real private-host evidence. The debug build reads JS from `debug_http_host` in `com.mentra.mentra_preferences.xml`; the dev host's self-signed cert needs a debug-only trust anchor in `network_security_config.xml`.
