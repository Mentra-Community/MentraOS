# Mentra App deployment manifest reference

The deployment manifest configures the official Mentra App for a customer
workspace: where to sign in, which Core and Runtime to use, which miniapps and
glasses are allowed, and which features and content are available.

This reference describes **schema version 1 as currently implemented**. Use it
with the [Private Deployment setup contract](./private-deployment.md) and, for
Azure, the [customer setup guide](./azure/enterprise-reference/customer-setup.md).
The manifest contains public configuration only. Keep credentials, signing
keys, connection strings, and tokens in server-side secret management.

## Complete example

This example configures a meetings-only workspace with Settings and Mentra
Live. Replace the example domains and all three Entra identifiers with your
organization's values. Serve the referenced legal pages and images as well as
the manifest. The empty managed list does not install a calling miniapp.

```json
{
  "schemaVersion": 1,
  "deploymentId": "acme-workspace",
  "displayName": "Acme",
  "branding": {
    "logoUrls": {
      "light": "https://workspace.acme.example/branding/logo-light.png",
      "dark": "https://workspace.acme.example/branding/logo-dark.png"
    }
  },
  "services": {
    "coreUrl": "https://core.acme.example",
    "runtimeUrl": "https://workspace.acme.example"
  },
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111",
    "clientId": "22222222-2222-4222-8222-222222222222",
    "sessionScopes": ["api://33333333-3333-4333-8333-333333333333/mentra.session"],
    "teamsScopes": [
      "https://auth.msft.communication.azure.com/Teams.ManageCalls",
      "https://auth.msft.communication.azure.com/Teams.ManageChats"
    ]
  },
  "artifacts": {
    "mentraLiveOtaManifestUrl": null,
    "sttModelBaseUrl": null,
    "ttsModelBaseUrl": null
  },
  "appUpdates": {
    "mode": "managed",
    "storeUrls": {"android": null, "ios": null},
    "reviewUrls": {"android": null, "ios": null}
  },
  "content": {"wallpaperUrls": []},
  "links": {
    "privacyPolicyUrl": "https://workspace.acme.example/legal/privacy",
    "termsOfServiceUrl": "https://workspace.acme.example/legal/terms",
    "documentationUrl": null,
    "supportUrl": null
  },
  "systemMiniapps": {
    "approvedPackageNamesOverride": ["com.mentra.settings"]
  },
  "miniapps": {
    "managed": [],
    "configuration": {}
  },
  "glasses": {"allowedModelsOverride": ["mentra-live"]},
  "features": {
    "runtimeRealtimeSession": false,
    "managedStreams": false,
    "nativeMeetings": true,
    "cloudSpeech": false,
    "onDeviceSpeech": false,
    "navigation": false
  },
  "telemetry": false
}
```

The corresponding Runtime configuration is `RUNTIME_SERVICES=meetings` and
`MEETING_PROVIDERS=acs-teams`, with the Core trust and ACS configuration
described in the setup contract. The
[reference deployment manifest](./azure/enterprise-reference/mentra-deployment.json)
contains Mentra's demo values; they are not customer defaults.

## Hosting, discovery, and updates

Serve UTF-8 JSON at:

```text
https://<workspace-host>/.well-known/mentra-deployment.json
```

The Mentra App's organization sign-in flow accepts a hostname or HTTPS URL.
It uses only the origin (scheme, hostname, and port) and fetches the fixed path
above. Pasting a homepage path or a full manifest URL does not change that
path. Discovery needs no existing Mentra session, so the endpoint must be
accessible before login. Return the JSON directly, without redirects or a
browser sign-in page. The request has a 10-second timeout and a 256 KiB
(262,144-byte) body limit enforced while downloading.

Runtime can serve the file using exactly one of these environment variables:

| Variable | Value |
| --- | --- |
| `DEPLOYMENT_MANIFEST_PATH` | Absolute container path to the JSON file. |
| `DEPLOYMENT_MANIFEST_JSON` | The JSON document itself. |

Setting both fails Runtime startup. Runtime reads the manifest at startup and
serves it with `Cache-Control: no-store`; restart or redeploy Runtime when
changing this configuration. The Azure template generates the document from
its parameters. Editing the checked-in demo JSON alone does not change an
Azure deployment.

