# Mentra Private Deployment operations

This runbook covers the customer-owned Runtime image lifecycle and deployment
checks. Use the release identity and Runtime digest from one coordinated Mentra
release bill of materials; do not combine a Runtime from one release with a
Mentra App selected from another without explicit compatibility qualification.

## Import an immutable Runtime image

Mentra provides a digest-pinned source such as:

```text
mentraenterpriseref.azurecr.io/mentra-runtime-enterprise@sha256:<digest>
```

Grant the customer registry's import identity temporary pull access to the
source, then import and verify it:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/import-runtime-image.sh \
  <customer-acr-name> \
  mentraenterpriseref.azurecr.io/mentra-runtime-enterprise@sha256:<digest> \
  <release-identity>
```

The helper refuses a mutable source tag and prints the customer-owned
digest-pinned image reference. Use that printed reference as `runtimeImage` in
the Bicep deployment. Revoke the temporary source-registry access after import.

If the customer uses its own legal, logo, or managed miniapp files, replace the
reference files, add the ZIPs, and build the small asset layer on top of the
imported digest instead of rebuilding MentraOS:

```bash
az acr build \
  --registry <customer-acr-name> \
  --build-arg MENTRA_RUNTIME_IMAGE=<imported-image@sha256:digest> \
  --image mentra-runtime-enterprise:<release-identity>-customer \
  --file cloud-v2/deploy/azure/enterprise-reference/Dockerfile.customer-assets \
  .
```

Resolve and record the derived image's digest, then pass that digest—not its
mutable tag—to `runtimeImage`.

If the customer cannot allow registry-to-registry transfer, Mentra may export
the same OCI image through the customer's approved offline artifact-transfer
process. The customer must verify the OCI digest before importing it. That
delivery path changes transport, not the deployment manifest or image identity.

## Customer configuration checklist

Record and approve these values before deployment:

- Azure subscription, resource group, region, and ACS data location;
- workspace hostname and DNS ownership;
- Entra tenant, Runtime application client id, and Mobile application client id;
- the Android/iOS Mentra App distribution channels and matching redirect URIs;
- employee/group assignment, administrator consent, MFA, and Conditional Access;
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

The reference Runtime image does not contain customer miniapp ZIPs. Put them in
`cloud-v2/deploy/azure/enterprise-reference/miniapps/` when producing the
customer-derived Runtime image, or provide the same path through a
customer-owned ingress. Runtime verifies every image-bundled ZIP against the
manifest at startup and serves its declared `/miniapps/*` path with immutable
cache headers. A missing or mismatched bundle prevents Runtime startup. Keep the
final customer image pinned by its own digest.

When a customer ingress serves the paths instead, deploy with
`managedMiniappDirectory=''` so Runtime does not also require image-bundled
files.

## Upgrade

1. Save the currently deployed Runtime digest and Bicep parameter set.
2. Import the new coordinated Runtime by digest.
3. Review manifest/configuration changes and keep the old image in the registry.
4. Deploy `main.bicep` with the new digest-pinned `runtimeImage`.
5. Run the smoke test:

   ```bash
   cloud-v2/deploy/azure/enterprise-reference/scripts/smoke-test.sh \
     https://<customer-workspace>
   ```

6. Test assigned and unassigned sign-in, silent renewal, and an end-to-end Teams
   call before broad rollout.

## Rollback

Redeploy the previous Bicep parameters with the saved previous image digest,
then rerun the smoke test and sign-in/call checks. Do not roll back the Runtime
alone if the manifest schema or mobile protocol requires a coordinated mobile
rollback; use the matching prior coordinated release set.

Managed miniapps roll forward independently through their manifest version and
digest. If a new userland bundle fails before activation, the prior version
remains active. To roll back an already activated bundle, publish the known-good
content under a new semantic version and update the manifest; versions are
immutable.
