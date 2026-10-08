# Mentra Private Deployment customer setup

Start with the [cloud-neutral contract](../../private-deployment.md). This runbook
applies it to Azure Container Apps, Cosmos DB's Mongo-compatible API, Entra,
ACS, and ACR.

## Customer delivery package

- Official signed Mentra App through the customer's Android/iOS channel.
- Public `mentra-cloud` image pinned by digest, with signed provenance and SBOM.
- Stable per-channel install command, `curl -fsSLo mentra-install.sh https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/private-cloud/<channel>/install.sh && bash mentra-install.sh`.
  It downloads before running so a failed download exits nonzero (`curl | bash` would report success).
  It reads that channel's `latest.json`, verifies the installer archive's SHA-256 and unpacks it into
  `~/mentra-install/packages/<version>/`, linked as `~/mentra-install/mentra-private-cloud`. Set
  `MENTRA_VERSION` to install an exact release, or `MENTRA_START=0` to download without starting
  setup. CI advances the dev pointer only after the reference Azure stack deploys and verifies that
  release; pointers never move backwards.
- The guided installer (`setup.sh`) and `answers.example.json` for unattended runs.
- `bootstrap.bicep`, `access.bicep` and `main.bicep`.
- Idempotent `configure-entra.sh` helper and administrator review steps.
- Signing keys and the refresh pepper, created directly in the deployment's Key Vault
  (`scripts/ensure-vault-secrets.sh`); they are never exported or written to the setup folder.
- Deployment manifest/branding/legal configuration.
- Smoke tests and digest-based upgrade/rollback instructions.

## Information and approvals

Collect and approve:

- Azure subscription, resource group, region, and ACS data location (the guided installer
  derives it from the region: Europe for European regions; UK, Canada, Brazil, Australia, Japan,
  Korea, India, UAE, Africa or Asia Pacific for regions there; United States otherwise);
- workspace DNS name (a subdomain);
- Entra tenant, Core API client id, and Mobile client id;
- assigned employees/groups, admin consent, MFA, and Conditional Access;
- official Android/iOS distribution channels and redirect URIs;
- persistent database, signing-key, refresh-pepper, backup, and rotation policy (Cosmos DB
  uses Azure's periodic backup: every 4 hours, two copies kept, restored through an Azure
  support request);
- SYSTEM miniapp/glasses allowlists and managed userland miniapps;
- branding, privacy, terms, support, wallpapers, and version policy;
- telemetry policy; and
- customer-approved workspace, Core, Microsoft, ACS, and Teams egress.

Tenant ids, client ids, scopes, certificate fingerprints, and URLs are public
identifiers. Database credentials, private keys, peppers, connection strings,
and bearer tokens are secrets.

## Guided setup

Customers run the published install command in Azure Cloud Shell (Bash) with
its storage mounted. It verifies and unpacks the package, then starts
`setup.sh` with no command. Running the same command again continues an
interrupted install, finishes after a handoff, or upgrades. Guided setup:

1. Asks six questions: subscription, tenant, company name, deployment name,
   region and an optional custom web address. An invalid answer is explained
   and asked again. A region such as `West US 2` and a pasted
   `https://mentra.example.com/` are accepted; a custom address must be a
   subdomain.
2. Checks the subscription: that the login can use it, the resource providers
   (offering to register missing ones), the tools, the tenant, and that
   `rg-<deployment>` is not someone else's resource group.
3. Creates the empty resource group and prints Azure's what-if preview,
   naming the Entra apps `<Company> Mentra Core (<deployment name>)` and `<Company> Mentra Mobile (<deployment name>)`.
   It asks one confirmation. Declining deletes the empty group, so nothing is
   created.
4. Only after that confirmation, creates the two Entra apps
   (`configure-entra.sh --installer-owner`), offers tenant-wide consent, and
   assigns the employees or groups the operator names (`--employees`).
5. Installs with progress lines, handles DNS (adds the two records when the
   zone is in Azure DNS in the subscription, otherwise prints them and saves
   `dns-records.json`), verifies, creates the administrator key, and offers
   Teams meeting creation.

The final summary prints the workspace, the `az keyvault secret show` command
for the administrator key, a `curl` command for `<core>/api/admin/reports`
using that key, and every pending administrator step as a `Still to do` line:

