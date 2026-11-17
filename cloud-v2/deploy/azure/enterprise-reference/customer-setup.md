# Mentra Private Deployment customer setup

Start with the [cloud-neutral contract](../../private-deployment.md). This runbook
applies it to Azure Container Apps, Entra, ACS, and ACR, with Core's data in a
MongoDB database the company provides (see [The database](#the-database)).

## The database

Core keeps its data in MongoDB, and needs a **MongoDB 8.0 replica set with
transactions**: workspace changes are transactions across collections. Setup
creates no database. The company provides one and gives setup its connection
string, which setup stores in the deployment's Key Vault as `mongo-url`; only
Core reads it. The connection string names the database after the host, for
example `mongodb+srv://USER:PASSWORD@cluster0.example.mongodb.net/mentra-private?retryWrites=true&w=majority`.

- **Recommended: MongoDB Atlas on Azure.** Create an Atlas organization from
  the Azure portal or Marketplace (MongoDB Atlas, an Azure Native Integration),
  so Atlas is billed through the Azure subscription, then create a dedicated
  cluster (M30 or above for production; M10 for a trial) on MongoDB 8.0, in the
  same Azure region as the deployment. Core reaches it only through a private
  endpoint ([below](#connecting-atlas-privately)), and the Atlas IP access list
  stays empty, so the database is never reachable from the internet. Create a
  database user for Core with `readWrite` on its database only. Atlas runs in
  MongoDB's Azure account, in the region you choose, and backs it up (Cloud
  Backup with point-in-time restore, configured in Atlas).
- **Allowed: a MongoDB replica set you run**, MongoDB 8.0 with at least three
  members, on Azure Kubernetes Service or virtual machines. Backups, upgrades,
  monitoring and its network are yours: connect it to the deployment's network
  (`vnet-<deployment>`) with VNet peering or a private endpoint of your own. Azure Container Apps is not suitable for
  a database: it has no stable storage or member identity for a replica set.
- **Not supported: Azure Cosmos DB for MongoDB (RU or vCore) and Azure
  DocumentDB.** They implement part of MongoDB's API, and Core is built and
  tested against MongoDB itself. Mentra runs and tests one database everywhere,
  rather than working around each compatible service's differences.

### Creating MongoDB Atlas on Azure

These are the steps Mentra ran for its own reference stack.

1. In the Azure portal, create **MongoDB Atlas – An Azure Native Integration**
   (Marketplace offer `mongodb_atlas_azure_native_prod`, plan "Pay as You Go",
   monthly term). Fill in the subscription, resource group, resource name,
   region (the deployment's region; Mentra's is West US 2) and a name for a new
   Atlas organization, which is linked to that subscription for billing. The
   price shown is $0.00 up front plus metered usage: the clusters are what cost
   money.
2. **Create** accepts MongoDB's and Microsoft's terms, authorizes Microsoft to
   bill the subscription's payment method monthly, and shares the creator's
   contact details with MongoDB. The deployment takes about 2.5 minutes.
3. On the new resource, **Go to MongoDB Atlas** creates an Atlas login for the
   signed-in Azure user's email address and emails it a link to set a password.
   Do this as an Azure user whose address receives mail: a
   `*.onmicrosoft.com` user with no mailbox gets no email and cannot get into
   the organization, and this flow cannot change the address.
4. If that already happened, invite a person with a real mailbox as a guest in
   the tenant, give them Contributor on the Atlas resource's resource group, and
   have them click **Go to MongoDB Atlas** while signed in to Azure. Atlas links
   their Atlas login, existing or new, to the organization. With the tenant's
   security defaults on, the guest first enrolls multi-factor sign-in.

Create the Atlas resource as an Azure user who already has a working mailbox.
MongoDB sends its first email the moment the resource is created, and once an
address bounces MongoDB suppresses it: no later email reaches it, and Mentra had
to start over with another user.

### Connecting Atlas privately

Every new deployment's Container Apps environment is created in its own virtual
network, `vnet-<deployment>` (`network.bicep`): a `/23` subnet for the
environment and a `/27` for private endpoints, in `10.40.0.0/16`. Core reaches
Atlas through an Azure private endpoint in that network, which Atlas accepts
only once it is registered there. The apps stay public. Atlas's private
hostnames are public DNS records that resolve to the endpoint's private IP, so
no private DNS zone is needed.

1. In the Atlas project, create the Azure private endpoint service in the
   deployment's region (with the Atlas CLI, signed in with `atlas auth login`):
   `atlas privateEndpoints azure create --region US_WEST_2 --projectId PROJECT_ID`.
   After a minute or two, `atlas privateEndpoints azure describe SERVICE_ID
   --projectId PROJECT_ID --output json` shows `privateLinkServiceResourceId`.
   In the Atlas UI this is **Network Access → Private Endpoint → Dedicated
   Cluster → Add Private Endpoint → Azure**.
2. Give setup that resource ID when it asks for the Atlas private endpoint
   service (`atlasPrivateLinkServiceId` in `--config`). Setup creates the
   network and the endpoint with the registry and Key Vault.
3. Before deploying Core, setup prints the one Atlas command that registers the
   endpoint, with its resource ID and private IP:
   `atlas privateEndpoints azure interfaces create SERVICE_ID --projectId
   PROJECT_ID --privateEndpointId ... --privateEndpointIpAddress ...`. In the
   Atlas UI, the same two values go in the last step of the private endpoint
   dialog. Atlas shows the endpoint as available within a few minutes.
4. In Atlas, **Connect → Private Endpoint** gives the cluster's private
   connection string (`mongodb+srv://...-pl-0...mongodb.net`). Add the
   database name after the host and give it to setup, which stores it as
   `mongo-url`.

Cost: Azure bills the private endpoint about $7 a month ($0.01 an hour) plus
$0.01 per GB through it; Atlas bills $0.03 per GB through Private Link. The
cluster is the main cost (an M10 is about $60 a month, an M30 about $400).

A Container Apps environment cannot be moved into a network, so a deployment
created before the network (with no `virtualNetworkName` in its configuration)
keeps its environment outside one, and setup does not move it. Moving it means
creating the environment again in a network, with Core offline meanwhile; ask
Mentra before doing so.

To set or change the connection string, run setup again with
`--mongo-url-stdin` and the string on standard input; guided setup asks for it
when Key Vault has none. Core reads a changed one within about 30 minutes, when
Container Apps refreshes its Key Vault references, or at its next restart.

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
- The admin portal, built into the image and served by Core on Core's host. Its sign-in
  uses a client secret of the Core API app that setup creates directly in Key Vault.
- Deployment manifest/branding/legal configuration.
- Smoke tests and digest-based upgrade/rollback instructions.

## Information and approvals

Collect and approve:

- Azure subscription, resource group, region, and ACS data location (the guided installer
  derives it from the region: Europe for European regions; UK, Canada, Brazil, Australia, Japan,
  Korea, India, UAE, Africa or Asia Pacific for regions there; United States otherwise);
- workspace DNS name (a subdomain);
- Entra tenant, Core API client id, and Mobile client id;
- the email domains your Entra directory issues, each subdomain listed separately, and
  the Organization Admins who sign in to the admin portal;
- assigned employees/groups, admin consent, MFA, and Conditional Access;
- official Android/iOS distribution channels and redirect URIs;
- the MongoDB database (see [The database](#the-database)) and its backup policy, and the
  signing-key, refresh-pepper and rotation policy;
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

1. Asks eight questions: subscription, tenant, company name, deployment name,
   region, an optional custom web address, the Atlas private endpoint service
   (see [Connecting Atlas privately](#connecting-atlas-privately); empty for
   another database), and the email domains your Entra directory issues. An invalid answer is explained and asked again. A region
   such as `West US 2` and a pasted `https://mentra.example.com/` are accepted;
   a custom address must be a subdomain. Email domains are comma-separated,
   lowercase, each subdomain listed separately, and never a Mentra domain; see
   [email domains](./entra-setup.md#email-domains).
2. Checks the subscription: that the login can use it, the resource providers
   (offering to register missing ones), the tools, the tenant, and that
   `rg-<deployment>` is not someone else's resource group.
3. Creates the empty resource group and prints Azure's what-if preview,
   naming the Entra apps `<Company> Mentra Core (<deployment name>)` and `<Company> Mentra Mobile (<deployment name>)`.
   When the operator holds no built-in role that can consent to them, it says so here.
   It asks one confirmation. Declining deletes the empty group, so nothing is
   created.
4. Only after that confirmation, creates the two Entra apps
   (`configure-entra.sh --installer-owner`), grants tenant-wide consent or
   prints the administrator message for it, and assigns the employees or groups
   the operator names (`--employees`).
5. Installs with progress lines. Before Core is deployed it asks for the
   database's connection string when Key Vault has none (hidden as it is typed,
   stored only in Key Vault), first printing the Atlas command that registers
   the private endpoint when there is one, adds a client secret
   to the Core app for admin portal sign-in, stores it in Key Vault and turns on
   `adminPortalSignIn` in the saved configuration. It
   handles DNS (adds the two records when the zone is in Azure DNS in the
   subscription, otherwise prints them and saves `dns-records.json`), verifies,
   registers the admin portal's redirect URI on the Core app, creates the
   administrator key, and offers Teams meeting creation.

The final summary prints the workspace (with a note that employees cannot sign
in yet while consent is missing), the admin portal address
(`https://<core host>/`) and its client secret's expiry date, the
`az keyvault secret show` command for the administrator key, a `curl` command
for `<core>/api/admin/reports` using that key, and every pending administrator
step as a `Still to do` line:

- **Sign-in apps.** When the operator cannot create Entra apps, setup prints
  the exact command for an Application Administrator or Cloud Application
  Administrator, who downloads the installer with `MENTRA_START=0` and runs:

  ```bash
  ~/mentra-install/mentra-private-cloud/scripts/configure-entra.sh \
    --core-name "<Company> Mentra Core (<deployment name>)" --mobile-name "<Company> Mentra Mobile (<deployment name>)" \
    --installer-owner <owner> --core-owner <operator object ID> --grant-admin-consent
  ```

  `--core-owner` lets the operator's setup manage the Core app's admin portal
  sign-in. The operator records the two printed IDs, then runs setup again. This
  command only checks that both are single-tenant apps in the tenant:

  ```bash
  ~/mentra-install/mentra-private-cloud/setup.sh configure-entra \
    --core-client-id CORE_ID --mobile-client-id MOBILE_ID
  ```
- **Admin consent.** Employees cannot sign in until a Global Administrator,
  Privileged Role Administrator, Cloud Application Administrator or Application
  Administrator selects **Grant admin consent** on the Mobile and Core apps' API
  permissions pages. Setup prints this message right after creating the apps,
  so the install continues while the administrator approves. While consent is
  missing, the summary says employees cannot sign in yet, and an interactive
  run then waits for the approval. Setup rechecks consent on every run and
  keeps the line until it is granted.
- **Admin portal sign-in.** When setup cannot register the portal's redirect
  URI on the Core app, an Application Administrator or Cloud Application
  Administrator runs the printed `configure-entra.sh --admin-portal-only`
  command (see [admin portal sign-in](./entra-setup.md#admin-portal-sign-in)).
  The line also appears when the deployment has no email domains, with the
  `--email-domains` command that sets them.
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

For automation, start from `answers.example.json` (the seven answers, with the
email domains as the `verifiedEmailDomains` list, plus `resourceTags`) and run
`setup.sh --yes --config answers.json --employees EMAIL,GROUP`. Values in angle
brackets are refused. To change the email domains later, run setup with
`--email-domains DOMAIN[,DOMAIN]`; it rolls the change out to Core.
`MENTRA_START=0` downloads without starting setup, which is also the default
without a terminal.

The numbered sections below describe the same steps with the standalone
helpers.

## 1. Configure Entra

Guided setup runs this step itself after the preview is confirmed. Otherwise
follow [entra-setup.md](./entra-setup.md). The helper provisions:

- a single-tenant Core API exposing `mentra.session`, which is also the admin
  portal's sign-in client (the `email` ID token claim, the Microsoft Graph
  `openid`, `email` and `profile` permissions, and the
  `https://<core host>/interaction/callback/workforce` redirect URI, where Entra
  returns people to Core's sign-in server); and
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
signing keys and refresh pepper directly in Key Vault, once. With
`adminPortalSignIn` set to `true` it stops unless Key Vault already holds
`entra-browser-client-secret`, the Core app's client secret for admin portal
sign-in ([store it](./entra-setup.md#admin-portal-sign-in) after
`deploy.sh --bootstrap-only`). `access.bicep` then lets each app read only its
own secrets: Core its keys and, with admin portal sign-in on, that secret;
Runtime the Graph secret. No app can read the administrator key. Finally the helper imports and verifies
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

- one Container Apps environment, in the deployment's virtual network, and
  the private endpoint to Atlas;
- separate Core and meetings-only Runtime apps using the same digest;
- customer-owned ACS;
- a managed identity per app, each able to read only its own Key Vault secrets;
- a purge-protected Key Vault holding the signing keys, refresh pepper,
  admin portal client secret, administrator key, the database's connection
  string and optional Graph client secret;
- a generated deployment manifest; and
- Container App secrets that reference Key Vault, plus the ACS connection
  string derived from its resource.

They create no database: Core uses the company's (see [The database](#the-database)).

For customer production, use the customer's normal backup, private networking,
and secret-management requirements. Core reaches the database only through the
deployment's network ([Connecting Atlas privately](#connecting-atlas-privately));
Key Vault and report storage keep authenticated public endpoints. Nothing here
connects to Mentra.

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
- admin portal sign-in at `https://<core host>/` as an Organization Admin, and
  refusal for anyone else;
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