After the user confirms the workspace, the Mentra App persists the validated
manifest locally. Relaunches use that snapshot; **there is no automatic
background manifest refresh in v1**. To apply changes, log out and select the
organization again. Logout clears the workspace selection, and activation
clears prior local account data. Keep `deploymentId` and the workspace origin
stable across normal upgrades: together they identify deployment-scoped
credentials and managed miniapp ownership.

V1 enrollment uses manual organization-address entry and Microsoft Entra
sign-in. QR enrollment, MDM configuration injection, directory lookup, and
other identity providers are not implemented by this manifest version.
Distributing the app through MDM is separate from injecting configuration.

## Required fields, defaults, and URL rules

All fields shown in the complete example are required, with these exceptions:

| Omitted field | Result |
| --- | --- |
| `branding` | No custom workspace logos. If supplied, both logo URLs are required. |
| `miniapps` | Defaults to `{"managed": [], "configuration": {}}`. |
| `miniapps.configuration` | Defaults to `{}`. If `miniapps` is supplied, `managed` is still required. |

An optional field is not automatically nullable. `branding: null`,
`miniapps: null`, and `configuration: null` are invalid. Required nullable
fields must be present with either a value or explicit `null`; omission is
invalid. Booleans must be JSON `true` or `false`, not strings. Unknown fields
are rejected in every fixed-shape object, including the top level. Only the
package and key maps in `miniapps.configuration` accept arbitrary keys under
their documented rules.

Configured service, artifact, logo, content, store/review, and legal/support
URLs must use HTTPS and contain no embedded username/password or fragment
(`#...`). Core and Runtime URLs must be origins with no path beyond an
optional trailing `/`, and no query string. Other URL fields may have paths
and queries. Entra authority has its own stricter rule below. Arbitrary
configuration strings are not interpreted as URLs by the manifest validator.

| URL | Origin requirement |
| --- | --- |
| `services.runtimeUrl` | Must equal the workspace origin. |
| `services.coreUrl` | May use a separate customer Core origin. |
| `branding.logoUrls.light`, `branding.logoUrls.dark` | Must use the workspace origin. |
| `miniapps.managed[].bundleUrl` | Must use the workspace origin and a file path under `/miniapps/`. |
| Artifact, wallpaper, store/review, and legal/support URLs | May use other HTTPS origins approved by the customer. |

The production enrollment flow does not allow HTTP. A resolver test option for
loopback HTTP is not a manifest setting or a supported customer deployment
mode. A failed workspace service never substitutes a Mentra consumer endpoint.

## Identity and branding

| Field | Type and limits | Meaning |
| --- | --- | --- |
| `schemaVersion` | Integer, exactly `1` | Version of this document format, not the app or server release. |
| `deploymentId` | String, 1–63 characters; `^[a-z0-9][a-z0-9-]{0,62}$` | Stable deployment identifier. Starts with a lowercase letter or digit; remaining characters may also be hyphens. |
| `displayName` | String, 1–120 characters | Workspace name shown during enrollment and in the profile. |
| `branding.logoUrls.light` | HTTPS URL | Logo for the light theme. |
| `branding.logoUrls.dark` | HTTPS URL | Logo for the dark theme. |

Use theme-appropriate PNG images for the reference asset routes. The schema
validates URLs, not image dimensions or file formats. Omitting `branding`
uses the app's built-in workspace presentation.

## Services

| Field | Type | Meaning |
| --- | --- | --- |
| `services.coreUrl` | HTTPS origin | Customer Core: login exchange, persistent sessions, refresh, and token issuance. |
| `services.runtimeUrl` | HTTPS origin | Customer Runtime: minimum-version policy and enabled device/media services. Also the workspace discovery origin. |

The shared schema permits `null` for these two fields, but **the current
workspace resolver requires both to be non-null**. A Runtime-only manifest
cannot enroll. Use an HTTPS origin such as `https://core.acme.example`, not
`https://core.acme.example/api` or a WebSocket URL.

## Authentication

Customer workspace enrollment currently supports only this shape:

