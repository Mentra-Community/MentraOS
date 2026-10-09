# Mentra Private Deployment operations

## Reports and durable attachments

Core stores report records in the deployment's Cosmos DB (MongoDB API).
Core's report-asset schema creates the `createdAt` index required by Cosmos
for the ordered attachment lookup.
The Azure setup also creates an Azure Files share and mounts it at
`/mnt/core-attachments` in Core. `CLOUD_STORAGE_PROVIDER=local` refers to this
durable mount, not the container's temporary filesystem. Logs and screenshots
survive Core revision replacement. The share authenticates with an account
key held by the Container Apps environment, uses encrypted SMB, and has
seven-day share-delete retention. It uses the storage service's authenticated
public endpoint, matching this reference deployment's non-VNet topology.

Report access uses Core's organization capabilities. An Organization Admin is a
verified identity email listed in `coreAdminEmails` (supplied to Core as
`CLOUD_CORE_ADMIN_EMAILS`). An operator key (`mak_...`) created by an
Organization Admin reaches the admin routes its scopes allow, including report
listing and triage, while its creator's email stays on that list. Private Core
signs employees in through Entra only and browser admin sign-in for private
deployments is not available, so setup's operator key is the administration
path.

Setup creates the key itself. After Core is deployed, setup's **Administrator
key** step adds the installer identity, `operator@private-cloud.local`, to
`coreAdminEmails` (so later rollouts keep it), waits for the Core revision that
carries it, and runs `installer/admin-key.ts` inside that revision (`az
containerapp exec`). The script mints the key through Core's credential service,
with the incident, support-profile and testing scopes. Core stores only the
key's hash and keeps an encrypted copy in its database (encrypted with the
deployment's signing key), so a retried run returns the same key. Setup stores
the `mak_local_...` value in Key Vault as `mentra-admin-key`, tagged with its
`keyId`, and checks that the key can list reports. No app can read the Key Vault
secret. Keep `operator@private-cloud.local` in `coreAdminEmails`: removing it
disables the key. The `.local` address cannot be a verified Entra domain, so no
employee sign-in can claim it.

A deployment whose administrator key is an `msk_local_...` key keeps that key.
Core treats it as an operator key with the same scopes, created by its address
`api-key@<keyId>.local`: it works while that address stays in `coreAdminEmails`,
and setup keeps both the address and the key. Only when the saved key no longer
works does setup mint a `mak_local_...` key and store it in Key Vault in its
place. A deployment made with `scripts/deploy.sh` mints its key the same way: add
`operator@private-cloud.local` to `coreAdminEmails`, deploy, and run
`installer/admin-key.ts` with the deployment's owner ID inside the Core container.

Setup's summary prints the read command and a report request:

```bash
az keyvault secret show --vault-name <key-vault> --name mentra-admin-key \
  --subscription <subscription-id> --query value --output tsv
curl -H "Authorization: Bearer $(az keyvault secret show --vault-name <key-vault> --name mentra-admin-key --subscription <subscription-id> --query value --output tsv)" \
  https://<enterprise-core-host>/api/admin/reports
```

Rotate the administrator key with Mentra support. Do not store a new
`mentra-admin-key` value by hand: setup identifies the key by its `keyId` tag and
Core's journal, so a hand-made value breaks later setup runs.

Enterprise Dev CI uses the `ENTERPRISE_DEV_CORE_ADMIN_EMAILS` repository variable
and `ENTERPRISE_DEV_ADMIN_TOKEN` secret. The workflow always adds
`operator@private-cloud.local` to that allowlist and keeps every address in the
variable, so the secret, an operator key of that deployment (its `mak_local_...`
key, or the `msk_local_...` key whose `api-key@<keyId>.local` address the variable
lists), keeps working. The secret is
used only to verify the authenticated admin report route; Core validates the key
against its database. The deployment helper performs the same check when
`MENTRA_ADMIN_TOKEN` is set. Preserve signing keys and the refresh-token pepper
when updating an existing deployment.

The Mentra App feedback confirmation displays the report ID and offers
**Copy report ID**. Retrieve a known report and its attachments with:

