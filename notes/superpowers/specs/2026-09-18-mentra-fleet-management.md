---
status: draft
owner: aisraelov
---

# Mentra Fleet Management

Mentra Fleet Management (MFM) lets an organization administer its workspaces,
people, devices, and miniapp provisioning, and understand observed device usage.
Core owns the data and authorization. The Mentra App reports to the Core the user
is signed into, including when that Core serves ordinary consumer accounts.

This spec defines the shared organization, workspace, and permission contract.
[Managed Miniapp Provisioning and Automatic Updates](2026-09-24-managed-miniapp-provisioning-and-updates.md)
defines package distribution and phone reconciliation using that contract. These
are design requirements; they do not assert that the described system is shipped.

## Organization and workspace

An **organization** is one logical Core deployment and its database, not one
container or replica. The official Mentra Core is one organization. A separately
hosted Core is another organization. An organization's identifier is stable across
replicas and hostname changes and is bound to its configured authentication issuer.

A **workspace** is a group inside an organization. Core owns its ID, name, members,
roles, device assignments, and miniapp assignments. Each user belongs to **zero or
one workspace per organization**. Users without a workspace can use the Mentra App
normally. A workspace is not a cloud server, Runtime, deployment manifest, or
separate login provider.

For example, 4Point has a workspace in the official Mentra organization. Its IT
team administers that workspace, associates purchased glasses with it, and assigns
miniapps to its members. Those members use the normal Mentra cloud and login; no
separate deployment manifest or cloud selection is required.

Cross-service references use `(organizationId, workspaceId)`. User references use
`(organizationId, coreUserId)`. A hostname, email address, display name, or identity
provider's organization label is not an authoritative workspace identity.

### Ownership of responsibilities

| Component                    | Owns                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core                         | Organization and workspace records, memberships, roles, permissions, device inventory and history, Fleet observations and summaries, workspace miniapp assignments, administrative audit. |
| Miniapp distribution backend | Package ownership references, private sharing grants, listings, immutable releases, artifacts, publication and download authorization using Core's workspace permissions.                 |
| Developer Console and CLI    | Publishing interfaces that use the same Core workspace identity and authorization.                                                                                                        |
| Mentra App engine            | Phone observations, durable reporting, installed inventory, assignment reconciliation, and the shared miniapp installer/updater.                                                          |
| Core admin web application   | MFM workspace administration, device and usage views, and assignment controls.                                                                                                            |

