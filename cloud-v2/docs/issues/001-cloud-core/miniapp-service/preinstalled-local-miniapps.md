# Preinstalled local miniapp registry

**Status:** Draft spike/spec. This is cloud-core miniapp-service work; do not
implement from this file without review.

## Problem

The phone currently carries local miniapp assumptions in app code and dev setup.
That is enough for one built-in test app, but it does not give the team a
controlled way to add, remove, or upgrade preinstalled local miniapps across
Mentra-owned and OEM-owned builds.

We need a cloud-core source of truth for the default local miniapp set:

- which local miniapps should be present for a user/build/OEM;
- which version is current;
- where the signed bundle can be downloaded;
- whether an installed copy should be added, upgraded, retained, or left alone.

## Goals

- Let mobile/cloud-client ask cloud-core for the desired preinstalled local
  miniapp set at startup and periodically after auth refresh.
- Install a missing preinstalled local miniapp without a user visiting the store.
- Upgrade an existing preinstalled local miniapp when the registry version is
  newer and compatible.
- Preserve explicit user intent. A user-disabled or user-removed preinstalled
  app should not be reinstalled every boot unless policy says it is mandatory.
- Work for Mentra first and leave room for OEM-specific defaults.
- Make this testable in local dev and Porter dev environments.

## Non-goals

- This does not replace the App Store listing/search surface.
- This does not give miniapps arbitrary background install permissions.
- This does not put bundle hosting directly inside cloud-client; cloud-client is
  only the device-facing consumer.
- This does not define Dev Console publishing UX beyond the metadata the service
  must eventually expose.

## Proposed contract

Cloud-core miniapp-service exposes a device-facing endpoint through
`cloud.core.miniapps`:

```ts
interface PreinstalledMiniappRegistryEntry {
  packageName: string
  version: string
  bundleUrl: string
  bundleSha256: string
  manifestUrl?: string
  required: boolean
  channel: "stable" | "dev" | "oem"
  minMobileVersion?: string
  maxMobileVersion?: string
  tenantId?: string
}

interface PreinstalledMiniappRegistry {
  generatedAt: string
  entries: PreinstalledMiniappRegistryEntry[]
}
```

Initial endpoint shape:

```txt
GET /api/client/miniapps/preinstalled
Authorization: Bearer <cloud-client access token>
```

The response is personalized by user, OEM, channel, and mobile build metadata.
Cloud-core owns the registry rules; the phone owns installation decisions and
local state.

## Device behavior

1. Cloud-client fetches the registry after auth exchange and when the core token
   refreshes.
2. Mobile compares each entry to the local miniapp install table.
3. Missing optional entries are installed once unless the user has explicitly
   dismissed them.
4. Missing required entries are installed or retried until present.
5. Older installed entries are upgraded if `version` is newer and compatible.
6. Entries no longer returned are not automatically deleted; the phone may mark
   them as no-longer-preinstalled and leave user removal/manual cleanup to a
   product decision.

## Freshness and safety

- Every bundle must have a content hash and should eventually be signed.
- Installation is idempotent: repeated registry fetches cannot create duplicate
  miniapp rows or duplicate background sessions.
- Failed downloads back off and keep the previous installed version.
- A bad registry response must not uninstall working miniapps.
- Dev and Porter environments need separate channels so local QA can test new
  registry entries without changing production defaults.

## Faults to test

| Fault | Expected behavior |
| --- | --- |
| Registry endpoint down | Existing installed miniapps continue to run; retry later |
| Bundle download fails | Keep old version; retry with backoff |
| Hash mismatch | Reject bundle; report telemetry; keep old version |
| Version downgrade returned | Ignore unless explicitly marked as rollback policy |
| User removed optional app | Do not reinstall automatically |
| Required app missing | Reinstall and surface install failure in debug/telemetry |
| OEM registry changes | Mentra defaults and OEM defaults merge deterministically |
| Mobile app restarts mid-install | Resume or clean partial install; no duplicate sessions |
| Local dev registry points to Metro host | Host changes are resolved through current dev host, not stale LAN IP |

## Integration points

- `cloud-v2/packages/core`: miniapp-service endpoint and registry rules.
- `cloud-v2/packages/cloud-client`: add `cloud.core.miniapps.getPreinstalled()`
  or equivalent typed method.
- `mobile`: installer/reconciler that applies registry entries to the local
  miniapp store and respects user override state.
- `cloud-v2/scripts/dev-stack.ts`: local fixture registry for E2E.
- E2E harness: run the same missing/upgrade/hash-failure cases against local dev
  and Porter dev.

## Open decisions

- Where user dismissal state lives: local-only, cloud profile, or both.
- Whether `required` can force reinstall after explicit user removal.
- Bundle signing format and key ownership.
- How Dev Console promotes a miniapp version into a preinstalled channel.
- Whether cloud-client should cache the registry or leave all persistence to
  mobile.
