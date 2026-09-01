# Mentra Enterprise reference deployment

This is Mentra's non-production, customer-shaped validation environment. It
runs the ordinary Cloud V2 Runtime image with only `meetings` and its
`acs-teams` provider.
It intentionally deploys no Core, MongoDB, Redis, UDP listener, Runtime
WebSocket, audio worker, speech provider, Store, or Mentra-hosted identity.

Runtime generates the served manifest from Bicep parameters so tenant ids,
resource ids, resource names, and the supported app-version policy can be
changed without rebuilding the image. The checked-in manifest is an example of
Mentra's current reference environment and contains only public identifiers.
The Azure Communication Services connection string is a Container App secret;
do not put it in the manifest or mobile app. The enterprise profile assumes the
direct SoftAP glasses-to-phone media path and therefore needs no Cloudflare
Stream account or credentials.
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
See [customer-setup.md](./customer-setup.md) for the full enterprise setup
runbook and [entra-setup.md](./entra-setup.md) for the detailed identity contract.

## Coordinated dev deployment

The `dev` coordinated release calls `.github/workflows/enterprise-runtime-dev.yml`
with its immutable release plan. The workflow uses GitHub OIDC to build that
plan's exact source commit in the reference ACR, applies this Bicep template with
`RUNTIME_SERVICES=meetings`, verifies the live health, version-policy, manifest,
legal, and authenticated-route contract, and contributes its deployment record
to the final release bill of materials. This keeps the enterprise Runtime,
public Cloud V2, Mentra App, ASG client, SDKs, and OTA artifacts tied to one
source commit and release identity.
The Azure identity is a Contributor only within the dedicated reference
resource group. It cannot create role assignments; an administrator creates the
managed identity's `AcrPull` assignment during the initial bootstrap.

The shared reference environment has no independent push or manual deployment
path. That prevents an uncoordinated build from replacing the release-matched
Runtime behind the workspace URL.

## Deploy from a clean resource group

Create a globally unique registry first. This is deliberately separate because
the Runtime image must exist before Azure can create the Container App:

```bash
az deployment group create \
  --resource-group rg-mentra-enterprise-reference \
  --template-file cloud-v2/deploy/azure/enterprise-reference/bootstrap.bicep
```

Copy the `registryName` output, then build the normal repository image from the
repository root:

```bash
az acr build \
  --registry <registry-name> \
  --image mentra-runtime-enterprise:<git-sha> \
  --file cloud-v2/docker/Dockerfile .
```

Deploy the meetings-only Runtime:

```bash
az deployment group create \
  --resource-group rg-mentra-enterprise-reference \
  --template-file cloud-v2/deploy/azure/enterprise-reference/main.bicep \
  --parameters \
    runtimeImage=<registry-name>.azurecr.io/mentra-runtime-enterprise:<git-sha> \
    registryName=<registry-name> \
    tenantId=2e7662c0-e826-4928-95b2-60bdd48d5d95 \
    runtimeApiClientId=20424d9e-4b99-44e8-82c9-0ad06f08a8db \
    mobileClientId=95ad08c2-7837-4ddf-933c-1fce3d6d2799
```

Set `clientMinVersion` or `clientRecommendedVersion` only when the deployment
needs to enforce or recommend a real Mentra App version floor. Both default to
`0.0.0`, which permits every workspace-capable release.

This profile has customer-approved Microsoft, ACS, and Azure egress. It is
restricted-network/self-hosted, not literally air-gapped.

## Qualify the reference deployment yourself

### 1. Check the Microsoft setup

Follow [entra-setup.md](./entra-setup.md), then confirm that your employee is
assigned to the **Mentra Enterprise Reference Mobile** Enterprise Application.
The checked-in Mentra tenant already has both app registrations and the debug
Android plus production iOS redirects. A differently signed Android build needs
its own redirect before sign-in can return to the app.

### 2. Build and deploy Runtime

The current shared resource group already exists. Build a new Runtime image from
the repository root, using an immutable tag:

