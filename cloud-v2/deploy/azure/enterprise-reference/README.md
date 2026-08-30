# Mentra Enterprise reference deployment

This is Mentra's non-production, customer-shaped validation environment. It
runs the ordinary Cloud V2 Runtime image with only `managed-streams,meetings`.
It intentionally deploys no Core, MongoDB, Redis, UDP listener, Runtime
WebSocket, audio worker, speech provider, Store, or Mentra-hosted identity.

The checked-in manifest is release-pinned and contains only public identifiers.
The Azure Communication Services connection string and Cloudflare credentials
are Container App secrets; do not put them in the manifest or mobile app.
The checked-in privacy notice and terms are explicitly non-production
placeholders. A customer deployment must replace them with organization-approved
documents; Runtime serves them from the same workspace origin named by the
manifest.

## Reference identities

- Tenant: `2e7662c0-e826-4928-95b2-60bdd48d5d95`
- Mobile public client: `95ad08c2-7837-4ddf-933c-1fce3d6d2799`
- Runtime API: `20424d9e-4b99-44e8-82c9-0ad06f08a8db`
- Runtime scope: `api://20424d9e-4b99-44e8-82c9-0ad06f08a8db/mentra.runtime`
- ACS resource: `mentra-enterprise-reference`
- Workspace: `https://ca-mentra-enterprise-reference.gentlehill-4ed63a4c.westus2.azurecontainerapps.io`

The public client is single-tenant, assignment-required, and declares the
Runtime scope plus ACS `Teams.ManageCalls` and `Teams.ManageChats`. Android
qualification currently registers the local debug-signing redirect; a release
qualification must add the official APK signing-certificate redirect before
using a store/MDM artifact. iOS registers `msauth.com.mentra.mentra://auth`.
See [entra-setup.md](./entra-setup.md) for the customer registration contract.

## Deploy

Build the normal repository image from the repository root:

```bash
az acr build \
  --registry mentraenterpriseref \
  --image mentra-runtime-enterprise:<git-sha> \
  --file cloud-v2/docker/Dockerfile .
```

Deploy with Cloudflare secrets supplied from the operator's secret manager:

```bash
az deployment group create \
  --resource-group rg-mentra-enterprise-reference \
  --template-file cloud-v2/deploy/azure/enterprise-reference/main.bicep \
  --parameters \
    runtimeImage=mentraenterpriseref.azurecr.io/mentra-runtime-enterprise:<git-sha> \
    tenantId=2e7662c0-e826-4928-95b2-60bdd48d5d95 \
    runtimeApiClientId=20424d9e-4b99-44e8-82c9-0ad06f08a8db \
    mobileClientId=95ad08c2-7837-4ddf-933c-1fce3d6d2799 \
    cloudflareAccountId="$CF_STREAM_ACCOUNT_ID" \
    cloudflareApiToken="$CF_STREAM_API_TOKEN"
```

This profile has customer-approved Microsoft, ACS, Azure, and Cloudflare
egress. It is restricted-network/self-hosted, not literally air-gapped.
