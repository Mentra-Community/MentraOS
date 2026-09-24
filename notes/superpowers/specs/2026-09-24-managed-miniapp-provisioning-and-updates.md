---
status: draft
owner: aisraelov
---

# Managed Miniapp Provisioning and Automatic Updates

The Mentra App installs miniapps assigned to its signed-in workspace and keeps
eligible installed miniapps current through background maintenance. Bundled ZIPs
provide initial installation and offline availability. Published releases can
subsequently update those installations through the same installer used for
explicit installs.

This design uses backend distribution infrastructure. It does **not** introduce
a user-facing store in the Mentra App. Installation and update maintenance require
no discovery screen, navigation entry, preview toggle, or user interaction with
a catalog.

[Mentra Fleet Management](2026-09-18-mentra-fleet-management.md) is authoritative
for organization/Core identity, workspaces, the one-workspace-per-user rule, the
four roles, and cross-service authorization. This companion spec defines how
publishing, assignment, and phone installation use that model. Requirements below
are the intended design, not a claim that every integration is implemented.

## Service boundaries

| Component                    | Responsibility                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core / MFM                   | Authoritative membership and roles; administrator-controlled workspace assignments; desired state for the authenticated user; scoped installation reports.                                                             |
| Distribution backend         | Package ownership and sharing, listing/release lifecycle, immutable artifacts, compatible release resolution, authorized artifact delivery. Uses the backend repository identified in the MFM spec, not a new service. |
| Developer Console / CLI / CI | Create packages, edit listing metadata, upload unsigned bundles, submit/publish releases under Core workspace authorization.                                                                                           |
| Mentra App                   | Resolve desired releases, download and validate artifacts, serialize installation, preserve bundled availability, expose progress/failure, report observed outcomes.                                                   |

Core does not proxy every ZIP or implement a second release database. The
distribution service does not independently choose who belongs to a workspace.
Miniapps install on the **phone**, not on each pair of glasses. Fleet device views
show inventory observed on associated phones, including its timestamp and source.
One user's multiple phones reconcile independently.

## Package ownership, access, and publishing

A package has a stable unique package identifier and an owning
`(organizationId, workspaceId)`. Publishing permissions in that owning workspace
control its listing and releases. Moving source repositories does not change the
package identifier. Package ownership transfers require authorized participation
from both owners, or explicit distribution-operator recovery, and are audited;
assigning another publisher's package never transfers ownership.

A published release is an immutable package/version/artifact tuple with a digest,
size, compatibility metadata, and signing identity or explicit unsigned status.
Use the manifest's validated semantic version (`miniapp.json.version`) for ordering.
Version labels cannot be reused for different published bytes. Drafts and incomplete
listings are not published releases. A production publication must advance that
package's published version; an idempotent retry of the same release returns its
existing result. This publication rule is separate from equal-version reinstall
support on phones.

Developer, Admin, and Owner roles can develop and publish workspace packages,
subject to the distribution service's review policy. Ordinary workspace or
Organization Admin status does not confer global moderation or approval bypass.
Those operations have separate distribution-operator authorization. Approval
shortcuts for first-party automation must be granted explicitly to that publishing
identity/package scope; a CLI flag or user-created API key cannot self-grant them.

CLI commands must cover package creation, listing fields/assets and validation,
release upload, submission/publication, and status inspection so a developer can
complete the publishing flow without the Console. The Console provides the same
operations and clear draft/review/published states. CI uses an app-restricted,
revocable key and checks/builds the unsigned artifact before publication. A push
without a new manifest version skips publication; retries do not create duplicates.
Neither CLI nor backend requires or automatically adds a bundle signature.

### Access and sharing

Public packages can be resolved by ordinary authenticated users. Private packages
are accessible to members of their owning workspace and to destination workspaces
explicitly granted access by the publisher. A sharing grant references the full
organization/workspace identity, not its name or one invitation per employee.
The publisher can revoke a grant. Core membership changes take effect without
editing an independent distribution membership list.

Access to a package is not an instruction to install it. A workspace Admin/Owner
or Organization Admin creates an assignment only for a package the destination
workspace is allowed to receive. An assignment cannot grant access to an arbitrary
private package. Conversely, Developers can publish/share miniapps without being
able to assign software to every member or browse Fleet analytics.

The service checks private package access at resolution and delivery. Artifact
URLs are not permanent public capabilities; download authorization is bounded to
five minutes and scoped to a release and authorized subject/context. Already issued
artifact access may remain valid until that bound; private installation still
requires a fresh authorization check at commit. Publishing
and credential use follow MFM's current Core authorization contract. Do not forward
a broadly scoped Core or identity-provider token to an artifact host; use an
explicitly audience-scoped exchange and trusted distribution configuration.

## Workspace assignments and desired state

