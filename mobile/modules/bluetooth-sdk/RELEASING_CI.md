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
and Bluetooth example app candidates because beta mobile configuration points at
staging. The production release container also receives byte-identical copies
of the promoted beta's OTA manifest and portable OTA bundle.

## Bluetooth Examples And The Starter Kit

The Bluetooth SDK examples live in `examples/bluetooth`. Each coordinated
release builds them from that source, in parallel with the package and app
builds and stamped with the same release metadata and OTA pin
(`reusable-bluetooth-examples.yml`), which uploads the example APKs and the
unsigned iOS IPA to the release container under deterministic names. After
finalize, the release page lists them, and the React Native example goes to
TestFlight and Google Play. Examples never gate the release.

The standalone
[Starter Kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit)
is exported from the latest completed release record of each channel by
`bluetooth-starter-kit-export.yml`: `examples/bluetooth` at the release's source,
with every SDK reference pinned to the published npm, Maven Central and Swift
Package Manager packages, pushed as one `Release <identity>` commit and an
`sdk-<identity>` tag to the channel's branch (`dev`, `staging` for beta, `main`
for production). It runs every 30 minutes: a cheap first check stops at once
when the kit already has the release, or when npm, Maven Central, the Swift
package or the OTA manifest do not serve it yet; a later run retries. The export
always means each channel's latest completed release: intermediate releases are
skipped, and a manual dispatch (optionally a dry run) runs the same check.

The kit keeps its own `.github`. Its `Example App Builds` workflow runs on every
push to `dev`, `staging` and `main`, so each export commit is validated as an
external consumer would build it: see the kit's Actions tab, Example App Builds,
filtered by the channel's branch.

## Portable OTA Bundle

Beta releases publish `mentra-live-ota-bundle-<identity>.zip` for self-hosted
updates. Development releases publish only the OTA manifest. A production
release publishes byte-identical copies of the promoted beta's manifest and
bundle as `mentra-live-ota-<X.Y.Z>.json` and `mentra-live-ota-bundle-<X.Y.Z>.zip`
in `mentra-v<X.Y.Z>` and lists them in its release record and download page.

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
   prerelease owns its manifest and selection (and, for a beta, its bundle),
   while the shared ASG release contains only reusable APK/provenance pairs.
4. Confirm the automated external Engine consumer gate installs the exact
   public npm graph and builds its Android and iOS hosts. Once Maven and SwiftPM
   are public, confirm the Starter Kit export pushed the release and its
   registry-backed `Example App Builds` passed before production promotion.
5. Update public docs and downloadable example links only after those registry
   and example-artifact checks pass.

Pull-request dry runs use source-tree package and OEM gates. The coordinated
release's registry-backed consumer gate runs only after publication because the
new coordinates do not exist publicly before then; failure leaves the GitHub
release incomplete and prevents release-manifest finalization.

The full contract, artifact naming rules, and verification gates are documented
in `notes/coordinated-release-system-proposal.md`.