```bash
az acr build \
  --registry mentraenterpriseref \
  --image mentra-runtime-enterprise:<git-sha> \
  --file cloud-v2/docker/Dockerfile .
```

Deploy that image. Supplying the existing ACS name updates the current reference
resources instead of creating a second ACS resource:

```bash
az deployment group create \
  --name enterprise-runtime \
  --resource-group rg-mentra-enterprise-reference \
  --template-file cloud-v2/deploy/azure/enterprise-reference/main.bicep \
  --parameters \
    runtimeImage=mentraenterpriseref.azurecr.io/mentra-runtime-enterprise:<git-sha> \
    registryName=mentraenterpriseref \
    communicationName=mentra-enterprise-reference \
    tenantId=2e7662c0-e826-4928-95b2-60bdd48d5d95 \
    runtimeApiClientId=20424d9e-4b99-44e8-82c9-0ad06f08a8db \
    mobileClientId=95ad08c2-7837-4ddf-933c-1fce3d6d2799
```

No Cloudflare variables are required. Bicep creates the customer-owned ACS
resource and stores its connection string directly as a Container App secret.

### 3. Smoke-test the deployment before opening the app

```bash
export MENTRA_WORKSPACE="$(
  az deployment group show \
    --name enterprise-runtime \
    --resource-group rg-mentra-enterprise-reference \
    --query properties.outputs.workspaceOrigin.value \
    --output tsv
)"

curl --fail --show-error "$MENTRA_WORKSPACE/healthz"
curl --fail --show-error "$MENTRA_WORKSPACE/ready"
curl --fail --show-error "$MENTRA_WORKSPACE/api/client/min-version"
curl --fail --show-error \
  "$MENTRA_WORKSPACE/.well-known/mentra-deployment.json"
```

Inspect the responses. The version endpoint should return the configured
`required` and `recommended` floors. In the manifest, `runtimeUrl` must equal
`MENTRA_WORKSPACE`, `coreUrl` must be `null`, and `telemetry` must be `false`.

### 4. Build and exercise the Mentra App

A native rebuild is required because this branch adds MSAL native code and iOS
entitlements:

```bash
cd mobile
bun install
bun expo prebuild
cd ios && pod install && cd ..
bun android
# Or, on an iOS device/simulator:
bun ios
```

For a clean first-install test, delete the Mentra App from the test phone first.
That removes its local account, glasses pairing, settings, and workspace choice.
Then verify this flow:

1. Launch the Mentra App. The normal Google, Apple, and email choices remain
   available, and no deployment has yet been selected.
2. Tap **Connect to organization** and enter `MENTRA_WORKSPACE`.
3. Confirm that the app shows **Mentra Enterprise Reference**, the expected host,
   and Microsoft organization sign-in before activation.
4. Continue, complete Microsoft sign-in with an assigned Mentra employee, and
   confirm that MFA or Conditional Access returns to the app.
5. Relaunch the app. It should restore the workspace and silently restore the
   same employee where Microsoft policy permits.
6. Use **Change** and **Return to Mentra**. Each path must clear the Microsoft
   account and local workspace state; returning to Mentra must show the consumer
   landing page again.

Also try an unassigned employee. To exercise version policy, redeploy with a
`clientMinVersion` above the installed app, confirm the app requires an update,
then restore the floor to `0.0.0`.

### 5. Check the restricted-network claim

Run one clean qualification through Proxyman, Charles, or another device proxy.
Before choosing Mentra or a workspace, the app must not initialize Mentra Sentry,
Firebase Analytics, PostHog, Core, Runtime, OTA, or glasses reconnect effects.
With this workspace active and `telemetry: false`, there must be no traffic to
Mentra Core/Runtime, Sentry, Firebase Analytics, or PostHog. Expected traffic is
limited to the selected workspace and the configured Microsoft and ACS services
used by the test.

This branch can qualify manifest resolution, Microsoft sign-in, Runtime token
acquisition, deployment isolation, and the meeting credential HTTP service.
The complete glasses-to-Teams media call becomes testable after Nicolo's native
ACS meeting work is integrated; this deployment does not fake that media path.
