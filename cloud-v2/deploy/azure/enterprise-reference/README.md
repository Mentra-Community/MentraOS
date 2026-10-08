# Mentra Private Deployment Azure reference

This directory is Mentra's non-production, customer-shaped reference stack. The
cloud-neutral image and configuration contract is in
[private-deployment.md](../../private-deployment.md). The Azure template starts the
same immutable Mentra Cloud image as two Container Apps:

- customer Core with Cosmos DB for MongoDB-compatible persistence and Azure Files for durable report attachments; and
- meetings-only Runtime with the `acs-teams` provider.

It also creates ACS, a Container Apps environment, per-app identities, managed TLS
for the workspace hostname, and the served deployment manifest. The Runtime
profile does not start Redis, UDP, cloud audio, camera, Cloudflare, speech,
maps, Store, or reporting dependencies.

Core's report API is available independently of Runtime and consumer telemetry.
See [report setup and retrieval](operations.md#reports-and-durable-attachments)
for existing admin org API-key authorization and the attachment-storage lifecycle.

The Enterprise Demo manifest enables the built-in Give Feedback miniapp alongside
Settings. Reports go to the selected Enterprise Core, including phone logs and
screenshots for bug reports. The confirmation provides a copyable report ID.
Re-select the workspace to refresh a previously cached manifest; Settings → Give
Feedback also opens the same form.

## Reference identities

- Tenant: `2e7662c0-e826-4928-95b2-60bdd48d5d95`
- Mobile public client: `95ad08c2-7837-4ddf-933c-1fce3d6d2799`
- Core API: `20424d9e-4b99-44e8-82c9-0ad06f08a8db`
- Core scope: `api://20424d9e-4b99-44e8-82c9-0ad06f08a8db/mentra.session`
- Workspace: `https://mentra.acmeworkspace.com`

The demo workspace is branded **Acme Industries**. The original
`https://enterprisedev.mentraglass.com` remains an HTTPS alias for existing
installs. Both addresses serve the same deployment, with discovery URLs matching
the address used to enroll. The deployment ID, Core origin, Entra tenant, and existing sessions
are preserved. `acmeworkspace.com` is also verified as an Entra sign-in domain;
demo employee accounts still require their own assignment and Teams license.

The Mobile enterprise application is assignment-required. Its public-client
redirects cover iOS, the Mentra-signed Android APK, and Google Play signing.
The current assigned pilot users are managed in Entra, not in Mentra.

Use:

- [deployment-manifest-reference.md](../../deployment-manifest-reference.md) for every manifest field and a complete customer example;
- [entra-setup.md](./entra-setup.md) for identity setup;
- [customer-setup.md](./customer-setup.md) for delivery and qualification; and
- [operations.md](./operations.md) for image import, upgrades, and rollback.

The idempotent Entra helper creates or reconciles the Core API and Mobile app:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/configure-entra.sh \
  --core-name "ACME Mentra Core" \
  --mobile-name "ACME Mentra Mobile"
```

Guided setup runs it with `--installer-owner`, naming the apps
`<Company> Mentra Core (<deployment name>)` and `<Company> Mentra Mobile (<deployment name>)`, and only after the
operator confirms the Azure preview. It never adopts a same-named app it did not
create. An operator without Entra rights gets the exact command for an
Application Administrator or Cloud Application Administrator, then records the
resulting IDs with `setup.sh configure-entra --core-client-id ... --mobile-client-id ...`
(see [entra-setup.md](./entra-setup.md#guided-setup)).

## Coordinated reference deployment

The `dev` coordinated release:

1. builds `ghcr.io/mentra-community/mentra-cloud` from the exact release commit;
2. signs build provenance and an SPDX SBOM;
3. imports that digest into the reference ACR;
4. deploys Core and Runtime from the same imported digest;
5. verifies Core health/readiness/JWKS and Runtime health/readiness/version/
   manifest/legal/branding/auth boundaries; and
6. records both revisions and the immutable digest in release evidence.

Mentra Cloud's existing deployment job is unchanged. The reference stack has no
independent push trigger, so it cannot drift from the coordinated `dev` release.

The `ghcr.io/mentra-community/mentra-cloud` package is public, so customer registries import
releases anonymously; no registry credential is needed.

Signing keys, the refresh pepper and the Graph client secret live in the
stack's Key Vault (`kv-mentra-enterprise-ref`), which `bootstrap.bicep` created
once with Owner rights, together with `access.bicep`'s per-secret grants. Each
Container App reads only its own secrets with its own identity, so the
Contributor-only CI deployment passes just the vault name. Customer
deployments get their own vault the same way.

## Customer-shaped deployment

Customers use the packaged guided installer (`setup.sh` with no command; see
`customer-setup.md`). The underlying helper takes one public configuration file
and no secrets:

```bash
cp cloud-v2/deploy/azure/enterprise-reference/deployment.config.example.json \
  /secure/path/mentra-private.config.json
az group create --name rg-acme-mentra --location westus2   # what-if needs the group
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh --what-if /secure/path/mentra-private.config.json
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh /secure/path/mentra-private.config.json
```

It creates the resource group, runs `bootstrap.bicep` (registry, identities, Key
Vault, role assignments), creates the signing keys in Key Vault once, applies
`access.bicep`'s per-secret grants, imports and verifies the digest, deploys
Core and Runtime, runs the smoke test, and prints the deployment outputs. A
rerun waits for a still-running deployment of the same name and recovers a Key
Vault deleted together with the resource group. Replacing signing keys or the
refresh pepper is a deliberate session/key rotation, not an ordinary redeploy;
the administrator key is rotated with Mentra support.

### Teams meeting creation

Guided setup offers this after installation, and `setup.sh configure-teams` adds
it later. It can create the Graph application `<Company> Mentra Meetings (<deployment name>)`
itself, granting `OnlineMeetings.ReadWrite.All` when the operator is a Global
Administrator or Privileged Role Administrator (otherwise it prints the app's
API permissions page). It writes the client secret straight to Key Vault as
`teams-graph-client-secret-<client ID>` (one secret per app, so a new app's ID
and secret take effect together), records `teamsGraphClientId` and `teamsGraphOrganizerId`, rolls the change out,
and prints the Teams PowerShell access-policy commands with the IDs filled in,
also saving them to `mentra-state/teams-policy.ps1`. The secret it creates
expires after 2 years; renew it with `setup.sh configure-teams --teams-secret-stdin`
(or the hidden prompt of `setup.sh configure-teams`).
See [Graph consent and Teams access policy](./entra-setup.md#meeting-creation).
Leaving these inputs empty preserves join-only server behavior; creation returns
a configuration error.

The reference CI deployment reads GitHub variables
`ENTERPRISE_DEV_TEAMS_GRAPH_CLIENT_ID` and `ENTERPRISE_DEV_TEAMS_GRAPH_ORGANIZER_ID`;
its client secret is `teams-graph-client-secret-<client ID>` in the stack's Key
Vault. Only Runtime references it; neither Core nor the deployment manifest receives it.
CI deploys with Contributor only, so it cannot grant or revoke Key Vault access.
To switch the reference stack to another Graph app, an Owner stores the new
app's secret, runs `scripts/deploy.sh` once with the new client ID (it grants
Runtime the new secret and, once the switch is live, revokes the old one), and
then updates `ENTERPRISE_DEV_TEAMS_GRAPH_CLIENT_ID`. Until then CI's deployment
fails because Runtime cannot read the new app's secret.

### Custom hostname

For a custom hostname, first deploy without `workspaceHostname`, create a
DNS-only CNAME to the printed `generatedRuntimeHostname`, and create
`asuid.<workspace-hostname>` as a TXT record whose value is the printed
`customDomainVerificationId`. Then set `workspaceHostname` and rerun the same
helper. The Core reference uses its Azure-generated TLS hostname and is declared
separately in `services.coreUrl`.

When migrating an existing hostname, set `workspaceCertificateName` to a new
managed-certificate resource name; Azure certificates cannot change their subject
in place. To keep existing clients working, include the old binding in
`additionalWorkspaceDomains`, for example:

```json
{
  "workspaceHostname": "mentra.acmeworkspace.com",
  "workspaceCertificateName": "ca-mentra-enterprise-reference-acme-workspace",
  "additionalWorkspaceDomains": [
    {
      "hostname": "enterprisedev.mentraglass.com",
      "certificateName": "ca-mentra-enterprise-reference-workspace"
    }
  ]
}
```

Additional certificates must already exist in the same Container Apps
environment. Preserve their DNS records, and serve the old hostname directly
rather than redirecting API requests. Bicep also configures Runtime's
`DEPLOYMENT_WORKSPACE_ALIASES` as a JSON array of the retained HTTPS origins.
For those explicit hosts, Runtime serves a discovery manifest with Runtime,
branding, and managed-bundle URLs on the requesting origin. Core, Entra identity,
miniapp configuration, bundle versions and hashes remain unchanged. Arbitrary
hosts and forwarded-host headers cannot introduce another manifest origin.
These settings are also accepted by `scripts/deploy.sh`. Upgrade Runtime to a
version supporting the alias setting before changing the canonical manifest.

This procedure supports subdomains only (for example `mentra.acme.example`).
An apex domain cannot carry a CNAME; Azure requires an A record to the
environment's static inbound IP plus TXT or HTTP domain-control validation,
which `main.bicep` (hard-wired to CNAME validation) does not configure. Use a
subdomain, or extend the template before qualifying an apex hostname.

Cosmos DB keeps `publicNetworkAccess: Enabled` in this reference. Core reaches
it over the authenticated public endpoint because the Container Apps
environment has no VNet; disabling public access requires a VNet-integrated
environment and a Cosmos private endpoint, and the Container Apps outbound IPs
are not known before Core exists, so an IP firewall cannot be templated here.
Treat this as a documented tradeoff, not a production network posture; see
[customer-setup.md](./customer-setup.md) for the private-networking guidance.

## Smoke test

```bash
export MENTRA_WORKSPACE=https://mentra.acmeworkspace.com
cloud-v2/deploy/azure/enterprise-reference/scripts/smoke-test.sh "$MENTRA_WORKSPACE"
```

Then enroll the official Mentra App through **Connect to organization**, sign in
as an assigned employee, verify relaunch/refresh/logout/workspace switching, and
check that no Mentra consumer telemetry or services are contacted. Microsoft,
ACS, the customer workspace, and customer Core remain expected egress.

This qualifies private infrastructure and restricted networking; it is not a
literal zero-internet air-gapped profile.

## Mentra Call

The reference manifest (`mentra-deployment.json`) pins the Mentra Call version. Its
ZIP is included in the Runtime image under `miniapps/` and is byte-identical to the Mentra App's bundled ZIP.
The coordinated deployment passes that managed list to Bicep and verifies the
served bundle's SHA-256. `scripts/sync-miniapp.mjs` updates only the Mentra App
copy and generated bundle list. For each Call update, mirror the same ZIP to
`cloud-v2/deploy/azure/enterprise-reference/miniapps/` and update the version,
`bundleUrl`, and SHA-256 pin in `mentra-deployment.json`.

Use the matching Mentra App native build from this change, then re-select the
workspace to refresh an already cached deployment manifest. Call uses the selected
Runtime for credentials and a direct glasses link for media. It prefers the Entra
Teams identity and automatically uses guest mode for an absent identity or a
confirmed missing Teams license; the call screen reports the selected mode.
Existing installed consumer clients continue using the existing Call backend routes.
The new Call bundle requires host meeting-policy discovery; hosts lacking that API
show an update message and cannot send requests to a public Call backend.

Before releasing, qualify licensed and unlicensed joins on both Android and iOS,
including lobby admission, remote identity, two-way audio/video and cancellation.
