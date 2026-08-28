---
status: draft
owner: Mentra
---

# Mentra App deployment manifest design

## Outcome

The same official Mentra App binary can run against Mentra's public services or a
customer-controlled deployment. A small deployment manifest selects the Core,
Runtime, Mentra Live OTA, and speech-model locations and disables features that
would otherwise contact public services.

This is an operating mode of the Mentra App and Mentra Engine, not a customer
fork, branded build, or second release pipeline.

## First supported deployment

The first supported private Mentra App deployment requires:

- The official Mentra App binary from one completed coordinated release.
- Customer-hosted Cloud V2 Core and Runtime services from that release.
- The matching self-hosted Mentra Live OTA bundle.
- Customer-hosted copies of the on-device STT and TTS model archives the
  deployment enables.
- A customer deployment manifest reachable by the phone before sign-in.
- Mentra Live as the only glasses model qualified for the first private pilot.
- No public-network access after device and app provisioning.

Core is required for this first version. The current Mentra App uses Core for
account login and refresh, subject-token minting, the minimum-client-version
check, Runtime token exchange, preinstalled miniapp registry, settings, and
reports. A Runtime-only Mentra App is possible later, but it requires a new
identity/authentication mode rather than another manifest field.

Decision: do not separate Core as part of the deployment-manifest foundation.
Package the required Core subset with the first private deployment and keep its
client boundary deployment-scoped. Separating identity and the remaining
control-plane APIs can then happen behind that boundary without changing the
manifest resolver or creating a second app path.

The standalone Bluetooth SDK deployment remains independent and does not need
Core or Runtime.

## One configuration path

The application always consumes the same typed deployment object, but a new
installation does not need a deployment selected before it can render a local
landing screen.

The landing screen offers the ordinary Mentra sign-in choices plus a private
deployment entry point:

- Google
- Apple, where supported
- Email
- Enterprise / SSO

Google, Apple, or Email activates the embedded Mentra deployment profile before
starting that authentication flow. Enterprise / SSO opens deployment enrollment
and accepts a QR code or manually entered manifest URL. After the custom manifest
loads, the app renders the authentication methods declared by that deployment.
The enrollment QR selects configuration; it is not itself an authentication
credential unless the selected deployment later defines a QR-based auth method.

An MDM-managed manifest URL takes precedence and can bypass the landing choice.
A previously selected custom deployment is restored on subsequent boots. The
embedded Mentra profile is the one complete set of defaults. A customer
manifest uses the same schema as a partial override of that profile, so the app
has one resolution path rather than separate consumer and enterprise branches.

The QR code is deliberately simple:

```text
mentra://deployment?url=https%3A%2F%2Fconfig.example.internal%2Fmentra%2F3.1.0%2Fmentra-deployment.json
```

The app validates and downloads the JSON, shows the deployment name and service
hosts for confirmation, and persists the URL plus the last valid JSON. HTTPS and
the device trust store authenticate the server; manifest signing is not required
for the first implementation.

After confirmation, the app opens that deployment's authentication screen. An
email/password deployment with `allowSignup: true` offers both sign-in and
account creation against the configured Core. With `allowSignup: false`, it
offers sign-in only and the customer must pre-provision accounts or configure an
SSO method. Account verification, password reset, and SSO callbacks also return
to the selected deployment. The QR only chooses configuration; it does not
create an account or session.

On subsequent boots, the app loads the saved profile before starting any
network-capable service. It refreshes the configured URL when reachable and can
use the last valid cached copy while disconnected. If a custom profile has never
loaded successfully, boot stops at local deployment setup; it never falls back
to the embedded Mentra profile.

## Manifest v1

