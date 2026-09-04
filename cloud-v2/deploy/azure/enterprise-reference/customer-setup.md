# Mentra Private Deployment customer setup

Start with the [cloud-neutral contract](../../private-deployment.md). This runbook
applies it to Azure Container Apps, Cosmos DB's Mongo-compatible API, Entra,
ACS, and ACR.

## Customer delivery package

- Official signed Mentra App through the customer's Android/iOS channel.
- Public `mentra-cloud` image pinned by digest, with signed provenance and SBOM.
- `bootstrap.bicep` and `main.bicep`.
- Idempotent `configure-entra.sh` helper and administrator review steps.
- One-time signing-key/refresh-pepper generator for import into customer secret management.
- Deployment manifest/branding/legal configuration.
- Smoke tests and digest-based upgrade/rollback instructions.

## Information and approvals

Collect and approve:

- Azure subscription, resource group, region, and ACS data location;
- workspace DNS name;
- Entra tenant, Core API client id, and Mobile client id;
- assigned employees/groups, admin consent, MFA, and Conditional Access;
- official Android/iOS distribution channels and redirect URIs;
- persistent database, signing-key, refresh-pepper, backup, and rotation policy;
- SYSTEM miniapp/glasses allowlists and managed userland miniapps;
- branding, privacy, terms, support, wallpapers, and version policy;
- telemetry policy; and
- customer-approved workspace, Core, Microsoft, ACS, and Teams egress.

Tenant ids, client ids, scopes, certificate fingerprints, and URLs are public
identifiers. Database credentials, private keys, peppers, connection strings,
and bearer tokens are secrets.

## 1. Configure Entra

Follow [entra-setup.md](./entra-setup.md). The helper provisions:

- a single-tenant Core API exposing `mentra.session`; and
- an assignment-required public Mobile client with Core and ACS delegated
  permissions and official binary redirects.

The employee signs in once. Customer Core exchanges the Entra token for a
Mentra session; Runtime accepts only Core-issued Runtime tokens. The same MSAL
account can separately supply the employee's ACS token.

## 2. Deploy the image and infrastructure

Copy the complete public configuration example and replace every placeholder:

```bash
cp cloud-v2/deploy/azure/enterprise-reference/deployment.config.example.json \
  /secure/path/mentra-private.config.json
```

Generate the customer-owned signing material before deployment. Keep this file
outside the repository, import it into the customer's approved secret manager,
and reuse the same values across ordinary upgrades:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/generate-private-secrets.sh \
  /secure/path/mentra-private-secrets.json
```

Validate both files locally before making Azure changes:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh --validate-only \
  /secure/path/mentra-private.config.json \
  /secure/path/mentra-private-secrets.json
```

The deployment helper performs the proven sequence: create/update the resource
group, bootstrap ACR, import and verify the release digest, construct a
mode-0600 temporary Azure parameter file, deploy, remove that temporary file,
and run the smoke test:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh \
  /secure/path/mentra-private.config.json \
  /secure/path/mentra-private-secrets.json
```

The templates create:

- one Container Apps environment;
- separate Core and meetings-only Runtime apps using the same digest;
- Cosmos DB with MongoDB-compatible API for Core identity/session state;
- customer-owned ACS;
- managed ACR pull identity;
- a generated deployment manifest; and
- Container App secrets for ACS, Mongo, signing keys, and refresh pepper.

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
