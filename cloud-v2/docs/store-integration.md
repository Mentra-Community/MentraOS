# Store integration

MentraOS provides the open miniapp runtime, SDK, installation and signature
verification, lifecycle/update protections, Core identity, workspace and incident
APIs.
The official Store implementation lives in
[miniapp-store](https://github.com/Mentra-Community/miniapp-store): backend,
miniapp, Developer Console and staff moderation. Public builds do not clone it.

## Runtime boundaries

- The Store miniapp owns its backend URL and supplies its own scoped credential.
  The host does not route credentials by recognizing a Store hostname.
- Core issues miniapp JWTs with `kid=mentra-miniapp-1`, `iss=cloud-core`,
  `aud=<miniapp package>`, `sub=<Mentra user ID>` and `tenantId`. The Store
  verifies the configured Store package audience against Core's public JWKS.
- Core calls `POST /api/internal/dev-attestations/verify` at
  `MENTRA_STORE_INTERNAL_URL` only when a development attestation is supplied.
  Body: `{packageName, attestation}`; success: `{valid: true}`. Its service
  signature is HMAC-SHA256 over `<timestamp>\n<exact JSON request body>`.
- Store calls Core's `POST /api/internal/identity/resolve-email` with `{email}`.
  Its service signature is HMAC-SHA256 over
  `<timestamp>\n<trimmed lowercase email>`. Success returns `{mentraUserId}`;
  an unknown email returns 404.
- Both service requests use `x-mentra-service-timestamp` (Unix milliseconds)
  and `x-mentra-service-signature` (base64url), allowing 60 seconds of clock
  skew. Configure the same `MENTRA_SERVICE_AUTH_SECRET` on both services.
  Existing installations retain the `WORKOS_API_KEY` fallback during cutover.
- Public SDK/CLI contracts remain in this repo. Store uploads accept unsigned releases. The CLI publishes without signing;
  signatures supplied explicitly in an archive are still verified. Once a publisher is
  pinned, the host enforces continuity. Automatic updates defer while a miniapp
  runs; the host displays progress and blocks opens during an accepted update.

## Workspaces, credentials and the Core service API

Core owns who belongs to a developer workspace and what they may do. A
**workspace** is a group of people with a role (`owner`, `admin`, `developer`,
`member`) inside an **organization**, which is one Core deployment. Core stores
workspaces, memberships, invitations, workspace credentials
(`msk_<env>_<ulid>.<secret>`, kept only as a SHA-256 hash of the secret) and an
audit trail with a replayable change feed. The Store no longer stores
membership: it neither writes nor checks member, invitation or API-key records
(the legacy collections stay in its database, read only by the grant backfill
below) and asks Core instead. It keeps what is about miniapps: listings,
releases, each workspace's package prefix (its publishing profile), approval
grants and moderation. Workspace ids are the former developer-organization ids,
so existing package ownership carries over unchanged.

### Service API

The Store calls Core's internal API at `/api/internal/workspaces/*`. Every request
is signed (`@mentra/workspace-contract/server`, `signServiceRequest`): headers
`x-mentra-service` (`store`), `x-mentra-service-timestamp` (Unix milliseconds,
60 seconds of skew allowed) and `x-mentra-service-signature`, an HMAC-SHA256
(base64url) over `<timestamp>\n<METHOD>\n<path with query>\n<sha256 hex of the body>`.
Core accepts any secret in its list for that service. A missing or wrong
signature, an unknown service and a stale timestamp all answer
`401 {"error":"service_unauthorized"}`; a malformed secret list answers
`503 {"error":"service_auth_misconfigured"}`. Every answer that names an
organization carries `organizationId`, and the client refuses one that is not the
organization it is bound to.

- `POST /authorize`: may a person (a bearer token, or a Mentra user id the Store
  vouches for) do `capability` in `workspaceId`, for `packageName`? Returns the
  decision, the reason when denied, the membership and the capabilities.
- `POST /principal`: resolves a bearer token (a WorkOS access token or a Core
  credential) to its principal and workspaces; `401 invalid_token` when it is not
  valid.
- `POST /memberships/check`: roles and capabilities of one person in up to 100
  workspaces, `null` for a non-member.
- `GET /workspaces/:workspaceId`: name, status and authorization revision, or
  `404 workspace_not_found`.
- `GET /changes?after=&limit=`: the change feed, paged by `seq`.
- `POST /credentials` (Store only): mints a workspace credential for a package on
  behalf of a staff member; the token is returned once.

Core's public workspace API (`/api/workspaces`, `/api/organization`) is what
people use through the dashboard, the CLI and the Store proxy. Core credentials
(`msk_`, `mak_`) are refused on those administration routes; people administer.

### Secret pairing

Two secrets, one per direction. Keep both in the secret manager.

- **Store asks Core** (everything above): Core's `CLOUD_CORE_SERVICE_SECRETS` is a
  JSON object whose `store` list holds the accepted secrets, newest first, for
  example `{"store":["<new>","<old>"]}`. The Store's
  `MENTRA_CORE_WORKSPACE_SERVICE_SECRET` is one value from that list.
- **Core asks Store** (the package count before a workspace is deleted): Core's
  `CLOUD_CORE_STORE_SERVICE_SECRET` must be listed in the Store's
  `MENTRA_STORE_CORE_SERVICE_SECRETS`, a JSON array.

The Store also needs `MENTRA_CORE_INTERNAL_URL` (Core's origin) and
`MENTRA_CORE_ORGANIZATION_ID`, which must equal Core's
`CLOUD_CORE_ORGANIZATION_ID`. Without all three the Store fails closed: Console
requests answer `503 core_unavailable` and nothing is authorized.

`CLOUD_CORE_STORE_SERVICE_SECRET` is **required whenever Core has
`MENTRA_STORE_INTERNAL_URL`**. Core asks the Store
(`GET /api/internal/workspaces/:workspaceId/package-count`) before it deletes a
workspace, so a workspace that still owns packages is never orphaned. With a Store
URL and no secret, Core cannot ask and answers workspace deletion with
`503 store_unavailable` rather than assume there are no packages. A deployment
without a Store URL has no packages and deletes freely. The local `bun run dev`
stack defaults `MENTRA_STORE_INTERNAL_URL`, so set the secret there too if you
delete workspaces locally.

The dev-attestation check keeps its own secret (`MENTRA_SERVICE_AUTH_SECRET`,
above) and is unchanged.

### The Store proxy

The Developer Console and the CLI reach workspaces through the Store, so people
sign in once. The Console's `/api/console/workspaces/*` routes proxy Core's
`/api/workspaces` API. The Store resolves the caller with `POST /principal`, takes
the selected workspace from the Console's selection cookie, and checks
capabilities through `POST /authorize`. `GET /api/console/auth/me` lists the
person's workspaces and `POST /api/console/auth/workspace` selects one; a person
in several workspaces with none selected receives `409 workspace_selection_required`
from routes that need one. The Console embeds the shared `@mentra/workspace-ui`
screens (members, invitations, credentials, settings, audit) and adds a
publishing card for the package prefix. Invitation links open `/invite/:token`
and are configured in Core with `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE`.

Credentials restricted to certain packages stay confined to the publishing flow
(create the app for that package, listing, assets, releases, submit) on top of
Core's package scope. Workspace-wide credentials hold the full
`miniapps.publish` routes.

Private miniapps are visible to a person with `miniapps.access` in the owning
workspace, or in a workspace the app is granted to, or to a claimed invitation.
The Store asks Core for memberships in one batched call per catalog request.
When Core cannot answer, a listing hides private apps and a single private app
answers `503 core_unavailable`.

### Approval grants

Publishing credentials are minted through Core (`POST /credentials`), and the
Store records an approval grant for each one and its exact package. Only a
credential with an active grant for the package publishes without review.
Credentials that existed before the migration are backfilled: at startup the Store
creates a grant (granted by `migration`) for every live app-scoped key in the
legacy `developer_org_api_keys` collection, keyed by the key id that Core keeps as
the credential id. The pass is idempotent, never touches a revoked or package-less
key, and a grant that staff revoked stays revoked. Without it, first-party
miniapp CI would stop auto-publishing at cutover.

### Migrating developer organizations

Existing Store developer organizations, their members, pending invitations and
`msk_` keys move into Core once, with
`cloud-v2/packages/core/scripts/migrate-store-developer-orgs.ts`. Run it from
`cloud-v2` after Core is deployed with its new environment:

```sh
# Dry run (the default). Reads the Store database only, does not connect to the
# target, writes nothing, and prints a JSON report to stdout.
bun packages/core/scripts/migrate-store-developer-orgs.ts \
  --source "$STORE_MONGO_URL" --target "$CORE_MONGO_URL" --organization-id "$CLOUD_CORE_ORGANIZATION_ID"

# Apply. An operator running the real cutover passes --i-understand-remote; the
# script refuses a non-local URL without it.
bun packages/core/scripts/migrate-store-developer-orgs.ts \
  --source "$STORE_MONGO_URL" --target "$CORE_MONGO_URL" --organization-id "$CLOUD_CORE_ORGANIZATION_ID" \
  --apply --i-understand-remote
```

`--organization-id` must equal the deployment's `CLOUD_CORE_ORGANIZATION_ID`. Read
the dry-run report before applying:

- `counts` of organizations, memberships, invitations and credentials, and the
  environment labels the keys carry. List every label in Core's
  `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` (the Mentra Store issued `prod` and the
  legacy `dev`) or those keys stop validating;
- `ownerlessOrgs`, `promotedOwners` and `synthesizedOwners`: organizations with
  no owner membership. The recorded owner is promoted, or given a pending owner
  membership; an organization with no recorded owner is left for an Organization
  Admin to recover;
- `keysWithoutCreator` and `malformedKeys`: keys that could not migrate and were
  skipped (a key must belong to its creator's membership, and have the shape of a
  Core credential);
- `duplicateMemberships`: a person with several active rows keeps the highest role.

Active memberships keep the person's WorkOS user id until their first sign-in
claims them. Roles map `owner` to owner, `admin` to admin and `member` to
developer. Invitations are those still pending and unexpired; keys are imported
with their dates, revoked ones included. The source is only read. Each
organization imports in one short transaction with an audit event, and a re-run is
safe: it adds rows it has not seen, never overwrites a change made in Core since,
and never revives an ended membership or a revoked key. It does not carry later
changes made in the old Store, such as a key revoked after the first apply, so
keep the interval between apply and Store cutover short.

## Local development

`bun run dev` starts Core, Runtime and the test OEM without Store source.
For Store work, start the private backend separately on port 3003 and Console
on 5173. Configure `MENTRA_STORE_INTERNAL_URL=http://127.0.0.1:3003` in Core,
`MENTRA_CORE_INTERNAL_URL=http://127.0.0.1:3000` and
`MENTRA_STORE_CORE_JWKS_URL=http://127.0.0.1:3000/.well-known/jwks.json` in Store,
and the same service secret. For workspaces, pair the secrets as described above:
a value in Core's `CLOUD_CORE_SERVICE_SECRETS` (`{"store":["dev-secret"]}`) as the
Store's `MENTRA_CORE_WORKSPACE_SERVICE_SECRET`, Core's
`CLOUD_CORE_STORE_SERVICE_SECRET` in the Store's `MENTRA_STORE_CORE_SERVICE_SECRETS`,
and the Store's `MENTRA_CORE_ORGANIZATION_ID` equal to Core's
`CLOUD_CORE_ORGANIZATION_ID` (`local` when Core sets none outside production).
Core admin remains on 5174 and uses `CORE_URL`.

## Bundled Store artifact

The Store ZIP is checked into `mobile/assets/miniapps`; public CI needs neither
private source nor credentials. With a private checkout available, run
`bun scripts/sync-miniapp.mjs --repo /path/to/miniapp-store --bump patch`.
Review and commit the private source/version and the public ZIP/catalog together.
The private repository pins its public SDK dependencies to immutable package
snapshots with a source SHA and checksums, until suitable npm releases exist.

## Deployment ownership

Core and Runtime remain in the coordinated Cloud V2 release. The private Store's
`main` branch deploys one production Store independently. Its current temporary
backend is `https://store.dev.us-west-2.mentraglass.com` and its website is
`https://apps-dev.mentraglass.com`. These names do not select a dev catalog.
The CLI and bundled Store select their Store explicitly, independently of Core's
environment. Official Core Porter definitions point to the same Store for developer
attestation verification. Local/self-hosted services can configure explicit URLs.

Store preserves its existing data, developer accounts, storage and signing keys.
Moving the website to `apps.mentraglass.com` later is a domain change, not a catalog
promotion. The private `docs/cutover.md` describes the deployment and rollback.
Store moderation stays in the private Developer Console. Core admin keeps its
existing domain, login, report deep links and incident APIs.

The Store may verify miniapp tokens from several explicitly trusted Core JWKS
endpoints. Core environments with separate account databases retain distinct opaque
user identities; private Store invitations resolve through the canonical production
Core. Configure Store's `MENTRA_CORE_IDENTITY_SECRET` for that lookup and its
`MENTRA_STORE_CORE_SERVICE_SECRETS` JSON list for accepted Core attestation callers.
Core's developer-attestation requests keep using its own service secret
(`MENTRA_SERVICE_AUTH_SECRET`); its workspace package-count requests use
`CLOUD_CORE_STORE_SERVICE_SECRET` (see Secret pairing above).

Core owns browser login, callback, organization selection and logout at
`/api/console/auth/*` for both public websites. Configure Core
`ADMIN_URL` and `PORTAL_URL` (included in the environment Porter files) and
its existing `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`.
Allowlist both website origins plus `/api/console/auth/callback` in WorkOS,
and their origins as sign-out return URLs. Local callbacks use ports 5174 and 5175. These routes do not call Store and preserve incident report deep links.

## First-party miniapp release repositories

Captions, Translation, Teleprompter, Mentra Maps, and Recorder now own their
source in separate repositories, alongside Notes, Call, Livestreamer, Mentra AI,
and Merge. See the root `AGENTS.md` for repository links and
`scripts/miniapp-repos.json` for local checkout mappings. Mentra Maps keeps
`com.mentra.navigation`. Public SDK examples remain in MentraOS.

Each repository versions its Store listing and artwork, validates an unsigned
production ZIP, and publishes new `miniapp.json` versions on `main`. Apps with
backends wait for their production deployment before publishing. The private
Store repository supplies a shared publishing action pinned by commit, with an
isolated source-pinned CLI until the npm release. Each repository has a separate
app-restricted publishing credential in GitHub Secrets. Already-published
versions skip listing changes and publication; unfinished uploads can resume
only with identical bundle bytes.

MentraOS still preinstalls the ZIPs in `mobile/assets/miniapps/`. Download the
successful release workflow's artifact and preserve its exact bytes:

```sh
bun scripts/sync-miniapp.mjs --repo /path/to/miniapp --no-bump --artifact /path/to/release.zip
```

This verifies the package/version, replaces the bundled ZIP, and regenerates
`mobile/src/generated/bundledMiniapps.ts` without rebuilding or signing it.
Use the named mapping (for example `bun scripts/sync-miniapp.mjs maps`) for an
intentional local production build and version bump. Maps requires the public
`PUBLIC_MAPBOX_TOKEN` build variable.

### Manual updates and local development

Bundled package IDs remain usable through the consumer developer QR/URL flow.
A live QR registration shadows its installed bundle, supports offline snapshots,
and survives startup without being replaced by bundled installation. A release
QR installs the matching unsigned ZIP under the same package ID and reloads a
running miniapp. QR and Store use the same release-install service and archive
installer: an incoming release must be greater than or equal to the installed
release version. Equal-version replacement is allowed; downgrades are rejected.
The installer rechecks ordering after download in its serialized filesystem
transaction, so a delayed download cannot replace a newer installed release.
Live development sessions and snapshots do not require version bumps.

Installation failures restore the prior files and metadata, including during a
same-version replacement. Once a verified installation commits, it remains
installed even if its code cannot launch; launch failure is separate from install
failure. A committed release clears obsolete live-dev registration and snapshots.
Release selection invalidates earlier dev probes/downloads so an obsolete snapshot
cannot undo a completed installation. A manual release at the same or a newer
version is preserved; a newer bundled release can replace it on a later Mentra App
upgrade. Automatic Store updates only select newer releases and defer while an app
is running; this scheduling policy uses the same installer.

Manual and development releases do not acquire privileged SYSTEM APIs from the
package name. The Store's automatic updater leaves these overrides alone.
Workspace-managed versions retain their exact version/hash/deployment policy;
consumer developer URLs and manual release installs cannot override them.
Approved, non-managed system miniapps can use their build-assigned Store releases
inside a workspace, including releases installed before entering the workspace.
Consumer and workspace selections, bundle files, and release provenance are
stored separately. If the consumer has a
manual/dev override, an approving workspace selects an eligible bundled or Store
release instead; returning to consumer mode restores the override. Workspace
installation, cleanup, and release garbage collection preserve that consumer
selection and its dev snapshots. Recovery journals record which selection they
changed, so interrupted workspace installs cannot overwrite the consumer choice.
This also preserves both builds when a host upgrade, Store release, or workspace
pin uses the same version number as an existing consumer manual release.

### Background updates and Store availability

The bundled Store runs as a background update worker. There is no Store toggle in
Super Settings, and the Store is excluded from Home, All Apps, and inter-miniapp
discovery. User-facing launch and foreground requests remain blocked, including
when an old preview preference is persisted. Bundled ZIPs remain installed and
available offline.

After bundled installation and restoration of running miniapps, the host starts
update checks for the installed Stores permitted by the active deployment. Checks
run immediately, on foregrounding, on Cloud reconnection, and every 15 minutes
while the runtime operates. Logout/runtime cleanup stops the scheduler; updates
are not guaranteed while the Mentra App is terminated.

The host invokes the Store's declared, host-only `reconcile_updates` action in a
transient background context. Background availability is distinct from interactive
availability; deployment and installed-release policies still apply in both modes.
Only host-only transient actions may resolve a background-only package. The Store
selects newer compatible releases and requests the shared host installer, deferring
running miniapps until a later check. The worker stays out of the running tray and
its context is released when maintenance finishes. Foreground reconciliation clears
old Store UI/autostart state without stopping an active background update.