```json
{
  "schemaVersion": 1,
  "deploymentId": "example-corp",
  "displayName": "Example Corp Mentra",
  "releaseIdentity": "3.1.0",
  "services": {
    "coreUrl": "https://core.example.internal",
    "runtimeUrl": "https://runtime.example.internal"
  },
  "auth": {
    "methods": ["email-password"],
    "allowSignup": false,
    "allowPasswordReset": false
  },
  "artifacts": {
    "mentraLiveOtaManifestUrl": "https://updates.example.internal/mentra/3.1.0/version.json",
    "sttModelBaseUrl": "https://updates.example.internal/mentra/3.1.0/models/stt/",
    "ttsModelBaseUrl": "https://updates.example.internal/mentra/3.1.0/models/tts/"
  },
  "appUpdates": {
    "mode": "managed",
    "storeUrls": {
      "android": null,
      "ios": null
    },
    "reviewUrls": {
      "android": null,
      "ios": null
    }
  },
  "content": {
    "wallpaperUrls": [
      "https://updates.example.internal/mentra/3.1.0/wallpapers/landscape1.jpeg"
    ]
  },
  "links": {
    "privacyPolicyUrl": "https://portal.example.internal/privacy",
    "termsOfServiceUrl": "https://portal.example.internal/terms",
    "documentationUrl": "https://docs.example.internal/mentra",
    "supportUrl": "https://support.example.internal/mentra"
  },
  "systemMiniapps": {
    "approvedPackageNamesOverride": [
      "com.mentra.camera",
      "com.mentra.gallery",
      "com.mentra.settings"
    ]
  },
  "glasses": {
    "allowedModelsOverride": ["mentra-live"]
  },
  "features": {
    "cloudSpeech": true,
    "onDeviceSpeech": true,
    "navigation": false
  },
  "telemetry": false
}
```

Rules:

- `deploymentId` is stable and namespaces credentials, caches, and settings.
- `releaseIdentity` must exactly match the installed coordinated Mentra release.
  This prevents an app, Engine, SDK, and OTA bundle from different release sets
  being combined accidentally.
- URLs must be absolute HTTPS URLs outside development builds.
- The OTA URL points at the `version.json` generated from the matching portable
  OTA bundle.
- Model base URLs preserve the existing model archive filenames so a customer
  can mirror the files without a new model protocol in v1.
- `content.wallpaperUrls` is the complete preset-wallpaper catalog. An empty
  array means no remote presets; the app does not fall back to Mentra wallpaper
  hosts. Choosing a local photo remains available independently.
- Privacy and terms URLs belong to the active deployment and remain available
  wherever the app presents legal text. Documentation and support URLs are
  deployment-specific rather than controlled by a blanket external-links flag.
- Mobile distribution-store and review URLs belong to `appUpdates`, not to the
  system-miniapp policy. Null review URLs suppress review prompts. Managed mode
  uses administrator-provided update instructions instead of a public store.
  The Mentra Miniapp Store is a separate in-app system entry and is governed by
  its package name in the system-miniapp policy.
- `systemMiniapps.approvedPackageNamesOverride` is either `null` or a complete
  allowlist of stable miniapp package names. `null` means use the app release's
  full built-in system-miniapp catalog and automatically includes future
  additions; the embedded Mentra profile uses `null`. An array activates the
  override: `[]` approves no system miniapps, while a populated array approves
  only those packages. Customer manifests should use an explicit array so a
  future Mentra App release cannot expose a newly added system miniapp without
  customer approval.
- A system miniapp outside the active approved set is not registered in
  user-visible catalogs, menus, or deep-link launch routes, although its code
  remains present in the common app binary.
- `glasses.allowedModelsOverride` contains stable model identifiers from the
  common glasses registry. When present, the pairing UI shows only those
  models. When omitted, the normal supported-model list is shown. This is a UI
  catalog override, not a security boundary, and does not add model checks to
  scanning, deep links, or reconnection. It also does not make a model's vendor
  services air-gap compatible.
- The manifest never exposes model-specific switches such as
  `ar99VendorServices`. Vendor-specific transports and update behavior remain
  behind each glasses adapter. A deployment that permits only selected hardware
  customizes the pairing catalog through the general model override.
- The embedded Mentra profile is complete. A customer manifest is recursively
  merged over it: omitted fields inherit the Mentra value, arrays replace the
  inherited array, and an explicit `null` disables fields documented as
  nullable. Validation runs on the resolved profile. Strictly air-gapped
  deployments must inspect that resolved profile and override or null every
  inherited public-network destination before qualification.
- The document contains no passwords, bearer tokens, private keys, or provider
  secrets. Those remain in MDM secret delivery or server configuration.
- The pre-deployment landing screen always exposes the supported consumer
  choices and the Enterprise / SSO enrollment entry. Once a custom deployment
  is selected, only that manifest's auth methods and supporting flows are shown.