Core keeps one active assignment per `(workspaceId, packageId)`, containing:

- Stable assignment ID, revision, assigning actor, and created/updated times.
- Package identifier and distribution authority; validated workspace access.
- Selection policy: **latest compatible published release** (default) or **exact
  published version**. A pin is a selection constraint, not a downgrade override.
- Required installation state and withdrawal status.

The initial model has required workspace assignments, not per-user exceptions,
custom deployment rings, or a second policy language. Every member receives the
same workspace assignment set. Members can inspect their own installation status;
only assignment administrators can alter the set. A required miniapp removed
locally is reinstalled on the next successful reconciliation; show that behavior
in its managed status. Workspace membership itself does not launch a miniapp or
change its autostart setting.

Core returns an authenticated desired-state snapshot with organization, user,
workspace or explicit no-workspace state, membership revision, assignment-set
revision, assignment entries, and generation time. A complete snapshot is required
to interpret removals; an error, timeout, or partial page is never an empty set.
Each reconciliation validates that this snapshot still belongs to the phone's
active account/Core context.

Installed bundled/public packages remain eligible for ordinary release updates
without workspace membership. That process checks only installed eligible package
IDs; it never installs every available package. Additional automatic installs come
from assignments or an explicitly configured deployment manifest. For a package
with an assignment, that assignment's selection policy takes precedence over the
ordinary latest-release check.

```mermaid
sequenceDiagram
    participant Admin as Workspace administrator
    participant Core as Core / MFM
    participant App as Mentra App
    participant Dist as Distribution backend
    Admin->>Core: Assign accessible package and version policy
    Core->>Dist: Validate destination workspace access
    App->>Core: Fetch authenticated desired state
    Core-->>App: Membership and assignment revisions
    App->>Dist: Resolve eligible release with scoped authorization
    Dist-->>App: Immutable release descriptor and bounded download access
    App->>App: Wait until idle; validate; install through shared transaction
    App->>Core: Report actual inventory and reconciliation outcome
```

If the distribution service is unavailable, retain desired state and retry;
existing installed code is not removed merely because resolution failed. A
revoked grant or unpublished/withdrawn release is an explicit state, not a network
error. Administrators see which assignments are blocked and why.

## Scheduling and shared installation

Check at authenticated engine startup, foregrounding, reconnection, and roughly
every 15 minutes while the runtime operates. Coalesce simultaneous triggers and
apply jitter/backoff. Resume deferred work when its miniapp stops. Use existing
background capabilities on iOS and Android; do not promise installation while the
Mentra App process is terminated. No maintenance gate may depend on a catalog UI
setting.

QR/manual installs, bundled installs, assignment installs, deployment-manifest
installs, and automatic updates use a shared validated installation transaction.
Their source determines authorization and version selection; it does not create
another filesystem installer or weaker replacement rules.

### Installation invariants

1. The artifact's package identifier matches the selected package, and archive,
   manifest, integrity, host compatibility, and destination checks pass.
2. To replace an installed package, the incoming signing identity matches the
   installed identity, **or both releases are unsigned**. Unsigned-to-signed and
   signed-to-unsigned replacement are not identity matches. No special first-party,
   QR, assignment, or system-package bypass exists.
3. The incoming version is **greater than or equal to** the installed version.
   Lower versions are rejected for every source. An explicit equal-version
   reinstall is valid. Automatic latest-release updates select strictly newer
   versions; assignment reconciliation may install its selected equal-version
   artifact if the installed bytes differ.
4. Recheck version, identity, active account/context, desired-state revision, and
   running state when the serialized transaction commits, not just at download
   selection. A competing install cannot make a stale decision valid.
5. Update bytes and registry metadata atomically, retaining a recoverable previous
   installation until commit. Failure/cancellation before commit restores it.
   After commit, a miniapp launch error is reported as a launch error; it does not
   silently revert to an older release.

Unsigned status does not authenticate a publisher. Automatic delivery requires
authorized release provenance and a verified artifact digest; an explicit QR/manual
install instead uses the artifact the user chose. A user-installed unsigned build
with a higher version can therefore block a managed release until an eligible
version is published. Required assignment status does not bypass this rule.

An exact assignment pinned below an already installed version is **blocked by a
newer installed version**. Report the actual version instead of claiming that the
pin was applied. Rollback requires publishing a corrective higher version; normal
maintenance never downgrades.

Package management has no blanket exemption for a manual installation or live
development selection. A qualifying managed release can replace one under the
same version and signing rules. After a successful release installation, clear
that package's live-development selection so launching runs the installed release.
No additional management-takeover consent is required. Idempotency compares the
selected immutable release and installed digest/context: a satisfied assignment
does not reinstall or reset app state at every poll. Equivalent cached bytes may
satisfy installation after their digest is verified and any live override is
cleared while the miniapp is stopped.

