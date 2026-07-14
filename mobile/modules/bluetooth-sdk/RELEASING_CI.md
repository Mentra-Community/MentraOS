# Bluetooth SDK Release CI

The Bluetooth SDK release workflow lives at
`.github/workflows/bluetooth-sdk-release.yml`. During initial validation it runs
on pushes to `dev` that touch the SDK package, the release workflow, or the
SwiftPM export script. After the workflow has been proven end-to-end, switch the
trigger and publish guard back to `staging` before using it as the durable SDK
release path.
A release is only attempted when the `version` field in
`mobile/modules/bluetooth-sdk/package.json` changes compared with the previous
`dev` commit.

The same version drives all public artifacts:

- ASG OTA manifest:
  `https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-VERSION-version.json`
- ASG APK release asset under the persistent `bluetooth-sdk-ota` release tag
- npm staged package: `@mentra/bluetooth-sdk`
- Maven Central: `com.mentraglass:bluetooth-sdk` and `com.mentraglass:lc3Lib`
- SwiftPM: tag `VERSION` in `Mentra-Community/mentra-bluetooth-sdk-ios`

The rolling staging OTA manifest (`staging_live_version.json`), the
`staging-builds` release, and the 7-day cleanup for dated rolling staging APKs
remain separate. SDK OTA APKs are never uploaded into the rolling cleanup bucket.

## Required Registry Settings, GitHub Secrets, and Variables

Configure npm Trusted Publishing for `@mentra/bluetooth-sdk` before relying on
the workflow for a real npm stage release:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Mentra-Community` |
| Repository | `MentraOS` |
| Workflow filename | `bluetooth-sdk-release.yml` |
| Environment name | Leave blank unless the workflow starts using a GitHub environment |
| Allowed actions | `npm stage publish` |

Trusted Publishing requires GitHub-hosted runners, Node 22.14 or newer, and npm
11.15 or newer for staged publishing. The workflow runs the npm job on
`ubuntu-latest`, sets up Node 24, and updates npm before staging.

After the Trusted Publisher is configured and verified, set the package's npm
Publishing access to require 2FA and disallow tokens.

Create these in the `Mentra-Community/MentraOS` repository before relying on the
workflow for a real release:

| Name | Type | Purpose |
| --- | --- | --- |
| `MAVEN_CENTRAL_TOKEN_BASE64` | Secret | Base64 string of `username:password` for the Sonatype Central publishing token. |
| `MAVEN_SIGNING_KEY` | Secret | ASCII-armored PGP private key used by Gradle in-memory signing. |
| `MAVEN_SIGNING_PASSWORD` | Secret | Passphrase for `MAVEN_SIGNING_KEY`. |
| `MENTRA_BLUETOOTH_SDK_IOS_PUSH_TOKEN` | Secret | GitHub token with write access to `Mentra-Community/mentra-bluetooth-sdk-ios` for pushing `main` and version tags. |
| `SONATYPE_PUBLISHING_TYPE` | Variable | Sonatype Central upload mode; keep `user_managed` unless maintainers intentionally switch to an automatic release mode. |

## Flow

1. The detector job reads `mobile/modules/bluetooth-sdk/package.json` at `HEAD`
   and at the prior push SHA. If the version did not change, the workflow exits
   after writing a summary. If GitHub does not provide a usable prior push SHA,
   the detector fails closed; rerun with `workflow_dispatch` and
   `force_release=true` after confirming the version should release.
2. The SDK OTA job builds the ASG client APK from the same release commit,
   assigns a canonical `asgVersion`, and generates an immutable SDK-to-ASG
   manifest. `asgVersion` continues the modified-epoch sequence (`100000` plus
   seconds since Jan 1 2025 UTC) and advances past the last published value when
   needed for same-second builds or clock skew. Android `versionCode` is fixed at
   `1000000000` and is not a compatibility identifier. The manifest references
   the mutable production firmware manifest for latest MTK/BES rather than
   snapshotting firmware into each SDK release. The APK asset name includes the
   SDK version, `asgVersion`, and source SHA; the manifest records the source
   commit and exact APK SHA-256.
3. The SDK OTA job verifies the GitHub release manifest URL before package
   publishing starts. If the same SDK release is rerun after OTA publishing
   succeeded, existing APK or manifest assets are reused only when their content
   is byte-for-byte identical; mismatched assets fail hard.
4. The npm job installs mobile workspace dependencies, builds the SDK package,
   checks whether `@mentra/bluetooth-sdk@VERSION` already exists, runs
   `npm pack --dry-run`, then submits the package with `npm stage publish` when
   the workflow is not in dry-run mode. A maintainer must approve the staged
   package before it becomes available on npm.
5. The Maven job installs the mobile workspace, runs Expo prebuild to create the
   generated `mobile/android` Gradle project, checks Maven Central for both
   Android artifacts, runs a public-mode `publishToMavenLocal`, then uploads the
   signed public-mode `lc3Lib` and `mentra-bluetooth-sdk` publications to
   Sonatype Central.
6. The iOS job checks out the SwiftPM mirror repository, refuses to overwrite an
   existing version tag, exports the package with
   `scripts/export-bluetooth-sdk-ios-spm.sh --verify`, then pushes `main` and
   the version tag.

## Manual Steps That Remain

The npm package is staged, not published live. After the workflow stages a
version, a maintainer must open npmjs.com, review the staged package from the
Staged Packages tab, and approve it with 2FA. The CLI alternative is to run
`npm stage list @mentra/bluetooth-sdk`, inspect the stage ID with
`npm stage view <stage-id>`, and approve with `npm stage approve <stage-id>`.

Maven Central still uses `user_managed` publishing. After the workflow uploads
the deployment, a maintainer must open
`https://central.sonatype.com/publishing/deployments`, inspect the deployment,
and manually publish it. The workflow intentionally does not auto-release the
Sonatype deployment until maintainers decide that is safe.

The SDK OTA manifest and APK are intentionally immutable. If an existing OTA
release asset for the same SDK version has different content, the workflow fails;
bump the SDK version for a new ASG compatibility target. Existing live npm
versions and SwiftPM tags are skipped. A pending npm staged package for the same
version will cause `npm stage publish` to fail until the staged package is
approved or rejected. Maven reruns are safe only after confirming there is no
open Sonatype deployment for the same version; if Maven Central already shows
both artifacts, the workflow skips Maven publishing.

## Dry Runs and Verification

Use `workflow_dispatch` with `dry_run=true` to exercise the build/export path
without publishing. This builds the ASG APK and generated manifest, performs npm
`pack --dry-run`, Maven `publishToMavenLocal`, and SwiftPM export verification
unless the exact version already exists in that registry, in which case the
matching artifact job skips rather than attempting a duplicate release. Set
`force_release=true` only when you intentionally want to run release jobs even
though the SDK package version did not change.

After a real release:

```bash
npm view @mentra/bluetooth-sdk@VERSION version
npm stage list @mentra/bluetooth-sdk
curl -fsS "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-VERSION-version.json"
curl -fsS "https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/VERSION/bluetooth-sdk-VERSION.pom"
curl -fsS "https://repo.maven.apache.org/maven2/com/mentraglass/lc3Lib/VERSION/lc3Lib-VERSION.pom"
git ls-remote --tags git@github.com:Mentra-Community/mentra-bluetooth-sdk-ios.git VERSION
```