```bash
export MENTRA_CORE_URL=https://<enterprise-core-host>
export MENTRA_ADMIN_TOKEN="$(az keyvault secret show --vault-name <key-vault> --name mentra-admin-key \
  --subscription <subscription-id> --query value --output tsv)"
./scripts/fetch-incident-logs.sh rep_01...
```

`--list` also works with this operator key. For Enterprise Dev, operators
who keep the key as `MENTRA_ADMIN_TOKEN_ENTERPRISEDEV` can pass
`MENTRA_ADMIN_TOKEN="$MENTRA_ADMIN_TOKEN_ENTERPRISEDEV"` to the script along
with the Enterprise Core URL.

This setup needs no separate report-only credential. Admin credentials never
belong in the mobile manifest.

Report artifacts are not public. Slack notification delivery remains optional
and unconfigured by this reference setup; report filing and retrieval work
without Slack or consumer analytics (`telemetry: false`).

Before upgrading a deployment that used temporary local attachment storage,
copy its existing `.cloud-v2-storage/core/` contents to the new share. Database
records alone cannot reconstruct attachment bytes lost during earlier restarts.

On iOS, Call listed in `miniapps.managed` with `nativeMeetings: true` is installed
and made available by the workspace policy. It does not require the consumer
experimental toggle. Consumer Call visibility remains unchanged.

Image configuration, module/provider values, manifest rules, endpoints, and
SBOM/provenance verification are defined once in
[private-deployment.md](../../private-deployment.md). This runbook covers the
Azure-specific mirror and lifecycle steps.

The [manifest reference](../../deployment-manifest-reference.md) documents all
fields, defaults, validation rules, and how phones adopt manifest changes.

Use the release identity and Mentra Cloud digest from one coordinated Mentra
release bill of materials. Do not combine a Runtime from one release with a
Mentra App selected from another without explicit compatibility qualification.

## Import an immutable Mentra Cloud image

Mentra provides a digest-pinned source such as:

```text
ghcr.io/mentra-community/mentra-cloud@sha256:<digest>
```

Verify its signed provenance and SBOM as described in the common contract, then
import and verify it:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/import-runtime-image.sh \
  <customer-acr-name> \
  ghcr.io/mentra-community/mentra-cloud@sha256:<digest> \
  <release-identity>
```

The helper refuses a mutable source tag and prints the customer-owned
digest-pinned image reference on stdout (progress goes to stderr). Use that
printed reference as `cloudImage` in the Bicep deployment.

`az acr import` runs as the identity signed into the Azure CLI, not as a
registry-side import identity. That identity needs a role on the target
registry that includes `Microsoft.ContainerRegistry/registries/importImage/action`
(Contributor, or a custom role) and must be able to pull the source. The
public GHCR package requires no source credentials. For a private source
registry (an offline-transferred mirror, or GHCR before the package is public),
export `SOURCE_REGISTRY_USERNAME` and `SOURCE_REGISTRY_PASSWORD` in the shell
before running the helper; it forwards them to `az acr import` and never
accepts credentials as positional arguments.

If the customer uses its own legal, logo, or managed miniapp files, replace the
reference files, add the ZIPs, and build the small asset layer on top of the
imported digest instead of rebuilding MentraOS:

```bash
az acr build \
  --registry <customer-acr-name> \
  --build-arg MENTRA_CLOUD_IMAGE=<imported-image@sha256:digest> \
  --image mentra-cloud-enterprise:<release-identity>-customer \
  --file cloud-v2/deploy/azure/enterprise-reference/Dockerfile.customer-assets \
  .