- `appUpdates.mode: "managed"` replaces public App Store/Play Store links with
  an administrator-managed update message. The embedded Mentra profile uses
  store mode and contains the normal public store and review URLs.
- `telemetry` is one master switch. `false` prevents Sentry, PostHog, and
  Firebase Analytics from initializing; v1 does not expose independent vendor
  switches.

The embedded Mentra profile must stop fetching speech archives directly from
the upstream Sherpa-ONNX GitHub release. Mentra will mirror the exact approved
archives into a Mentra-owned Cloudflare R2 bucket behind a custom domain such as
`models.mentra.glass`, preserving the existing filenames and recording the
upstream source and license. Customer deployments can mirror those same files
without changing the app's download protocol. The schema can later replace the
two base URLs with a checksum-bearing model catalog; that is valuable because
STT downloads currently have no archive hash verification, but it does not need
to block the configuration foundation or the move to Mentra-owned hosting.

## Boot sequence

```text
load local settings
  -> resolve MDM / previously enrolled deployment, if present
  -> otherwise render the local consumer-or-enterprise landing screen
  -> consumer choice activates embedded Mentra deployment
  -> enterprise choice enrolls and validates a custom deployment
  -> validate release identity and schema
  -> expose immutable active deployment
  -> initialize telemetry only when the resolved master switch is true
  -> create the deployment-scoped auth provider
  -> run the configured Core version check
  -> engine.configure({ auth, config: deployment })
  -> engine.start()
```

Changing deployment is a controlled logout operation:

1. Stop Engine and auth refresh.
2. Clear or switch to the new deployment's credential namespace.
3. Save and activate the new manifest.
4. Restart through the normal boot route.

Credentials must not be shared across deployment ids. Today account tokens and
the cloud client's secure state use global keys; they must be namespaced or
cleared before endpoint switching.

## Engine contract

Core and Runtime URL injection already exists through
`engine.configure({config: {coreUrl, runtimeUrl}})`. Extend the Engine config with:

- `otaManifestUrl`
- `sttModelBaseUrl`
- `ttsModelBaseUrl`
- The feature flags the Engine itself enforces

Manifest selection for modern Mentra Live becomes:

1. Super Mode developer override.
2. Active deployment's OTA manifest URL.
3. The embedded coordinated-release pin from the embedded Mentra profile.

The customer profile therefore drives both the phone-side OTA check and the
existing Engine hotspot relay. The Bluetooth SDK continues to accept only the
resolved Mentra Live manifest URL and remains unaware of the larger deployment
manifest.

The STT and TTS managers replace their hard-coded upstream GitHub base URLs with
values from Engine configuration. The embedded Mentra profile points to the
Mentra-owned R2 custom domain, while customer profiles may point to an internal
mirror. Existing filenames and extraction flow remain unchanged in v1.

## Network-capable app behavior

The deployment must be resolved before these existing call sites run:

- `SentrySetup()` in the root layout.
- The PostHog provider in `AllProviders`.
- Firebase Analytics initialization.
- `AuthProvider`, whose account client calls Core during mount.
- The minimum-client-version request in the initial route.
- `engine.start()`, which constructs and connects Cloud Client.

For the same binary to be safe in a restricted deployment, native Firebase
analytics collection should default off in the binary and be enabled only after
the embedded Mentra profile is active. Sentry and PostHog should likewise be
started only after profile resolution.

The resolved profile controls optional network-capable behavior:

- Mapbox directions/geocoding and native navigation are unavailable when
  `navigation` is false.
- Preset wallpapers come only from `content.wallpaperUrls`; no compiled public
  wallpaper list is appended.
- Legal, documentation, support, app-store, and review destinations come from
  their resolved manifest fields. An omitted customer override inherits the
  embedded Mentra value; an explicit null suppresses a nullable destination.
  There is no global `externalLinks` switch.
- System miniapps outside an active approval override cannot be discovered or
  launched, including through direct routes. The common binary still contains
  their implementation.
- The pairing model picker shows only `glasses.allowedModelsOverride` when that
  override is present; otherwise it shows the normal supported-model catalog.
