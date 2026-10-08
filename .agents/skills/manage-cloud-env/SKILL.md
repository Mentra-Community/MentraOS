---
name: manage-cloud-env
description: Add or change backend deployment environment variables through Doppler shared configs and native Porter syncs. Use when implementing features that require keys, onboarding cloud or miniapp deployments, or repairing deployment configuration drift.
---

# Manage cloud environment variables

Make Doppler the source of truth for backend application secrets and settings.
Prefer shared inheritance whenever a setting does not need to vary by environment.
Apply this workflow while implementing a feature that needs a key, not just when
the user explicitly mentions Doppler. It also applies to first-party miniapps in
external repositories.

Do not put backend credentials in a miniapp ZIP, mobile bundle, source code,
Porter YAML, GitHub application-secret bundle, or manual Porter environment group.
Client-visible public configuration is a separate concern: confirm the consumer
and credential type before exposing a value to a client. Listening ports,
resources, domains, deployment commands, platform-generated variables, and the
scoped Doppler integration credential remain Porter's responsibility.

## Find the actual deployment and configuration

1. Trace the feature's backend and owning repository. Read its deployment files
   and environment validation so the key name and consumer are established.
2. Find the Porter app, project, cluster, deployment target, linked environment
   group, and the group's actual Doppler project/config. Never infer the target
   from the CLI default, hostname, or an app name containing `dev`.
3. Read [the Doppler/Porter runbook](../../../cloud-v2/docs/runbooks/doppler/porter-integration.md)
   and [managed deployment contract](../../../.github/production-release/doppler-porter-contract.json).
   Reconcile the relevant entry with live configuration before writing. Cloud's
   deployed dev config is `cloud-v2/dev_aws`; its `dev` root contains local settings.
4. Use supported CLIs/APIs. Check available credentials and authentication helpers,
   including relevant variable names in `~/.zshrc`, without printing values.
   Capture Doppler downloads and Porter exports privately; emit only key names,
   missing/present status, and equality checks. Do not log service tokens or
   authenticated URLs, including through command failure output.

## Choose shared or environment-specific storage

Use an inheritable `shared` config in the owning Doppler project by default.
Reuse an existing suitable parent rather than creating another source for the
same value. Cross-project inheritance is useful for intentionally shared provider
credentials, but do not give an app every unrelated project's secrets.

| Setting | Placement |
| --- | --- |
| Provider credentials/settings usable by all intended environments | Shared parent |
| Database destination, storage bucket, callback URL, public backend URL, environment name | Environment child |
| Credential that must differ for account, permissions, resource access, or isolation | Environment child; record the reason |

Examples of shared candidates include Soniox, ElevenLabs, Resend, Mapbox,
Cloudflare Stream, R2 credentials/endpoints, and ACS. Check each credential's
permissions, resource scope, and intended shared usage. R2 credentials can be
shared while bucket names remain distinct. Different existing token strings alone
do not prove an environment-specific requirement. Do not collapse deliberately
separate auth, database, provider accounts, or sandbox/payment environments.

For an existing deployment, seed shared values from the **current working
production configuration** when available. Compare Doppler, the linked Porter
group, and effective process values privately so an old override cannot mask a
bad source value. Preserve production credentials; do not rotate them as part of
an inheritance migration. For a new service without production values, use the
approved provider credential and put it directly in the shared parent when suitable.

Inheritance includes all parent keys; achieve a subset by keeping only common
settings in the parent. Child copies take precedence. Adding another copied value
to every environment is not inheritance. Check availability: Config Inheritance
requires a supported Doppler plan and must be enabled for the parent. If it is
unavailable, report that limitation; do not silently substitute Porter overrides.

## Add the key and establish the native connection

- **Healthy existing connection:** write the key to its appropriate Doppler parent
  or child. Leave the Porter app attached to the environment's child config; do
  not point it directly at the incomplete shared parent.
- **Broken existing connection:** repair and verify the native Doppler sync, then
  write the key. A disconnected integration is not a reason to duplicate keys in
  Porter. Follow the runbook's scoped service-token and operator-refresh procedure.
- **No associated Doppler project/connection:** create the owning Doppler project,
  a dedicated shared parent, and the deployment child config. Do this even for a
  miniapp with only one environment. Populate required environment-specific
  settings in the child, enable inheritance, and create/attach a native Porter
  Doppler group using a read-only service token scoped to that child. For an
  already-running app, preserve and verify its effective values before replacing
  its configuration sources. Update the managed deployment contract and owning
  deployment files as applicable.

The CLI supports creating a dedicated `shared` environment/root config and enabling
inheritance. Use explicit verified identifiers, preserve existing inheritance,
and check current CLI help before running these example operations:

```bash
doppler environments create 'Shared provider credentials' shared --project PROJECT
doppler configs update --project PROJECT --config shared --inheritable=true --yes
doppler configs update --project PROJECT --config CHILD --inherits PROJECT.shared --yes
```

`--inherits` replaces the inheritance list: include existing parents in the intended
precedence order. Populate shared values before attaching consumers. Write secrets
through private structured API bodies or a supported private input path, keeping
values out of shell arguments, logs, and tracked files.

When migrating existing copies, save recoverable previous values/configuration,
attach the parent first, verify the resolved child config, then remove only the
selected child copies. Re-read the complete resolved config: only intended values
may change. Branch configs can also inherit root values; verify actual resolution
instead of assuming that deleting a branch copy removes the key altogether.
Keep a rollback path until the affected behavior is verified.

A shared-parent edit affects every current inheritor. Inspect those consumers
before changing an existing shared value. Respect the user's authorized rollout
scope. For staged migrations, do dev first, wait for the requested confirmation,
then staging, then production; production's resolved values must remain identical
when the change only moves storage into inheritance. Do not migrate other
environments or restart deliberately stopped apps as a side effect of a feature.

## Verify the deployed result

Verify the intended SecretStore and ExternalSecret are Ready=True and have an
advancing, recent successful refresh. Privately compare the linked group's values
with the resolved Doppler config. Then verify running process values; environment
variables are startup snapshots. If a rollout is needed, use the owning deployment
workflow and preserve the current image/topology for a configuration-only change.

Check backend readiness and the affected provider operation. Do not treat an old
green deploy, a successful secret write, or a refreshed group as proof that the
feature works. Report the actual project/config, parent, key names, rollout scope,
completed checks, and any remaining user test. Never report secret values.

Use the existing deployment source guard and scoped read-only health checks where
applicable; do not disable them to accommodate a manual override. Update the
managed contract when a new app, config/group mapping, or required key is introduced.

## Porter overrides are the last resort

Before considering any override, check the correct Doppler project, config,
inheritance, sync credential, linked group, and refresh status. A missing project,
missing key, stale process, or repairable sync must be addressed through the paths
above. Do not use `porter env set` to bypass that work or resurrect the retired
manual-mirroring scripts.

Only use a temporary application override when the user explicitly requests that
exception or has already authorized it for a demonstrated blocker with no supported
Doppler path. Explain the blocker, affected keys/environment, and cleanup/rollback
plan. Existing source guards still apply; do not bypass them. Keep Doppler as the
authoritative destination and remove the exception after verifying native sync.

Reference: [Doppler Config Inheritance](https://docs.doppler.com/docs/config-inheritance).
