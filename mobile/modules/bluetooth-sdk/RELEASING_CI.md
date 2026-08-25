# Bluetooth SDK Release CI

Bluetooth SDK releases are part of the coordinated Mentra product release.
There is no independent SDK branch or automatic SDK publisher.

## Prereleases

A push to `dev` or `staging` runs
`.github/workflows/coordinated-release.yml` and allocates one shared identity:

| Branch    | Identity       | npm tag | Mobile destination               |
| --------- | -------------- | ------- | -------------------------------- |
| `dev`     | `X.Y.Z-dev.N`  | `dev`   | Play internal and TestFlight Dev |
| `staging` | `X.Y.Z-beta.N` | `beta`  | Play beta and TestFlight Beta    |

`staging` names the beta release channel, not the backend. Dev artifacts use
development services. Beta artifacts use production services because the exact
signed AAB and IPA are promoted through the stores without rebuilding,
rewriting configuration, or re-signing. A staging-services diagnostic build is
not a production candidate.

The same identity and immutable OTA manifest pin are embedded in the SDK's npm,
Maven, and SwiftPM packages. One npm lane publishes the dependency closure in
topological order. Native SDK and mobile jobs run in parallel after OTA
selection. Finalization waits for a clean registry-backed Engine host to resolve
and build on Android and iOS.

The ASG APK is rebuilt only when its complete build-input fingerprint changes.
Otherwise the coordinated OTA workflow reuses the exact previously verified
APK and records that provenance in the release manifest.

## Production

Run `.github/workflows/coordinated-production-promotion.yml` with a completed
`X.Y.Z-beta.N` identity. The protected promotion:

1. verifies the selected beta manifest and every recorded artifact;
2. requires the selected source commit to be present in `main`;
3. promotes the exact tested mobile and OTA artifacts;
4. publishes stable SDK and Engine packages from the same source and OTA pin;
5. moves public package pointers only after all targets succeed.

Production does not rebuild the ASG, OTA bundle, IPA, or Android App Bundle.

## Required Credentials

The coordinated workflows use these repository secrets:

- `NPM_TOKEN`
- `MAVEN_CENTRAL_TOKEN_BASE64`
- `MAVEN_SIGNING_KEY`
- `MAVEN_SIGNING_PASSWORD`
- `MENTRA_BLUETOOTH_SDK_IOS_PUSH_TOKEN`
- `ASG_KEYSTORE_B64`
- `ASG_STORE_PASSWORD`
- `ASG_KEY_PASSWORD`
- `ASG_KEY_ALIAS`
- `MAPBOX_DOWNLOADS_TOKEN`
- `UPLOAD_KEYSTORE_B64`
- `MENTRAOS_UPLOAD_STORE_PASSWORD`
- `MENTRAOS_UPLOAD_KEY_PASSWORD`
- `MENTRAOS_UPLOAD_KEY_ALIAS`
- `GOOGLE_PLAY_KEY_JSON`
- `ASC_API_KEY_P8_B64`
- `ASC_API_KEY_ID`
- `ASC_API_ISSUER_ID`
- `MATCH_PASSWORD`
- `MATCH_GIT_BASIC_AUTHORIZATION`
- `MAPBOX_PUBLIC_TOKEN`
- `DOPPLER_TOKEN`
- `SENTRY_AUTH_TOKEN`
- `EXPO_PUBLIC_AR99_RELEASE_DEVELOPER_ID`
- `EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY`

Configure required reviewers on the `coordinated-production-release` GitHub
environment before enabling production promotion.

## First Coordinated Release Gates

Before the first production promotion:

1. Create the `coordinated-production-release` GitHub environment and configure
   its required reviewers. The workflow deliberately references this exact name
   and must remain blocked until the environment protection exists.
2. Confirm the App Store Connect API key can upload builds and distribute them
   to the existing `Dev` and `Beta` TestFlight groups. Confirm the Google Play
   credentials can use the configured internal and beta tracks.
3. Complete one `dev` and one `staging` coordinated run. Verify their release
   manifests, public package metadata, OTA manifest bytes, mobile diagnostics,
   and store destinations before selecting a beta for production.
4. Confirm the automated external Engine consumer gate installs the exact
   public npm graph and builds its Android and iOS hosts. Once Maven and SwiftPM
   are public, install the coordinated SDK into the Starter Kit examples and
   build all three examples before production promotion.
5. Update public docs and downloadable example links only after those registry
   and example-artifact checks pass.

Pull-request dry runs use source-tree package and OEM gates. The coordinated
release's registry-backed consumer gate runs only after publication because the
new coordinates do not exist publicly before then; failure leaves the GitHub
release incomplete and prevents release-manifest finalization.

The full contract, artifact naming rules, and verification gates are documented
in `notes/coordinated-release-system-proposal.md`.
