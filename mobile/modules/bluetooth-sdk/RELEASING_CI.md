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

The same identity and immutable OTA manifest pin are embedded in the SDK's npm,
Maven, and SwiftPM packages. The workflow publishes the Engine dependency
closure first, then verifies the native and npm SDK packages before publishing
the Engine and mobile apps.

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
- the existing Android, Google Play, App Store Connect, and Match credentials

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
4. Once the first coordinated npm, Maven, and SwiftPM packages are public,
   install them into the external OEM and Starter Kit examples from their real
   registries. Build the Android and iOS examples before production promotion.
5. Update public docs and downloadable example links only after those registry
   and example-artifact checks pass.

The source-tree package and OEM gates run before publication, but they cannot
substitute for the first registry-backed consumer build because the coordinated
package coordinates do not exist publicly yet.

The full contract, artifact naming rules, and verification gates are documented
in `notes/coordinated-release-system-proposal.md`.