A workspace role, package ownership, unsigned bundle, or distribution origin does
not grant `SYSTEM` privileges. Privileged host capabilities remain governed by
the engine's independently trusted system-package policy. A compatible update to
a bundled system package must preserve legitimate Home visibility and autostart
eligibility in its authorized context, without extending those privileges to an
arbitrary package.

### Running miniapps and update UI

Automatic installation defers while the target miniapp is running. It never
stops an active session merely to install a release. Acquire the package's update
reservation while idle before automatic download/install begins; every launch
path, including autostart and deep links, respects that reservation. A deferred
update does not reserve or block a still-running miniapp.

During active download/install, Home shows a subdued overlay and progress or an
indeterminate updating indicator. Tapping displays **“This miniapp is updating.
Please try again shortly.”** and does not launch or queue an unexpected launch.
Apply the same guard to launch attempts outside Home. Clear the reservation and
indicator on completion, failure, cancellation, or recovered interruption. Network
backoff must release it so an existing installation remains usable; do not leave
an app blocked for an entire retry interval. Foreground retries may resume a
validated staged download after reacquiring the reservation.

Bundled ZIPs stay in MentraOS assets for initial and offline installation. App
startup and phone-app upgrades do not overwrite a newer installed release with
an older bundled ZIP. Preserve miniapp data across a compatible update. A broken
download, insufficient disk space, bad digest, incompatible manifest, or interrupted
transaction must leave the previous installation usable.

## Membership changes, removal, and offline operation

Keep installed package bytes, launch availability, miniapp data, and assignment
ownership as separate state. Record why a package is present: bundled baseline,
explicit installation, deployment requirement, or workspace assignment. A managed
update replaces bytes; it does not erase another valid installation reason or
create a hidden backup that later bypasses version checks.

When a complete desired-state snapshot withdraws an assignment, stop enforcing
that assignment and clear its management status. If it was the only installation
reason, uninstall the package when idle. Preserve its local data for a future
reinstall or explicit user deletion; withdrawal is not remote wipe. If another
reason remains, keep the installed release, subject to current package access.
Do not restore previously installed lower-version bytes. An administrator can
withdraw and reassign using ordinary revisioned desired state.

Membership removal or workspace transfer immediately invalidates that workspace's
local authorization once the phone learns of it. Stop accepting its queued work,
clear its desired state, and reconcile installation reasons. Public/bundled apps
with another valid reason remain available. Private workspace code loses launch
permission when access is revoked, even if it was previously installed manually.
Stop a running private miniapp on explicit authorization loss; this is access
revocation, not an update interrupting a session. Backend APIs enforce their own
current authorization regardless of what the phone has observed.

Private execution uses a verifiable access lease from the package's configured
authority. For centrally distributed private packages, the distribution backend
issues it after validating Core membership and package access. For authenticated
deployment-local packages, the deployment's Core issues it under the manifest
authorization rules below. A lease binds the issuer, execution audience, account,
organization, package, authorization revision, and workspace when the access grant
is workspace-scoped. Its **maximum lifetime is 24 hours** from successful renewal. This authorization credential
is separate from bundle signing; bundles can remain unsigned. Renew during normal
reconciliation; explicit denial revokes local access immediately. Offline use is allowed until expiry, then
private launch is blocked and running private code is stopped until authorization
can be renewed. Track server time with monotonic elapsed time; a clock rollback
cannot extend a lease. If validity cannot be established after restart, renew
before running. This is a deliberate offline/revocation tradeoff, not a claim that
an offline phone can receive immediate remote revocation.

Download/commit needs current online authorization from the relevant authority; an offline cached desired-state
snapshot alone cannot initiate a new private installation. Public/bundled code
already installed remains available offline. Public assignment removal likewise
cannot be learned while offline; reconcile after contact returns. Removal/expiry
clears package update reservations and prevents revoked staging from committing.

On logout, account switch, or Core switch, invalidate outstanding operations and
launch access for the old context before activating the new context. Partition
miniapp user data and development selections by account/Core and, for workspace
private data, workspace. Do not expose previous workspace private state after a
move. Cached bytes may be reused only after integrity and new-context access
validation; they are not evidence of authorization. Retained inaccessible data
remains subject to user deletion and the product's account-data deletion policy.

## Deployment manifests

A deployment manifest describes a separately deployed organization's configuration.
It can declare required packages and pinned artifacts without a shared-cloud
workspace. It is not a parallel membership directory and is not required for a
workspace inside the official Mentra organization.