| Field | Type and limits | Meaning |
| --- | --- | --- |
| `auth.mode` | `"microsoft-entra"` | Use the organization's Microsoft Entra account. |
| `auth.authorityUrl` | HTTPS URL | `https://login.microsoftonline.com/<tenant>` with one exact tenant path segment. Use the tenant ID from Entra setup; do not append `/v2.0`. `common`, `organizations`, and `consumers` are rejected. |
| `auth.clientId` | UUID string | The public **Mobile client** application ID, not the Core API application ID or a client secret. |
| `auth.sessionScopes` | Nonempty array of nonempty strings | Application API scopes matching `api://<application-id>/<scope-name>`. Normally one entry: `api://<core-api-client-id>/mentra.session`. Scope names allow letters, digits, `.`, `_`, and `-`. |
| `auth.teamsScopes` | Array of strings | May contain only the two ACS delegated scopes below, without duplicates. Both are required when `features.nativeMeetings` is `true`; `[]` is valid when it is `false`. |

Supported Teams scopes:

```text
https://auth.msft.communication.azure.com/Teams.ManageCalls
https://auth.msft.communication.azure.com/Teams.ManageChats
```

The employee signs in with Entra; Core exchanges the session-scope token for
a Mentra session and issues Runtime tokens. A native meeting integration can
separately request the Teams scopes from the same Microsoft account. The
manifest does not create Entra applications, assign employees, or grant admin
consent. Complete [Entra setup](./azure/enterprise-reference/entra-setup.md)
and match Core's trusted issuer, audience, scopes, and allowed Mobile client
to these values.

The schema also recognizes `{"mode": "mentra-account"}` with no additional
auth fields, but the workspace resolver rejects it. Normal consumer sign-in
uses the embedded Mentra selection; a hosted customer manifest cannot enable
consumer authentication by setting this mode.

## Artifacts

All three fields are required and accept an HTTPS URL or `null`.

| Field | Meaning and current behavior |
| --- | --- |
| `artifacts.mentraLiveOtaManifestUrl` | URL of the Mentra Live firmware OTA manifest. `null` disables this configured OTA source; it does not select Mentra's public OTA service. This is a separate document from the deployment manifest. |
| `artifacts.sttModelBaseUrl` | Intended base URL for speech-to-text model assets. Accepted and validated, but not currently connected to the model downloader. Use `null` for the reference profile. |
| `artifacts.ttsModelBaseUrl` | Intended base URL for text-to-speech model assets. Accepted and validated, but not currently connected to the model downloader. Use `null` for the reference profile. |

Setting model URLs does not provide customer-hosted model routing today.
`features.onDeviceSpeech` controls the on-device speech feature separately;
keep it `false` for the qualified meetings-only profile.

## App updates

| Field | Type | Meaning and current behavior |
| --- | --- | --- |
| `appUpdates.mode` | `"store"` or `"managed"` | Declares the intended distribution channel. Current update/review buttons are driven by their URLs, not by this value alone. |
| `appUpdates.storeUrls.android` | HTTPS URL or `null` | Android update destination. `null` removes the store action and shows organization-managed update guidance when an update is required. |
| `appUpdates.storeUrls.ios` | HTTPS URL or `null` | Equivalent update destination for iOS. |
| `appUpdates.reviewUrls.android` | HTTPS URL or `null` | Android review destination; `null` hides the review action. |
| `appUpdates.reviewUrls.ios` | HTTPS URL or `null` | Equivalent review destination for iOS. |

For MDM distribution, use `mode: "managed"` and null store/review URLs as in
the example. Setting `managed` alone does not disable a configured URL or
install updates. Store URLs refer to the Mentra App's distribution channel,
not the Mentra Miniapp Store.

Minimum and recommended app versions are **server configuration**, not manifest
fields. Runtime serves them at `/api/client/min-version`; the Azure template
sets them through `clientMinVersion` and `clientRecommendedVersion`. This live
policy is independent of the cached manifest. Do not add version-floor or
coordinated-release fields to the JSON; unknown fields are rejected.

## Content and links