- The first private template exposes only Mentra Live. A different model may be
  added only after its adapter has been qualified with public internet blocked
  and any required vendor endpoints have been removed, disabled, or made
  customer-configurable. AR99's current public OTA/vendor-service calls are
  therefore outside the first private deployment rather than controlled by an
  AR99-specific manifest switch.
- Google, Apple, and Email on the initial landing screen select the embedded
  Mentra profile. After enterprise enrollment, the app displays the selected
  deployment name and that profile's login methods. For email/password,
  `allowSignup: true` exposes account creation against the customer Core;
  `false` means users must be pre-provisioned or use a configured SSO method.
  Verification and recovery appear only when the resolved auth configuration
  supports them. Scanning the deployment QR never signs the user in by itself.
- Miniapp package and media URLs supplied by customer-hosted Core remain the
  customer's responsibility.
- Runtime speech-provider egress is server-side configuration. A private Runtime
  must use customer-approved providers or on-premises services; the phone
  manifest cannot make Soniox or ElevenLabs private.

The official binary will still contain optional vendor SDK code and public
tokens used by the Mentra profile. Runtime policy prevents egress; it does not
remove those bytes. A customer whose policy prohibits the presence of that code
would need a different native build, which is outside this same-binary design.

## Distribution

The coordinated release is already the correlation mechanism. Its completed
`mentra-release-<identity>.json` records the exact Android app, iOS app, Engine,
Bluetooth SDK, OTA bundle, hashes, and provenance.

For an Android private deployment, a customer can import the exact Mentra-signed
APK from the completed GitHub release and install or update it through MDM. This
is the same app binary produced by the normal coordinated release.

For iOS, use the normal App Store app through Apple Business Manager/MDM and
deliver the manifest URL as managed app configuration. The current App Store IPA
is not a generally sideloadable offline package. Strictly disconnected first
installation would require a separately provisioned in-house distribution and
periodic Apple certificate validation, so the same-binary promise should be
stated as disconnected operation after Apple/MDM provisioning on iOS.

Apple documents [managed app configuration](https://support.apple.com/guide/deployment/distribute-managed-apps-dep575bfed86/web),
[Custom App distribution through Apple Business Manager](https://support.apple.com/guide/deployment/distribute-custom-apps-dep0113f6e18/web),
and the additional provisioning/certificate requirements for
[self-hosted in-house IPA distribution](https://support.apple.com/guide/deployment/distribute-proprietary-in-house-apps-depce7cefc4d/web).

Add two release artifacts after the runtime work exists:

- `mentra-deployment-template-<identity>.json`
- `mentra-speech-models-<identity>.zip` (or a separately versioned model bundle)

Do not create a second mobile build lane. The template, speech models, existing
Mentra Live OTA bundle, app binaries, and completed release record all attach to
the same coordinated release.

## MVP acceptance

The first Android pilot is complete when:

1. The official release APK starts with public internet blocked.
2. Google, Apple, or Email selects the embedded Mentra profile, while MDM or the
   Enterprise / SSO QR flow selects a customer manifest before private sign-in.
3. Login, refresh, Runtime connection, cloud STT/TTS, settings, registry, and
   enabled miniapps use customer-hosted Core and Runtime.
4. Mentra Live OTA works through the existing Engine hotspot flow using the
   customer-hosted OTA bundle.
5. On-device STT and TTS download from the customer mirror.
6. Preset wallpapers, resolved legal/support links, system-miniapp visibility,
   and the pairing model list follow the active deployment override.
7. Sentry, PostHog, Firebase, Mapbox, GitHub, Mentra, and other public
   destinations receive no traffic during a packet-capture test.
8. The embedded Mentra profile still passes the normal coordinated release and
   consumer app tests.

## Explicitly later

- Runtime-only deployments with a customer IdP or token broker.
- Separating account, registry, settings, version-check, and reporting APIs from
  Core into a smaller control-plane service.
- Local-only Engine startup with no Core, Runtime, or auth seam.
- Signed deployment manifests or customer-managed signing keys.
- Dynamic private certificate pinning.
- Customer branding or bundle identifiers.
- A standalone public hotspot OTA coordinator in the raw Bluetooth SDK.
- Restricted-network qualification and endpoint configuration for non-Mentra
  glasses adapters, including AR99 vendor services.
