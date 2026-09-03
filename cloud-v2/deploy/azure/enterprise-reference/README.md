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

## Manual customer-shaped deployment

Bootstrap an ACR, import a coordinated digest, and keep the printed ACR digest:

```bash
az deployment group create \
  --resource-group <resource-group> \
  --template-file cloud-v2/deploy/azure/enterprise-reference/bootstrap.bicep

cloud-v2/deploy/azure/enterprise-reference/scripts/import-runtime-image.sh \
  <registry-name> \
  ghcr.io/mentra-community/mentra-cloud@sha256:<release-digest> \
  <release-identity>
```

Generate the two distinct Ed25519 keypairs and refresh-token pepper once, into
a new mode-0600 file outside the repository:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/generate-private-secrets.sh \
  /secure/path/mentra-private-secrets.json
```

Import those five values into the customer's approved secret manager. Reuse
them across upgrades; replacing them is a deliberate session/key rotation, not
a normal redeploy.

Deploy `main.bicep` with `cloudImage`, the registry/Entra/ACS parameters, and
persistent values for the five secure parameters documented by the template.
The coordinated workflow is the canonical copy-paste example.

For a custom hostname, first deploy without `workspaceHostname`, create a
DNS-only CNAME to `generatedRuntimeHostname` plus the Azure `asuid` TXT record,
then redeploy with the hostname. The Core reference uses its Azure-generated
TLS hostname and is declared separately in `services.coreUrl`.

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
