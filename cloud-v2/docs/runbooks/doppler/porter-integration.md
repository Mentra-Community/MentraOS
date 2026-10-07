# Doppler → Porter integration

Doppler owns application secrets and settings. Porter apps attach only their direct Doppler environment group. Do not use `porter env set`, app-level `env`, or GitHub secret bundles to mirror application configuration. Porter v2 ignores service-level `env`; it must not be used to configure applications either. Listening ports, resource limits, domains, and deployment commands remain in Porter YAML. Porter also retains the scoped integration credential and platform-generated environment variables.

The complete managed-app inventory is in [doppler-porter-contract.json](../../../../.github/production-release/doppler-porter-contract.json). Kubernetes sync health, linked groups, and app overrides are checked hourly and on relevant pull requests by the Doppler Porter health workflow. Run the same read-only check locally:

```bash
node .github/scripts/porter-doppler-health.mjs
node .github/scripts/porter-doppler-source.mjs
```

Always specify project 15081 and the intended cluster: 5690 (legacy east), 5692 (cloud west), or 5783 (miniapps). The CLI's saved default can point to another cluster. `porter env list --json` includes direct groups in its environment-group section; legacy cloud groups use a separate section.

## Cloud configuration

| Porter app                                            | Doppler config in `cloud-v2` | Direct group                 |
| ----------------------------------------------------- | ---------------------------- | ---------------------------- |
| cloud-dev, legacy cloud-v2 west                       | dev_aws                      | cloud-v2-dev-doppler         |
| cloud-prod                                            | prod                         | cloud-v2-prod-doppler-sync   |
| cloud-staging                                         | staging                      | cloud-v2-staging-doppler     |
| cloud-debug                                           | dev_debug                    | cloud-v2-debug-doppler       |
| cloud-isaiah                                          | dev_isaiah                   | cloud-v2-isaiah-doppler      |
| legacy cloud-v2 east (prepared; cutover blocked)      | legacy_east                  | cloud-v2-legacy-east-doppler |
| Miniapp Store (historical app name miniapp-store-dev) | store_prod                   | miniapp-store-prod-doppler   |

Store is production despite its historical `dev` resource names. Its isolated Doppler environment preserves its existing production database, storage, auth, and URLs. Do not copy the main cloud config into it. Legacy east has different regional/database/auth settings. Its isolated config and native group are prepared, but its pre-existing invalid Mongo/Redis settings prevent startup and Porter automatically restores its old manual group. Repair or retirement needs an ownership decision; it is explicitly excluded from the migrated-app contract until then. The contract also documents the unused, failing `peg-merge-prod-doppler` AWS resources, whose deletion requires a Porter administrator.

Enterprise has a separate `mentra-enterprise/prd` project/config. Intentionally shared Merge credentials use Doppler references to `local-merge/prd`, so future shared rotations propagate without duplicating those values. App-specific settings belong to Enterprise.

## Adding or changing a setting

Change the correct Doppler config first. Verify the native group contains the updated value using an in-memory comparison that prints only key names and match status. Never dump `porter env pull`, Doppler JSON, or service tokens into logs. Confirm both SecretStore and ExternalSecret have Ready=True, and ExternalSecret has a recent advancing refresh timestamp. A green historical deploy or an old exported value alone does not prove a working sync.

Then roll out the app through its owning repository's deployment workflow and validate readiness and affected functionality. Existing process environments are snapshots; a successful group refresh is not proof that a running process picked up the change. Cloud code releases use the coordinated release workflow. Configuration-only rollouts must preserve the validated image and deployment topology.

## Creating or repairing a connection

Create a read-only service token scoped to exactly one verified Doppler config. Specify `--access read`; do not rely on the CLI default. Capture the token privately, validate it directly against Doppler, and put it in the Porter environment group's Doppler credential field. The authenticated Porter dashboard API also supports this operation, although the Porter CLI does not expose it directly.

Creation: POST `/api/v2/projects/15081/environment-groups` with the group name, cluster ID, type `doppler`, and the private `doppler.service_token`. Rotation: POST `/api/v2/projects/15081/environment-groups/<name>?cluster_id=<cluster>` with type `doppler` and the new credential. Keep tokens and request bodies out of command output and durable files.

After rotation, operator caching and retry backoff can delay validation for several minutes; the October 2026 repairs took about ten minutes. Do not repeatedly replace a newly verified token merely because the first refresh is delayed. Check the namespaced resources and verify value equality after an advancing successful refresh:

```bash
porter kubectl --project 15081 --cluster 5783 -- get secretstores,externalsecrets -n porter-env-group
```

Native per-cluster groups currently have `.1` resource suffixes. An unsuffixed legacy AWS-backed resource is a different integration and must not be mistaken for the direct Doppler group.

Only detach manual groups and clear app overrides after proving their required effective values are present in the intended Doppler config. Preserve deliberately stopped applications. Leave unused manual groups/revisions available for rollback until consumers have been checked. Revoke old service tokens only after proving they have no other consumers.

## Why drift happened

The audit found invalid service-token authentication on Call and Notes; the status does not establish who revoked or regenerated those tokens. Rotating a token in Doppler does not update Porter's saved credential automatically. Several other apps never had a native connection: their deploy scripts copied secrets into manual groups. App overrides and multiple competing groups then masked Doppler changes. Deployment manifests and scripts must therefore enforce the same ownership as the live configuration.

The health workflow reports invalid/missing stores, stale refreshes, unexpected groups, and app overrides without printing secret values. Its GitHub failure status is the notification surface; no Slack notification is configured.
