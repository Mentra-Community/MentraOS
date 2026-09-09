# Mentra Private Deployment Azure reference

This directory is Mentra's non-production, customer-shaped reference stack. The
cloud-neutral image and configuration contract is in
[private-deployment.md](../../private-deployment.md). The Azure template starts the
same immutable Mentra Cloud image as two Container Apps:

- customer Core with Cosmos DB for MongoDB-compatible persistence; and
- meetings-only Runtime with the `acs-teams` provider.

It also creates ACS, a Container Apps environment, pull identity, managed TLS
for the workspace hostname, and the served deployment manifest. The Runtime
profile does not start Redis, UDP, cloud audio, camera, Cloudflare, speech,
maps, Store, or reporting dependencies.

## Reference identities

- Tenant: `2e7662c0-e826-4928-95b2-60bdd48d5d95`
- Mobile public client: `95ad08c2-7837-4ddf-933c-1fce3d6d2799`
- Core API: `20424d9e-4b99-44e8-82c9-0ad06f08a8db`
- Core scope: `api://20424d9e-4b99-44e8-82c9-0ad06f08a8db/mentra.session`
- Workspace: `https://enterprisedev.mentraglass.com`

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

On the first successful publication only, a Mentra organization owner must set
the `mentra-cloud` package visibility to **Public** in GitHub package settings.
The reference deployment can consume the package using its workflow token
before that change, but customer registries cannot import it anonymously until
the one-time visibility setting is applied.

Persistent signing keys and the refresh pepper live as GitHub Actions secrets
for this Mentra-owned reference environment and become Container App secrets.
Customer deployments use their own approved secret manager.

## Customer-shaped deployment

The supported assisted path takes one public configuration file and one
mode-0600 secret file. Copy and edit the example, then generate the durable
signing material before deploying:

```bash
cp cloud-v2/deploy/azure/enterprise-reference/deployment.config.example.json \
  /secure/path/mentra-private.config.json
cloud-v2/deploy/azure/enterprise-reference/scripts/generate-private-secrets.sh \
  /secure/path/mentra-private-secrets.json
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh --validate-only \
  /secure/path/mentra-private.config.json \
  /secure/path/mentra-private-secrets.json
cloud-v2/deploy/azure/enterprise-reference/scripts/deploy.sh \
  /secure/path/mentra-private.config.json \
  /secure/path/mentra-private-secrets.json
```

The helper creates the resource group, bootstraps ACR, imports and verifies the
digest, deploys Core and Runtime through a protected temporary parameter file,
removes that file, runs the smoke test, and prints the deployment outputs.
Import the durable secret file into approved secret management; replacing its
values is a deliberate session/key rotation, not an ordinary redeploy.

For a custom hostname, first deploy without `workspaceHostname`, create a
DNS-only CNAME to the printed `generatedRuntimeHostname`, and create
`asuid.<workspace-hostname>` as a TXT record whose value is the printed
`customDomainVerificationId`. Then set `workspaceHostname` and rerun the same
helper. The Core reference uses its Azure-generated TLS hostname and is declared
separately in `services.coreUrl`.

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
export MENTRA_WORKSPACE=https://enterprisedev.mentraglass.com
cloud-v2/deploy/azure/enterprise-reference/scripts/smoke-test.sh "$MENTRA_WORKSPACE"
```

Then enroll the official Mentra App through **Connect to organization**, sign in
as an assigned employee, verify relaunch/refresh/logout/workspace switching, and
check that no Mentra consumer telemetry or services are contacted. Microsoft,
ACS, the customer workspace, and customer Core remain expected egress.

This qualifies private infrastructure and restricted networking; it is not a
literal zero-internet air-gapped profile.
