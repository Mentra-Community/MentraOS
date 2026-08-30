# Bluetooth SDK Release CI

Bluetooth SDK releases are part of the coordinated Mentra product release.
There is no independent SDK branch or automatic SDK publisher.

## Prereleases

A selected `dev` or `staging` head runs
`.github/workflows/coordinated-release.yml` and allocates one shared identity:

| Branch    | Identity       | npm tag | Mobile destination                        |
| --------- | -------------- | ------- | ----------------------------------------- |
| `dev`     | `X.Y.Z-dev.N`  | `dev`   | Play internal and TestFlight `Mentra Dev` |
| `staging` | `X.Y.Z-beta.N` | `beta`  | Play beta and TestFlight `Mentra Staging` |

Each channel keeps one running publication plus its latest pending head. A new
same-branch push replaces only an older pending run; it never cancels the
running publication. `dev` and `staging` have separate groups and cannot replace
one another. Commit bursts therefore publish the running head and newest
waiting head, not every intermediate commit.

`staging` names the beta release channel and its mobile builds use staging
services. They are tested beta artifacts, not production-promotable binaries.
Production mobile candidates are rebuilt from the selected source after Cloud
deployment, with production configuration and new store build numbers.

The same identity and immutable OTA manifest pin are embedded in the SDK's npm,
Maven, and SwiftPM packages. One npm lane publishes the dependency closure in
topological order. Native SDK and mobile jobs run in parallel after OTA
selection. Finalization waits for a clean registry-backed Engine host to resolve
and build on Android and iOS.

The ASG APK is rebuilt only when its complete build-input fingerprint changes.
Otherwise the coordinated OTA workflow reuses the exact previously verified
APK and records that provenance in the release manifest.

Reusable ASG APK/provenance pairs live in the shared
`mentra-coordinated-asg` release. Each coordinated prerelease owns its OTA
manifest, ASG selection, and portable bundle; those release-specific assets do
not accumulate in a shared release.

## Production

Follow [the production release runbook](../../../.github/production-release/README.md)
from a clean `main` checkout and start with a completed `X.Y.Z-beta.N` identity.
The phase-specific system verifies and freezes the selected beta before any
protected production action. It then:

1. publishes stable SDK and Engine packages from the same source and OTA pin;
2. builds a clean external Engine host from those public packages;
3. rebuilds production-configured mobile candidates from the frozen source and
   uploads them to isolated candidate groups/tracks;
4. moves public package pointers only after all targets succeed.

Production consumes the immutable OTA pin and stable package family. It does
not rebuild ASG/firmware artifacts, but it does rebuild the Mentra App IPA/AAB
and Starter Kit app candidates because beta mobile configuration points at
staging.

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
- `DOPPLER_TOKEN_MOBILE_DEV`
- `DOPPLER_TOKEN_MOBILE_PRD`
- `SENTRY_AUTH_TOKEN`
- `EXPO_PUBLIC_AR99_RELEASE_DEVELOPER_ID`
- `EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY`

Configure the protected environments named in the production release runbook
before enabling production promotion.

## First Coordinated Release Gates

Before the first production promotion:

1. Create every protected environment listed in the production release runbook
   and configure the required distinct reviewers.
2. Confirm the App Store Connect API key can upload builds and distribute them
   to the existing `Mentra Dev` and `Mentra Staging` TestFlight groups. Confirm
   the Google Play credentials can use the configured internal and beta tracks.
3. Complete one `dev` and one `staging` coordinated run. Verify their release
   manifests, public package metadata, OTA manifest bytes, mobile diagnostics,
   and store destinations before selecting a beta for production. Confirm each
   prerelease owns its manifest, selection, and bundle, while the shared ASG
   release contains only reusable APK/provenance pairs.
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
