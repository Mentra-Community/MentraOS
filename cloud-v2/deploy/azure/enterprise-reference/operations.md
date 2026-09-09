# Mentra Private Deployment operations

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

- Azure subscription, resource group, region, and ACS data location;
- workspace hostname and DNS ownership;
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

For a new deployment, generate the five persistent secret values once:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/generate-private-secrets.sh \
  /secure/path/mentra-private-secrets.json
```

Import the file into approved secret management. The helper refuses to
overwrite an existing file and never writes the values to stdout.

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

## Upgrade

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
