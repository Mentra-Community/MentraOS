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
- No public-network access after device and app provisioning.

Core is required for this first version. The current Mentra App uses Core for
account login and refresh, subject-token minting, the minimum-client-version
check, Runtime token exchange, settings, and
reports. A Runtime-only Mentra App is possible later, but it requires a new
identity/authentication mode rather than another manifest field.

The standalone Bluetooth SDK deployment remains independent and does not need
Core or Runtime.

## One configuration path

The application always consumes the same typed deployment object:

1. An MDM-managed manifest URL, when present.
2. A manifest URL enrolled explicitly by scanning a QR code.
3. The embedded Mentra deployment profile shipped in the app.

The embedded profile contains the same schema used by customer manifests. It is
not a separate set of defaults scattered through the app.

The QR code is deliberately simple:

```text
mentra://deployment?url=https%3A%2F%2Fconfig.example.internal%2Fmentra%2F3.1.0%2Fmentra-deployment.json
```

The app validates and downloads the JSON, shows the deployment name and service
hosts for confirmation, and persists the URL plus the last valid JSON. HTTPS and
the device trust store authenticate the server; manifest signing is not required
for the first implementation.

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
    "mode": "managed"
  },
  "features": {
    "cloudSpeech": true,
    "onDeviceSpeech": true,
    "navigation": false,
    "externalLinks": false,
    "ar99VendorServices": false
  },
  "telemetry": {
    "sentry": false,
    "posthog": false,
    "firebaseAnalytics": false
  }
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
- Missing fields are validation errors. A custom deployment never inherits a
  public Mentra endpoint from compiled code.
- The document contains no passwords, bearer tokens, private keys, or provider
  secrets. Those remain in MDM secret delivery or server configuration.
- The first private profile exposes email/password sign-in only. Google, Apple,
  signup, email verification, and password recovery stay hidden unless the
  deployment explicitly supports their required network services.
- `appUpdates.mode: "managed"` replaces public App Store/Play Store links with
  an administrator-managed update message. The embedded Mentra profile uses
  store mode and contains the normal public store URLs.

The schema can later replace the two model base URLs with a checksum-bearing
model catalog. That is valuable because STT downloads currently have no archive
hash verification, but it does not need to block the configuration foundation.

## Boot sequence

```text
load local settings
  -> resolve embedded / MDM / enrolled deployment
  -> validate release identity and schema
  -> expose immutable active deployment
  -> initialize allowed telemetry
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

The STT and TTS managers replace their hard-coded GitHub base URLs with values
from Engine configuration. Their existing filenames and extraction flow remain
unchanged in v1.

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

Optional public-network features are fail-closed in a customer profile:

- Mapbox directions/geocoding and native navigation are unavailable when
  `navigation` is false.
- AR99 vendor APIs are unavailable when `ar99VendorServices` is false.
- Public wallpapers, docs, privacy, store, and review links are hidden when
  `externalLinks` is false.
- Google and Apple SSO, account creation, verification email, and password
  recovery are hidden unless enabled by the active auth configuration.
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
2. MDM or a QR code selects a customer manifest before sign-in.
3. Login, refresh, Runtime connection, cloud STT/TTS, settings, registry, and
   enabled miniapps use customer-hosted Core and Runtime.
4. Mentra Live OTA works through the existing Engine hotspot flow using the
   customer-hosted OTA bundle.
5. On-device STT and TTS download from the customer mirror.
6. Sentry, PostHog, Firebase, Mapbox, AR99, GitHub, Mentra, and other public
   destinations receive no traffic during a packet-capture test.
7. The embedded Mentra profile still passes the normal coordinated release and
   consumer app tests.

## Explicitly later

- Runtime-only deployments with a customer IdP or token broker.
- Local-only Engine startup with no Core, Runtime, or auth seam.
- Signed deployment manifests or customer-managed signing keys.
- Dynamic private certificate pinning.
- Customer branding or bundle identifiers.
- A standalone public hotspot OTA coordinator in the raw Bluetooth SDK.