```

Resolve and record the derived image's digest, then pass that digest—not its
mutable tag—to `cloudImage`.

If the customer cannot allow registry-to-registry transfer, Mentra may export
the same OCI image through the customer's approved offline artifact-transfer
process. The customer must verify the OCI digest before importing it. That
delivery path changes transport, not the deployment manifest or image identity.

## Customer configuration checklist

Record and approve these values before deployment:

- Azure subscription, resource group, region, and ACS data location (guided
  setup derives the data location from the region);
- workspace hostname (a subdomain) and DNS ownership;
- Entra tenant, Core API client id, and Mobile application client id;
- the Android/iOS Mentra App distribution channels and matching redirect URIs;
- employee/group assignment, administrator consent, MFA, and Conditional Access;
- persistent Mongo, refresh pepper, access/Runtime signing key, miniapp signing
  key, backup, and rotation ownership;
- approved SYSTEM miniapps and glasses models;
- customer-managed userland miniapp package, version, URL, and SHA-256 pins;
- privacy, terms, documentation, support, logo, and wallpaper assets;
- required and recommended Mentra App version floors;
- telemetry choice; and
- allowed workspace, Microsoft Entra, ACS, and Teams egress destinations.

The Bicep template parameterizes the identifiers, naming, region, ACS data
location, legal/support URLs, SYSTEM allowlist, userland managed list, glasses
allowlist, version policy, and telemetry. The reference logo and same-origin
legal files are image assets; replace them in a customer-derived image or place
equivalent routes behind the customer workspace ingress.

Signing keys, the refresh pepper, the administrator key and the optional Graph
client secret live in the deployment's purge-protected Key Vault. Setup creates
the keys there once; nothing secret is stored in the setup folder. Deleted
secrets stay recoverable for 90 days and cannot be purged.

- Replacing a signing key or the refresh pepper is a deliberate rotation that
  signs every employee out; setup never does it for a running Core.
- The administrator key is rotated with Mentra support (see
  [reports](#reports-and-durable-attachments)); never store a new
  `mentra-admin-key` value by hand.
- The Graph client secret that setup creates expires after 2 years; setup
  prints the date. Add a new client secret to the meetings app in Entra and run
  `setup.sh configure-teams`, which asks for it (hidden), or pipe it in with
  `setup.sh configure-teams --teams-secret-stdin`. Setup checks the secret with
  a Microsoft sign-in before storing it as a new version of
  `teams-graph-client-secret-<client ID>`.

## Customer-managed userland miniapps

`systemMiniapps` applies only to miniapps embedded in the Mentra App. Separately,
`miniapps.managed` installs customer-provided userland ZIPs:

```json
{
  "miniapps": {
    "managed": [
      {
        "packageName": "com.example.remoteassist",
        "version": "1.2.0",
        "bundleUrl": "https://workspace.example/miniapps/remoteassist-1.2.0.zip",
        "sha256": "<64 lowercase hex characters>"
      }
    ]
  }
}
```

Publish the ZIP through the same workspace origin, then calculate the digest
with `shasum -a 256 <zip>`. The package name and version inside `miniapp.json`
must match the entry. A changed ZIP requires a new version; changing only the
digest for an existing version is rejected. The Mentra App activates a new
version only after download, digest, package, and version verification succeeds.
It then removes the prior version owned by that deployment. Removing the entry
from the manifest removes that deployment-owned install. Unrelated local and
SYSTEM installs are never adopted or deleted.

In v1, the Mentra App resolves the remote manifest when the workspace is
selected and then uses that validated snapshot on later boots. To apply a
changed managed list, the employee uses the workspace-change flow and selects
the same workspace again. Automatic background manifest refresh is a later
delivery feature; Runtime minimum-version policy remains live and independent.

The reference Mentra Cloud image does not contain customer miniapp ZIPs. Put them in
`cloud-v2/deploy/azure/enterprise-reference/miniapps/` when producing the
customer-derived Mentra Cloud image, or provide the same path through a
customer-owned ingress. Runtime verifies every image-bundled ZIP against the
manifest at startup and serves its declared `/miniapps/*` path with immutable
cache headers. A missing or mismatched bundle prevents Runtime startup. Keep the
final customer image pinned by its own digest.

When a customer ingress serves the paths instead, deploy with
`managedMiniappDirectory=''` so Runtime does not also require image-bundled
files.

## Packaged installer upgrade

Run the install command again. It downloads the channel's newer release next
to the current one and starts that package's guided setup. The deployment keeps
running the current release until the operator confirms. Setup:

1. finds the package the deployment runs under `~/mentra-install/packages`
   (or `--previous-package PATH`), and refuses a package older than it and a
   deployment that has not finished setup;
2. shows Azure's `what-if` preview of the change;
3. prints how data is protected: signing keys stay in Key Vault; Azure backs up
   Cosmos DB every 4 hours (restored through an Azure support request), so export
   the database with your own tools for a restore point you control; and
   the report share is snapshotted with
   `az storage share-rm snapshot --resource-group <rg> --name core-attachments --storage-account <account>`;
4. asks **Have you backed up the database and report files, and are you ready
   to upgrade?** (`--backup-confirmed` for automation);
5. selects the new release pins, rolls out, verifies, and points
   `~/mentra-install/mentra-private-cloud` at the new package.

The same flow runs with `./packages/NEW_VERSION/mentra-private-cloud/setup.sh upgrade`.
If it is interrupted, rerunning the install command picks the package the saved
state requires and continues.

Upgrade preserves the tenant/subscription, resource names, hostname, Entra
registrations, administrator allowlist and secrets. It snapshots the exact
original config/state and journals the release-pin change before publishing.
An interruption continues from the target package. A changed image under the
same release identity and a semantic release downgrade are refused. Updating
only installer code under the same image release is permitted. Selecting the
new release and rolling it out happen in the same run. Deployments made by
pre-release installers that kept their keys outside Key Vault cannot be
upgraded; install a new deployment instead.

Keep both image digests and packages. Test employee sign-in, Call creation and
joining, and report/attachment retrieval after rollout. Do not manually edit
saved release hashes to bypass these checks. A database migration can make an
image rollback unsafe; recover using the qualified database/files sequence.

## Packaged installer setup folder, start over and uninstall

`~/mentra-install/mentra-state` holds the deployment's non-secret configuration
and progress. It is not disposable: keep Cloud Shell's storage mounted. If it is
lost, run the install command again with the same subscription and deployment
name; setup finds the deployment from its resource group tags and the last
`mentra-private` deployment's settings and continues it (see
[customer-setup.md](./customer-setup.md#guided-setup)).

To start over or uninstall, delete:

1. the resource group (`rg-<deployment>` by default);
2. the Entra app registrations `<Company> Mentra Core (<deployment name>)`, `<Company> Mentra Mobile (<deployment name>)`
   and, if setup created it, `<Company> Mentra Meetings (<deployment name>)`; and
3. `~/mentra-install/mentra-state`.

Deleting the resource group soft-deletes its Key Vault, which purge protection
keeps for 90 days. A new installation gets a new installer owner ID, and with it
new registry, ACS and Key Vault names, so the deleted vault does not block it.
When `deploy.sh` deploys into a resource group whose vault was deleted together
with it (same vault name, same group), it recovers that vault and its signing
keys. A vault name held by a deleted vault in another resource group is refused:
start over with a different deployment name.

## Standalone deployment upgrade

1. Save the currently deployed Mentra Cloud digest and Bicep parameter set.
2. Import the new coordinated Mentra Cloud by digest.
3. Review manifest/configuration changes and keep the old image in the registry.
4. Deploy `main.bicep` with the new digest-pinned `cloudImage`.
5. Run the smoke test:

   ```bash
   cloud-v2/deploy/azure/enterprise-reference/scripts/smoke-test.sh \
     https://<customer-workspace>
   ```

6. Test assigned and unassigned sign-in, silent renewal, and an end-to-end Teams
   call before broad rollout.

## Rollback

Redeploy both Core and Runtime with the previous Bicep parameters and saved
image digest, then rerun the smoke test and sign-in/call checks. Do not roll
back only one service if the token, manifest, or mobile contract requires a coordinated
rollback; use the matching prior coordinated release set.

Managed miniapps roll forward independently through their manifest version and
digest. If a new userland bundle fails before activation, the prior version
remains active. To roll back an already activated bundle, publish the known-good
content under a new semantic version and update the manifest; versions are
immutable.

Installation provenance is stored separately from session data so logout retains
ownership alongside the bundle files. Older missing metadata is recovered only
through verified comparison, never by trusting a version number.

Workspace changes and logout cancel pending managed downloads. Installation and
ownership cleanup run in sequence, so a late download cannot remove another
workspace's release. An unzip already committing finishes and records ownership
before the next workspace cleans it up. Consumer registry downloads also stop
installing when their deployment changes.

If the same Call version is already installed from the consumer deployment, the
host downloads and verifies the workspace ZIP, compares the complete extracted
file tree, and adopts the existing release only when every file matches. It does
not overwrite a differing or foreign-owned same-version release. A failed check
keeps Call hidden in the workspace and preserves the consumer files. Returning
to the consumer deployment removes workspace ownership before restoring bundled
miniapps.