| Field | Type and limits | Meaning |
| --- | --- | --- |
| `content.wallpaperUrls` | Array of up to 100 HTTPS URLs | Workspace wallpaper presets. `[]` supplies no remote presets. It does not disable choosing an image from the phone's library. |
| `links.privacyPolicyUrl` | HTTPS URL, non-null | Organization privacy policy. Required even when telemetry is disabled. |
| `links.termsOfServiceUrl` | HTTPS URL, non-null | Organization terms of service. Required and validated; the current mobile workspace UI does not expose an action for this link. |
| `links.documentationUrl` | HTTPS URL or `null` | Documentation destination. `null` removes the configured documentation action. |
| `links.supportUrl` | HTTPS URL or `null` | Support destination used by the managed-update screen. `null` removes that support action. |

There is no blanket `externalLinks` field. Configure each destination and the
miniapp allowlists separately.

## Built-in system miniapps

`systemMiniapps.approvedPackageNamesOverride` is required. It accepts `null` or
an array of up to 100 package names.

| Value | Behavior |
| --- | --- |
| `null` | No deployment override of the built-in system miniapp set. Future built-ins are not excluded by this policy. |
| `[]` | Approve no system miniapps. |
| `["com.mentra.settings", ...]` | Approve only the listed packages; newly introduced system miniapps are excluded until listed. |

Use `com.mentra.settings` in a restricted workspace so users retain Settings.
Names must match `^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$`; comparisons
are case-sensitive. The current system package identifiers are:

| Package | Miniapp |
| --- | --- |
| `com.mentra.camera` | Camera |
| `com.mentra.gallery` | Gallery |
| `com.mentra.settings` | Settings |
| `com.mentra.simulated` | Simulated Glasses |
| `com.mentra.mirror` | Mirror |
| `com.mentra.ai` | Mentra AI |
| `cloud.augmentos.notify` | Notify |
| `com.mentra.feedback` | Feedback |
| `com.mentra.miniappdev` | Miniapp developer tools |

This list controls approval; it does not download packages or bypass a
feature, build-region, or hardware restriction. A package must also exist in
the selected Mentra App release. Downloaded userland miniapps belong in
`miniapps.managed`. Mentra Call is not a system miniapp.

## Managed miniapps

`miniapps.managed` is an array of up to 100 userland bundle descriptors. It
defaults to `[]` only when the entire `miniapps` object is omitted. Each
descriptor requires all four fields:

| Field | Type and limits | Meaning |
| --- | --- | --- |
| `miniapps.managed[].packageName` | Package-name string using the regex above | Must match the bundle's `miniapp.json`. Unique within the list. |
| `miniapps.managed[].version` | Canonical SemVer string, e.g. `1.2.0` | Must match `miniapp.json`. No `v` prefix, shorthand `1.2`, or version range. |
| `miniapps.managed[].bundleUrl` | HTTPS URL | ZIP on the workspace origin under `/miniapps/`, with a file path rather than a trailing `/`. Each URL pathname must be unique, even if queries differ. |
| `miniapps.managed[].sha256` | Exactly 64 hexadecimal characters, case-insensitive | SHA-256 of the ZIP bytes. Compute it with `shasum -a 256 /path/to/bundle.zip`. |

A managed package cannot be a built-in system package or appear in a non-null
system allowlist. ZIPs must be no larger than 64 MiB and pass archive,
checksum, package-name, and version validation before installation. An
existing unowned install is not adopted as a deployment-owned bundle.

For example, replace the complete example's `miniapps` object with this
fragment, substituting the real bundle's digest for the illustrative value:

```json
{
  "managed": [
    {
      "packageName": "com.example.remoteassist",
      "version": "1.2.0",
      "bundleUrl": "https://workspace.acme.example/miniapps/remoteassist-1.2.0.zip",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "configuration": {
    "com.example.remoteassist": {
      "backendUrl": "https://assist.acme.example"
    }
  }
}
```