The distribution backend is implemented in the private
[`miniapp-store` repository](https://github.com/Mentra-Community/miniapp-store).
This refers only to backend distribution infrastructure, **not a user-facing
store in the Mentra App**; no such user-facing feature is part of this design.
Core does not absorb the publishing backend, and the publishing backend does not
maintain a second authority for workspace memberships or roles.

## Roles and permissions

The organization has two roles: **Admin** and **non-admin**. Organization Admins
create workspaces, manage all workspaces, access all Fleet data within that Core,
and recover workspace ownership. Their access does not require membership in each
workspace. It confers no authority over another Core or global release moderation.

A workspace exposes four roles, with cumulative capabilities:

| Capability                                                                  | Member | Developer | Admin | Owner |
| --------------------------------------------------------------------------- | ------ | --------- | ----- | ----- |
| Access miniapps available to the workspace; receive assigned miniapps       | Yes    | Yes       | Yes   | Yes   |
| Develop miniapps, manage listings/releases, publish, manage private sharing | —      | Yes       | Yes   | Yes   |
| Create and manage workspace publishing credentials within permitted scope   | —      | Yes       | Yes   | Yes   |
| View Fleet devices, membership directory, analytics, and workspace audit    | —      | —         | Yes   | Yes   |
| Import/assign devices and configure workspace miniapp assignments           | —      | —         | Yes   | Yes   |
| Invite, remove, or change roles between Member and Developer                | —      | —         | Yes   | Yes   |
| Grant, demote, or remove an Admin or Owner                                  | —      | —         | —     | Yes   |
| Manage workspace settings                                                   | —      | —         | Yes   | Yes   |
| Delete the workspace, subject to resource cleanup                           | —      | —         | —     | Yes   |

Organization Admins can perform every workspace operation. Members and Developers
can read their own membership and the minimum workspace information needed for
miniapp access; they do not gain Fleet or employee-directory access through the
Developer Console. Publishing permissions do not include Fleet provisioning.

The Owner restriction applies to the entire transition, including invitations,
bulk operations, and self-promotion: changing either from or to Admin/Owner
requires an Owner or Organization Admin. Admins cannot remove an Owner indirectly
through account or membership management. A workspace must retain at least one
Owner. Its last Owner cannot leave, be demoted, or be removed until a replacement
is appointed; Organization Admins can recover an abandoned workspace.

Core enforces the one-workspace rule with a database constraint. Invitations are
bound to a verified identity and have an explicit role and expiration. Accepting
an invitation never silently removes another membership. Moving an existing
member between workspaces is an Organization Admin operation that atomically
ends the old membership and begins the new one, respecting last-Owner protection.
A user can leave their workspace unless they are its last Owner.

Implement permissions as named capabilities mapped to the four role bundles,
for example `workspace.members.manage`, `workspace.roles.managePrivileged`,
`fleet.read`, `fleet.devices.manage`, `miniapps.publish`,
`miniapps.credentials.manage`, and `miniapps.assign`. Every backend request checks
both capability and resource scope. The initial UI offers these four roles;
custom roles and per-person capability overrides are outside initial scope.

Credential creation, private sharing, membership changes, ownership recovery,
device reassignment, and miniapp assignments produce audit records with actor,
scope, previous/new values, time, and request ID. Secrets never enter audit data.
Workspace deletion requires explicit resolution of owned packages and credentials,
withdraws assignments and memberships, and follows the retention/deletion rules.

## Authorization shared with publishing

Core is the authority for both people and machine access to a workspace. A
publishing login resolves to a verified Core user, then selects that user's
workspace or an Organization Admin's explicitly chosen workspace. Provider IDs
must map to Core identities through a trusted authentication exchange; matching
an email supplied by a client is insufficient.

The distribution backend trusts explicitly configured Core issuers. It validates
issuer, audience, expiry, organization, subject, and requested resource scope.
It cannot trust a Core URL or workspace role merely supplied by a request. An
independently deployed Core cannot assert membership in the official organization.

A versioned Core authorization contract provides the authenticated user's workspace
context, effective capabilities, membership/authorization revision, and current
resource-scoped authorization decisions. Console navigation uses this context;
backend enforcement is authoritative even if a tab has stale UI state.

Privileged operations, including publication, sharing, credential issuance/use,
and membership changes, require a current Core authorization decision. A denied
or unreachable authority cannot be treated as approval. Display-only workspace
metadata can be cached for up to five minutes; it cannot authorize a write. The
provisioning spec defines bounded download authorization and offline execution.

Publishing credentials are revocable machine credentials scoped to an organization,
workspace, allowed operations, and optionally specific packages. Multiple keys
are supported. A key's effective permission is the intersection of its scope and
its creator's current Core permission in that workspace. Removing/demoting the
creator invalidates operations they can no longer perform. Keys do not grant
Fleet access, role administration, or global moderation. Workspace Admins/Owners
can revoke any workspace key; Developers manage their own keys. CI uses a dedicated
publishing identity and an app-restricted key, with rotation and expiry visible.

## Device inventory and workspace scope

MFM covers devices reporting to the organization and inventory entered before a
device first connects. Organization Admins see all workspaces and unassigned
inventory. Workspace Admins and Owners see only their workspace's authorized data.

Start with serial-number import: an administrator can upload a bounded CSV or add
individual devices with manufacturer/product namespace, serial, optional asset
label, and optional assigned member. Preview duplicates and errors before applying.
Never-connected devices show **Not yet observed**, not fabricated battery, usage,
or connectivity. Import and assignment do not enroll a user or prove possession.

Keep these concepts separate:

- **Fleet device ID:** opaque Core identifier for a physical-device record.
- **Hardware identity:** manufacturer/product namespace and actual serial, where
  available. Show and search serials using normal Fleet permissions.
- **Workspace ownership:** administrative device assignment with effective dates.
- **Assigned person:** an optional member expected to use the asset.
- **Observed account:** the authenticated phone account reporting a connection.
- **Phone installation and sessions:** installation, collector, connection, and
  miniapp execution identities used for attribution and deduplication.

Workspace Admins can import unclaimed inventory and manage their own workspace's
devices. A serial already allocated elsewhere is a conflict; it does not reveal
that workspace's inventory details or allow the importer to claim it. Only an
Organization Admin can transfer a device across workspaces or resolve conflicting
ownership. Keeping the physical device ID preserves history across transfers.

A matching serial is a candidate match, not upload authorization. For imported
inventory, an assigned member's source can be accepted; otherwise an authorized
administrator explicitly accepts the reporting source. For unassigned consumer
inventory, the first authenticated source creates the provisional association;
another phone under that same account can rejoin it. Different accounts require
an approved association. Workspace Admins can approve sources from their own
members for their own devices; cross-workspace associations require Organization
Admin resolution. Unresolved sources are isolated from established state and
physical-device totals and shown only to an authorized resolver. Pairing itself
is not blocked by a Fleet association conflict.

Missing, blank, or placeholder serials use a phone-local peripheral binding and
are labeled provisional. Do not merge by model alone or silently normalize two
serials into one. Reconciliation preserves original authenticated provenance,
records the accepted association interval, and avoids double-counting. Fleet is
an inventory and observation system, not hardware attestation.

### Historical isolation

Core assigns each observation a workspace using authoritative membership and
accepted device-association history at observation time. A client-supplied
workspace ID is only context to validate. Historical intervals and bounded clock
validation prevent a delayed upload from choosing a convenient tenant.

Phone/user observations belong to the user's workspace at that time, or to the
organization's unassigned scope. A device observation additionally needs an
accepted source and compatible device workspace assignment. Conflicting sources
are quarantined for resolution, not exposed to either workspace as trusted data.
Joining a workspace does not automatically claim a member's personal glasses.

Changing membership or device ownership does not relabel history. A workspace
retains authorized observations from its ownership/membership interval; it does
not see prior personal activity, another workspace's history, or later observations
after a transfer. New owners see administrative asset identity and their own
observation interval, not the previous owners' users or usage. Split intervals at
membership/ownership boundaries. Organization Admins can investigate across the
organization. Arbitrary workspace-to-workspace analytics sharing is outside the
initial scope.

Every list, detail, search, aggregate, export, and support-report link applies this
scope on the server. Counts, lookup errors, and filter options must not leak other
workspaces. Fleet access alone does not grant access to globally restricted Core
incident contents; links only resolve when incident authorization also permits it.

## Phone observations and metrics

The phone is the sole collector. Glasses are peripherals it observes; there is no
glasses-side Fleet journal or direct glasses-to-Core telemetry. Do not reconstruct
unobserved activity. Collection works with local miniapps and with cloud realtime
features disabled, using established background operation while the engine runs.
No collection or upload is promised after the phone process terminates.

| Area                     | Initial measurements                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and software    | Device model/serial; phone installation, model and OS; Mentra App/build, engine and SDK versions; glasses APK, MTK/BES firmware and OS where exposed.                                  |
| Current state            | Battery and charging, connection state, first/last observation, last phone contact, field-level freshness and unsupported values.                                                      |
| Miniapp inventory        | Package, version, installation source, observed install/update/remove, desired assignment revision and reconciliation outcome. An initial snapshot does not prove installation date.   |
| Miniapp execution        | Actual running versions, launch attempts/success/failure, user versus automatic starts, run duration, crashes/restarts and crash-loop stops. Include supported system/native miniapps. |
| Usage                    | Glasses connection duration, miniapp duration with/without connected glasses, Mentra App foreground duration, and engine-active duration separately.                                   |
| Photos and video         | Typed operation IDs; requested, confirmed captured, delivered, failed stages; observed recording sessions, duration, and failures.                                                     |
| Mentra Call              | Successful creation and join outcomes, connected duration, and failures from narrow typed phone-side hooks. Credential requests do not prove a call happened.                          |
| Connectivity and support | Pairing failures, connect/disconnect/reconnect outcomes, normalized failure categories, authorized related incident references with association provenance.                            |
| Adoption                 | Active devices/users, repeat usage, and miniapp adoption derived from the defined observations.                                                                                        |

No audio, video, photos, transcripts, meeting URLs/participants, precise location
history, credentials, or arbitrary miniapp payloads are collected by Fleet.
Detailed battery history, gallery capacity, general speech/streaming analytics,
firmware rollout controls, licensing, and remote wipe are separate future scopes.

### Measurement definitions

Connected duration means phone-observed connection to a running engine, not
physical wear. Miniapp duration means actual execution, not a Home-screen flag.
Phone-only execution has no fabricated glasses identity. Time with glasses is the
intersection of execution and connection intervals. Device connected totals are
the union of overlapping observations; concurrent miniapps can sum to more
app-hours than device-hours.

Use cumulative session checkpoints and monotonic elapsed time. A terminated or
interrupted session ends at its last confirmed checkpoint. Clock changes cannot
create negative/unbounded usage. Mark uncertain calendar attribution and partial
coverage. Unsupported, stale, unknown, estimated, and measured zero are distinct.

An active device/user has positive observed glasses-connected duration or a
successful observed glasses operation in the period. Heartbeats alone are not
usage. Miniapp active users have observed execution of that package. Count logical
photo operations once per observed stage; retries, thumbnails, and gallery
downloads are not extra captures. A delivery failure is not necessarily a capture
failure. Count a Call join once per session; reconnects do not create new joins.
Separate connected call time from lobby time and requested video from recording.

Support today, seven days, 30 days, and custom ranges. Persist UTC and use the
organization's configured reporting timezone. Presets include today and the
previous six/29 local calendar days, respecting daylight saving boundaries.
Split intervals at period boundaries. Late activity belongs to its observation
period, not its upload day.

## Collection, persistence, and delivery

Use an engine-owned reporter and the existing Core-authenticated HTTPS client.
General inventory and execution events come from engine lifecycle hooks, not
subscriptions scattered through UI screens. Feature-specific hooks have typed,
registered schemas and feed the same collector; they do not create a general
miniapp analytics API. Runtime owns no Fleet ingestion or database.

Persist meaningful events as observed. Send snapshots on startup, reconnection,
and meaningful changes, and snapshots/cumulative checkpoints approximately every
minute while active. Debounce and coalesce state changes; tune cadence against
measured phone and Core overhead. Do not send per-frame media statistics.

Records carry schema version, stable record ID, installation and collector-session
IDs, sequence, observation time, membership-context revision, applicable device
binding, activity/operation ID, capabilities, and typed payload. Core adds trusted
account/organization identity, resolved scope, and receipt time. Emails are display
attributes resolved through trusted account mappings, never event identity keys.

The bounded durable queue has backoff/jitter and never blocks miniapp, pairing, or
media operations. Each record retains its original account, Core destination, and
workspace context. Logout or Core/account switch closes observed intervals and
isolates pending records. Deliver only as the original account to the original
Core; never keep reusable old credentials just for replay. Report queue drops and
expiration as coverage gaps rather than inventing uninterrupted measurement.

Core acknowledges each record as accepted, duplicate, retryable, or permanently
rejected, after durable persistence. Reject changed content under the same ID.
Apply strict size/count/rate/schema/time limits. An older Core without Fleet is
reported as unsupported; stop queuing and recheck in a later authenticated session.
A temporary outage retains the bounded queue. Never fall back to another Core.

Reuse Core's MongoDB with collections for workspaces/memberships and their history,
devices, source associations, observations, session intervals, summaries, and audit.
Unique constraints and durable processing/checkpoints must work across replicas
and worker restarts. Aggregation is idempotent and restartable; an in-memory task
after sending the response is not sufficient. Delayed history can update summaries
without overwriting fresher current state. Upload time does not refresh a stale
battery observation or prove that glasses are online.

Deployment configuration must define queue/replay bounds and retention for raw
records, association history, deduplication receipts, and summaries before rollout.
Receipts outlive the accepted replay window; expired retries are rejected, not
counted again. Deletion covers derived data and identifiers as well as raw records,
with tombstones preventing delayed uploads from resurrecting deleted history.
A retained asset record need not retain a deleted account's personal history.

Fleet reporting is independent of external analytics configuration. Existing
support-profile and PostHog paths keep their own schemas and behavior; Fleet does
not replay through them, duplicate their events, export raw serials, or backfill
precise history from ambiguous support records. Separately hosted Core receives
local Fleet data with external Mentra analytics disabled and Mentra endpoints
blocked. Ordinary Fleet operation must not require distribution-service access. For
authenticated deployment-local miniapps, this Core also authorizes artifact access
and issues execution leases under the companion spec's manifest rules, including
for deployment-authorized users without a workspace. Central private releases
remain under the distribution backend's access authority.

## MFM administration and API surface

Use the Core admin web application's shared shell and configured Core browser
authentication. Navigation and routes are permission-based: workspace Admins can
enter MFM without becoming Organization Admins or acquiring the incident console's
global access. Private Core hosting includes a working browser login through its
configured provider; phone sign-in alone is not proof that browser auth works.

| Surface                       | Behavior                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization overview         | Organization Admins create/recover workspaces, inspect unassigned inventory, transfer assets/members, and view organization-wide summaries.                |
| Workspace settings and people | Authorized membership invitations, role changes, Owners, settings, and scoped audit.                                                                       |
| Device list/import            | Serial/asset/user search, validated import preview, model/software/battery/freshness, assigned versus observed user, never-observed and unresolved states. |
| Device detail                 | Authorized association history, component versions, observed usage, phone miniapp inventory and assignment status, permitted incident links.               |
| Usage                         | Device/user/miniapp breakdowns, time ranges, coverage and metric definitions, version distribution.                                                        |
| Miniapp assignments           | Select accessible packages, choose latest compatible or exact version, inspect per-member/phone reconciliation status, withdraw assignments.               |

Core exposes versioned contracts for authenticated workspace context and
resource-scoped authorization, workspace/member administration, device import and
associations, Fleet reports and scoped queries, desired miniapp assignments, and
phone reconciliation results. Phone credentials permit their own reporting and
desired-state access; they do not authorize Fleet browsing or administrative writes.
All mutations use the shared authorization/audit layer and concurrency controls
such as revision checks. Route names are an implementation detail, not separate
permission systems for each web interface.

A deployment manifest configures an organization deployed on its own Core. It is
not a membership list. As a follow-on MFM capability, Organization Admins can edit,
validate, preview, and activate versioned manifests for deployments they control,
including supported miniapp configuration. Preserve the deployment's authentication,
origin, and integrity requirements and show which revision clients have observed.
Workspace Admins cannot change organization endpoints, identity providers, or other
workspaces through that feature. Shared-cloud workspace provisioning requires no
manifest editing.

## Acceptance criteria and delivery boundaries

The first delivery includes Core workspaces and the four roles, shared publishing
authorization, serial inventory/assignment, scoped observation ingestion and Fleet
views, and the provisioning contract in the companion spec. Manifest administration
and the explicitly deferred metrics are follow-on work, not launch prerequisites.

Implementation must demonstrate:

1. A workspace in the official Core can administer imported and reporting devices
   without a separate cloud. A user without a workspace continues normal use.
2. Owner protections, single membership, invitation acceptance, transfer, recovery,
   and concurrent role changes hold in Core, Console, CLI, and machine credentials.
3. Searches, aggregates, exports, incidents, delayed uploads, membership changes,
   and device transfers cannot expose another workspace's data or relabel history.
4. Placeholder/duplicate serials, malicious source claims, legitimate account/phone
   changes, imported inventory, and explicit reconciliation preserve provenance.
5. Real MongoDB integration tests cover duplicate/partial batches, concurrent
   replicas, interrupted aggregation, expiration/deletion, clock skew, and timezones.
6. iOS and Android device evidence covers screen-off/background, process termination,
   offline replay, reconnection, account/Core changes, photo/video stages, miniapp
   lifecycles, and Call outcomes. Gaps are visible, not reported as zero.
7. Browser walkthroughs cover organization/workspace roles and configured private
   Core login. A private deployment works with external Mentra services blocked.
8. Measured battery/network cost, ingestion volume, database growth, dashboard
   latency, and retention settings establish explicit operating budgets before rollout.

Implementation tests and device runs provide this evidence. Validating the Markdown
specs alone does not demonstrate the behavior.