- **Sign-in apps.** When the operator cannot create Entra apps, setup prints
  the exact command for an Application Administrator or Cloud Application
  Administrator, who downloads the installer with `MENTRA_START=0` and runs:

  ```bash
  ~/mentra-install/mentra-private-cloud/scripts/configure-entra.sh \
    --core-name "<Company> Mentra Core (<deployment name>)" --mobile-name "<Company> Mentra Mobile (<deployment name>)" \
    --installer-owner <owner> --grant-admin-consent
  ```

  The operator records the two printed IDs, then runs setup again. This
  command only checks that both are single-tenant apps in the tenant:

  ```bash
  ~/mentra-install/mentra-private-cloud/setup.sh configure-entra \
    --core-client-id CORE_ID --mobile-client-id MOBILE_ID
  ```
- **Admin consent.** A Global Administrator, Privileged Role Administrator or
  Cloud Application Administrator selects **Grant admin consent** on the Mobile
  app's API permissions page. Setup rechecks consent on every run and keeps
  the line until it is granted.
- **Employee access**, **DNS records**, and the meetings app's **Graph
  permission** (Global Administrator or Privileged Role Administrator).

The setup folder `~/mentra-install/mentra-state` holds no secrets but is not
disposable: it is the deployment's saved configuration and progress, so keep
Cloud Shell's storage mounted rather than using an ephemeral session. If it is
lost, the operator runs the install command again with the same subscription
and deployment name. Setup finds the resource group by its
`mentraDeploymentId`/`mentraInstallerOwner` tags, restores the owner ID and the
settings of the last `mentra-private` deployment, asks to continue, and asks
for backup confirmation first if that deployment runs another release.

Cloud Shell disconnects after 20 minutes without interaction. That is expected:
reopen it and run the same command. `deploy.sh` waits (up to 30 minutes) for a
deployment of the same name that is still running, then continues.

For automation, start from `answers.example.json` (the six answers plus
`resourceTags`) and run `setup.sh --yes --config answers.json --employees
EMAIL,GROUP`. Values in angle brackets are refused. `MENTRA_START=0` downloads
without starting setup, which is also the default without a terminal.

The numbered sections below describe the same steps with the standalone
helpers.

## 1. Configure Entra

Guided setup runs this step itself after the preview is confirmed. Otherwise
follow [entra-setup.md](./entra-setup.md). The helper provisions:

- a single-tenant Core API exposing `mentra.session`; and
- an assignment-required public Mobile client with Core and ACS delegated
  permissions and official binary redirects.

The employee signs in once. Customer Core exchanges the Entra token for a
Mentra session; Runtime accepts only Core-issued Runtime tokens. The same MSAL
account can separately supply the employee's ACS token.

## Check Teams prerequisites

From `~/mentra-install`, initialize the packaged installer first with `./mentra-private-cloud/setup.sh init --directory ./mentra-state`, then run `./mentra-private-cloud/setup.sh check-teams --directory ./mentra-state --teams-user EMPLOYEE_OBJECT_ID` before deployment. Installation verification also checks when the operator can read Entra license inventory. An Azure resource administrator without that permission receives an Entra-admin handoff; access failure is not classified as a missing license.