Publish new bundle content under a new version and URL. Changing only the
digest of an already installed version is rejected. Successful updates clean
up older versions owned by the deployment. Removing a package from the
manifest removes its deployment-owned install after the phone loads the new
manifest and reconciles it. This does not delete unrelated local or system
installs. See the [managed miniapp operations guide](./azure/enterprise-reference/operations.md#customer-managed-userland-miniapps)
for serving ZIPs from Runtime or customer ingress.

## Miniapp configuration

`miniapps.configuration` is a package-name map of string-to-string maps. It
defaults to `{}` and is independent of installation: it can configure both
approved system miniapps and managed userland miniapps.

| Part | Constraint |
| --- | --- |
| Package map | At most 100 packages; package names use the same regex as managed entries. |
| Each package's map | At most 32 entries and at most 16 KiB of UTF-8 JSON when serialized. |
| Each key | `^[A-Za-z][A-Za-z0-9._-]{0,63}$`: 1–64 characters, starting with a letter. |
| Each value | String of at most 2,048 UTF-8 bytes. Numbers, booleans, objects, arrays, and `null` are invalid; an empty string is allowed. |

With a non-null system allowlist, each configured package must appear either
in that allowlist or in `miniapps.managed`. Otherwise enrollment is rejected.
With a null system allowlist, the resolver does not perform that membership
check. Configuration still does not install or approve a miniapp.

Only the named package receives its configuration. The Mentra Miniapp SDK
exposes asynchronous `session.configuration.get(key)`, `require(key)`, and
`getAll()` methods. Most miniapps do not read these values. A miniapp that
supports an optional backend override can explicitly choose it:

```ts
const backendUrl =
  (await session.configuration.get("backendUrl")) ?? DEFAULT_BACKEND_URL
```

`backendUrl` is a convention used by an opted-in miniapp, not a special field
that rewrites network requests. Without the key, the miniapp retains its
compiled default. The miniapp must validate any supplied URL and handle its
own errors. Never put secrets here: the manifest is fetched before login.
Backend authentication is configured separately in the
[Core trust contract](./private-deployment.md#miniapp-backend-authentication).

## Glasses

`glasses.allowedModelsOverride` is required. It accepts `null` or an array of
up to 100 nonempty strings, each at most 120 characters.

| Value | Behavior |
| --- | --- |
| `null` | No deployment restriction on models supported by this app release. |
| `[]` | Allow no models, including Simulated Glasses. |
| Nonempty array | Allow only matching model IDs, including explicit approval for Simulated Glasses. |

Use these case-sensitive identifiers, not the UI display names:

| Model ID | Model |
| --- | --- |
| `mentra-live` | Mentra Live |
| `simulated-glasses` | Phone Mode / Simulated Glasses |
| `even-realities-g1` | Even Realities G1 |
| `even-realities-g2` | Even Realities G2 |
| `mentra-mach1` | Mentra Mach1 |
| `vuzix-z100` | Vuzix Z100 |
| `mentra-display` | Mentra Display / NEX |
| `nimo` | NIMO |
| `ar99:<project-name>` | A supported AR99 project, with its project name lowercased. Use the exact project from the app's model catalog. |

Unknown strings pass the schema's string check but do not enable a model.
The allowlist does not override other model-availability checks in the app.

For Mentra Live with Phone Mode, use
`["mentra-live", "simulated-glasses"]`. If a non-null allowlist omits
`simulated-glasses`, **Set up without glasses** is hidden during onboarding
and on the disconnected Home screen; direct simulated setup is also blocked.
The model ID `simulated-glasses` and system package `com.mentra.simulated`
control different things and are not interchangeable.

AR99 vendor OTA is unavailable in customer workspaces even when an AR99 model
is approved for pairing. There is no `ar99VendorServices` manifest field.

## Features and Runtime modules

All six `features` fields are required booleans with no defaults. The manifest
controls app capabilities; `RUNTIME_SERVICES` configures the server. Setting a
manifest flag does not start a server module or install a miniapp.

Runtime's startup check requires **exact equality** between each of the first
five flags below and the corresponding enabled module. A flag must be `true`
when that module is present and `false` when it is absent. Mismatches in either
direction fail startup.

| Field | App capability | Required Runtime relationship |
| --- | --- | --- |
| `features.runtimeRealtimeSession` | Persistent Runtime realtime/audio session | Equals whether `realtime-audio` is enabled. `false` still permits configured Runtime HTTP services. |
| `features.managedStreams` | Runtime-managed camera streaming | Equals whether `camera` is enabled. `camera` also requires `realtime-audio`. |
| `features.nativeMeetings` | Host-native meeting integration and credentials | Equals whether `meetings` is enabled. Also requires both Teams scopes for current Entra enrollment. |
| `features.cloudSpeech` | Cloud speech capability | Equals whether `realtime-audio` is enabled in the current validator. Enabling `tts` alone does not satisfy this flag. |
| `features.navigation` | Navigation capability | Equals whether `maps` is enabled. |
| `features.onDeviceSpeech` | On-device speech initialization and requests | No Runtime module equality check. Custom model URL routing is not implemented; see Artifacts. |

For `RUNTIME_SERVICES=meetings`, use the complete example's flags. Runtime's
implicit `full` profile is `realtime-audio,camera,maps,tts`; it does not include
`meetings`. Configure the explicit profile needed by your deployment.
`nativeMeetings: true` exposes a host capability; it does not itself provide a
working calling miniapp or qualify the native media path.

## Telemetry

`telemetry` is a required boolean. `false` prevents Mentra-owned app telemetry
from being enabled for the selected workspace. `true` permits the app's
configured Mentra telemetry; it does not redirect telemetry to customer
servers. There are no per-provider telemetry endpoint fields in schema v1.

This setting is not a network firewall for miniapps or identity/media
providers. The current Entra/ACS meetings profile requires Microsoft network
access and is a Private Deployment with restricted networking, not a fully
disconnected profile.

## Validation and troubleshooting

Validate the document against both the
[mobile schema](../../mobile/src/services/deployment/schema.ts) and
[workspace resolver rules](../../mobile/src/services/deployment/resolver.ts).
Runtime startup additionally checks the
[feature/module relationships](../packages/runtime/src/services/deployment-manifest.ts)
and, when configured to serve bundles, the managed ZIPs. A healthy Runtime or
valid JSON syntax alone does not prove the phone will accept the manifest.

Check the published endpoint and the reference stack from a network with the
same access as the phone:

```bash
curl --fail --show-error \
  https://workspace.acme.example/.well-known/mentra-deployment.json | jq .
cloud-v2/deploy/azure/enterprise-reference/scripts/smoke-test.sh \
  https://workspace.acme.example
```

The smoke test expects the reference deployment's routes and assets. Follow
it with organization selection, sign-in, relaunch, logout, and feature tests
on both supported phone platforms.

| Symptom | Check |
| --- | --- |
| Workspace cannot load | DNS/TLS, the fixed well-known path, direct successful JSON response, no redirect/login page, timeout, and body size. |
| Manifest does not match the schema | Missing nullable fields, unknown keys, wrong types, unsupported schema version, or configuration limits. |
| Origin mismatch | Runtime, both logos, and all managed ZIPs must use the entered workspace origin. Core may differ. |
| Authentication configuration rejected | Exact tenant authority, Mobile UUID, application API session scopes, supported Teams scopes, and both Teams scopes when meetings are enabled. |
| Microsoft requests admin approval | Complete Entra consent and assignment; editing manifest scopes alone does not grant permissions. |
| Runtime refuses to start | Exact feature/module equality, camera's realtime dependency, or missing/mismatched image-served ZIPs. |
| Only Settings appears | Check the system allowlist and managed list; the reference intentionally approves only Settings. |
| Phone Mode is missing | Include `simulated-glasses` in a non-null glasses allowlist. |
| A managed miniapp does not install | Check ZIP reachability, size, SHA-256, inner package/version, system-package conflicts, and existing install ownership. |
| Published edits do not appear on the phone | Redeploy/restart Runtime as needed, then log out and select the workspace again to replace the cached snapshot. |
| Required update has no store button | Null platform store URL selects managed-update guidance. Supply a support URL or distribute the new app through the organization's channel. |

Maintainers should keep this reference aligned with the schema, resolver,
[system package list](../../mobile/src/constants/miniapps.ts), and
[glasses model mapping](../../mobile/src/services/deployment/glassesPolicy.ts)
when changing the contract.