Translate supported manifest requirements and workspace assignments into desired
installations for the same reconciler. An organization-required manifest package
has precedence over a conflicting workspace assignment; MFM reports the conflict
instead of letting two loops repeatedly replace the package. Both sources obey
the same version, identity, running-state, origin, and integrity rules. Manifest
pins cannot downgrade an existing installation. Organization-required packages
cannot be removed by a workspace administrator withdrawing an assignment.

### Authorization for deployment-local packages

An isolated deployment can supply authenticated local artifacts without depending
on the central distribution service. Its configured Core is the access authority
for those manifest-declared packages. A manifest identifies each artifact's trusted
source and authorization mode: public/offline baseline, or authenticated deployment
access. A client cannot relabel a centrally distributed private release as a local
artifact to bypass its publisher's grant or lease requirements.

For authenticated deployment access, Core checks the current account's access to
that deployment and the active manifest revision. An organization-required package
is available to authenticated users authorized for that deployment, including users
with **no workspace**. Its lease has no workspace binding; it uses the deployment
and manifest authorization revision. A local package restricted by a workspace
assignment also requires that workspace's current membership/access and includes
its workspace binding. Neither a matching serial nor a cached manifest grants
private execution access on its own.

Core issues the execution lease and authorizes artifact delivery/installation using
the same bounded lease and commit rules as centrally distributed private packages.
The phone verifies Core against its trusted deployment configuration and verifies
the lease's issuer, audience, subject, package, scope, revision, and expiry. Only
the configured distribution authority can issue leases for central private releases;
a local Core lease is accepted solely for its configured local-artifact scope.
This Core capability authorizes access; it is not a separate publication catalog.

A deployment may be disconnected from the public internet while its Core and local
artifact server remain reachable: login, renewal, installation, and updates then
operate entirely locally. If the phone also loses contact with its Core, an existing
private execution lease remains usable only until its 24-hour expiry. Loss of
account/deployment access, or removal of the package from the active manifest,
prevents renewal and revokes access when the phone learns of it. Workspace changes
alone do not revoke an organization-wide manifest grant. Public/offline baseline
packages remain available without a private-execution lease.

Lack of the central distribution service does not disable local Fleet, authorized
manifest installs, or bundled availability. Organization-level manifest
administration follows the MFM spec; workspace assignment changes cannot rewrite
Core URLs or deployment trust settings.

## Reporting and validation

Report per-phone observed inventory and an outcome for each assignment/release:
**pending**, **deferred while running**, **downloading**, **installing**, **installed**,
**blocked** with a stable reason, **retrying**, or **withdrawn**. Include desired
revision, selected and actual version/digest, attempt time, and last successful
observation. Transport success or an uploaded bundle is not proof of installation.
A stale phone stays visibly stale; one phone's success does not stand in for all
of a user's phones. Reports are bounded, idempotent, Core-authenticated, and scoped
under MFM's observation-time membership rules. Never include credentials or
artifact URLs containing bearer authorization.

Implementation acceptance requires:

1. A newly joined workspace member receives its assigned private package on the
   ordinary Mentra Core; a nonmember cannot resolve/download it. An unassigned user
   gets updates to installed public/bundled apps but no unsolicited catalog apps.
2. Publishing through CLI and CI produces validated unsigned releases, respects
   review/access permissions, skips unchanged versions, and retries idempotently.
3. Role demotion, key revocation, private sharing withdrawal, membership transfer,
   and Organization Admin recovery work across Core, Console, and distribution.
4. The common installer covers all source pairs, equal/lower/newer versions,
   signed/unsigned identity combinations, exact pins, and manual/live-dev updates.
5. Running apps defer updates. Racing startup/autostart/deep links are blocked once
   update reservation starts. Progress, failure, cancellation, and process restart
   never leave a permanent lock or partially installed code.
6. Corrupt archives, digest mismatches, disk failures, incompatible releases,
   concurrent transactions, stale assignments, and account switches preserve the
   previous committed installation and cannot commit into the wrong context.
7. Assignment withdrawal preserves other installation reasons and data as specified;
   private revocation/lease expiry blocks execution. Offline periods, clock changes,
   delayed phone reports, and two phones for one user have deterministic outcomes.
8. Bundled system miniapps remain visible and eligible for their legitimate autostart
   behavior after updates; arbitrary workspace packages never gain system powers.
9. iOS/Android device runs exercise startup, foreground, screen-off/background,
   reconnection, active miniapps, and termination/recovery. There is no dependence
   on catalog navigation or a UI enablement toggle.
10. Shared-cloud provisioning and an isolated deployment with manifest artifacts
    both work through the common installation path, including authenticated local
    packages for users without workspaces. Verify local Core lease issuance/renewal,
    expiry and revocation, rejection of a local lease for a central private release,
    visible conflict/status reporting, and no unauthorized cross-workspace data reuse.

These criteria belong in implementation tests and device evidence. This spec does
not itself enable publication, deployment, or automatic installation.