The check identifies enabled Teams subscriptions and provisioned Teams service plans for the employee and configured customer guest organizer. If missing, it directs Microsoft 365 administrators to purchase a plan **including Teams**, assign it under Users → Active users → Licenses and apps, and wait for provisioning. Business Basic without Teams is insufficient. An unlicensed employee can join as a guest, but creating guest meetings requires a licensed customer-owned organizer. License inventory alone does not verify Graph consent or Teams policy. See [meeting creation](./entra-setup.md#meeting-creation) for those separate steps.

## 2. Deploy the image and infrastructure

Copy the complete public configuration example and replace every placeholder:

```bash
cp cloud-v2/deploy/azure/enterprise-reference/deployment.config.example.json \
  /secure/path/mentra-private.config.json
```

Nothing secret goes in this file or on disk. Validate it, preview the Azure
changes with Azure's own `what-if`, then deploy:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh --validate-only /secure/path/mentra-private.config.json
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh --what-if /secure/path/mentra-private.config.json
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh /secure/path/mentra-private.config.json
```

The deployment helper runs `bootstrap.bicep` (registry, one managed identity per
app, purge-protected Key Vault; needs Owner or User Access Administrator). It
grants whoever runs it Key Vault Secrets Officer on that vault and creates the
signing keys and refresh pepper directly in Key Vault, once. `access.bicep` then
lets each app read only its own secrets: Core its keys, Runtime the Graph secret.
No app can read the administrator key. Finally the helper imports and verifies
the release digest, deploys `main.bicep` (Contributor is enough) and runs the
smoke test. A deployed Core is never given
new keys: if Key Vault is missing one, the helper refuses and points to
`az keyvault secret recover`.

The helper is safe to rerun. It waits for a still-running deployment of the
same name instead of failing, recovers a Key Vault that was deleted together
with this resource group, and refuses a vault name held by a deleted vault in
another resource group. It retries the main deployment, for up to about ten
minutes, only while new Key Vault access is still reaching Container Apps.

The templates create:

- one Container Apps environment;
- separate Core and meetings-only Runtime apps using the same digest;
- Cosmos DB with MongoDB-compatible API for Core identity/session state, with Azure's
  periodic backup (continuous backup is not used: on API for MongoDB it forbids the unique
  indexes Core creates);
- customer-owned ACS;
- a managed identity per app, each able to read only its own Key Vault secrets;
- a purge-protected Key Vault holding the signing keys, refresh pepper,
  administrator key and optional Graph client secret;
- a generated deployment manifest; and
- Container App secrets that reference Key Vault, plus ACS and Mongo
  connection strings derived from their resources.

For customer production, use the customer's normal database, backup, private
networking, and secret-management requirements. The template's public network
Cosmos endpoint is an authenticated, customer-owned reference starting point,
not a universal production network posture. It never connects to Mentra, but a
customer requiring private data-plane ingress should supply its approved Mongo
deployment or extend the reference with its standard VNet/private-endpoint
module before qualification.

Replace the reference legal documents and light/dark transparent PNGs. Managed
miniapp ZIPs may be added as an asset layer or served by customer ingress; each
manifest entry pins package name, semantic version, URL, and SHA-256.

For a custom hostname, deploy once with `workspaceHostname` empty. Read
`generatedRuntimeHostname` and `customDomainVerificationId` from the printed
deployment outputs. Create a DNS-only CNAME from the workspace hostname to the
generated Runtime hostname and a TXT record named `asuid.<workspace-hostname>`
whose value is `customDomainVerificationId`. Set `workspaceHostname` in the
configuration file and run the same deployment command again.

Use a subdomain for the workspace hostname. An apex domain cannot be a CNAME
target; it needs an A record to the environment's static inbound IP and TXT or
HTTP domain-control validation, which the reference template does not
configure (its managed certificate uses CNAME validation only).

## 3. Verify the manifest

Use the [manifest reference](../../deployment-manifest-reference.md) for the
complete field contract, examples, defaults, and validation rules.

Confirm:

- `services.coreUrl` is the customer's Core and `services.runtimeUrl` is the
  workspace Runtime;
- the exact Entra authority, Mobile client id, and Core `mentra.session` scope;
- branding/legal URLs and customer policy values;
- only approved SYSTEM miniapps, managed userland miniapps, and glasses;
- `nativeMeetings: true`, with unneeded capabilities false; and
- the approved telemetry value.

`miniapps.configuration` is optional non-secret configuration scoped by package
name. It does not install a bundle. `miniapps.managed` installs/removes
deployment-owned userland bundles and does not refer to SYSTEM miniapps.

## 4. Distribute and qualify

Distribute the ordinary signed Mentra App through MDM, Play, App Store/Apple
Business Manager, or another approved channel. V1 users enter the workspace
origin through **Connect to organization**; later MDM enrollment can supply the
same origin without changing the manifest or auth contract.

Before pilot use verify:

- assigned sign-in on Android and iOS;
- unassigned, wrong-tenant, wrong-audience, and wrong-client rejection;
- MFA/Conditional Access return;
- silent Core refresh, relaunch, logout, and workspace switching;
- Core and Runtime health/readiness plus Core JWKS;
- manifest, legal, logos, and minimum-version policy;
- ACS token exchange bound to the same Entra employee; and
- restricted-network traffic contains no Mentra consumer infrastructure when
  telemetry is disabled.

The complete glasses-to-Teams media path is qualified after the matching native
ACS implementation is integrated; this stack does not fake that media path.
