# Bluetooth SDK Release CI

The Bluetooth SDK release workflow lives at
`.github/workflows/bluetooth-sdk-release.yml`. It runs on pushes to `dev` that
touch the SDK package, the release workflow, or the SwiftPM export script. A
release is only attempted when the `version` field in
`mobile/modules/bluetooth-sdk/package.json` changes compared with the previous
`dev` commit.

The same version drives all public artifacts:

- npm: `@mentra/bluetooth-sdk`
- Maven Central: `com.mentraglass:bluetooth-sdk` and `com.mentraglass:lc3Lib`
- SwiftPM: tag `VERSION` in `Mentra-Community/mentra-bluetooth-sdk-ios`

## Required GitHub Secrets and Variables

Create these in the `Mentra-Community/MentraOS` repository before relying on the
workflow for a real release:

| Name | Type | Purpose |
| --- | --- | --- |
| `NPM_TOKEN` | Secret | npm automation token with publish permission for `@mentra/bluetooth-sdk`. |
| `MAVEN_CENTRAL_TOKEN_BASE64` | Secret | Base64 string of `username:password` for the Sonatype Central publishing token. |
| `MAVEN_SIGNING_KEY` | Secret | ASCII-armored PGP private key used by Gradle in-memory signing. |
| `MAVEN_SIGNING_PASSWORD` | Secret | Passphrase for `MAVEN_SIGNING_KEY`. |
| `MENTRA_BLUETOOTH_SDK_IOS_PUSH_TOKEN` | Secret | GitHub token with write access to `Mentra-Community/mentra-bluetooth-sdk-ios` for pushing `main` and version tags. |
| `SONATYPE_PUBLISHING_TYPE` | Variable | Sonatype Central upload mode; keep `user_managed` unless maintainers intentionally switch to an automatic release mode. |

## Flow

1. The detector job reads `mobile/modules/bluetooth-sdk/package.json` at `HEAD`
   and at the prior push SHA. If the version did not change, the workflow exits
   after writing a summary.
2. The npm job installs mobile workspace dependencies, builds the SDK package,
   checks whether `@mentra/bluetooth-sdk@VERSION` already exists, runs
   `npm publish --dry-run`, then publishes when the workflow is not in dry-run
   mode.
3. The Maven job installs the mobile workspace, runs Expo prebuild to create the
   generated `mobile/android` Gradle project, checks Maven Central for both
   Android artifacts, runs `publishToMavenLocal`, then uploads the signed
   `lc3Lib` and `mentra-bluetooth-sdk` publications to Sonatype Central.
4. The iOS job checks out the SwiftPM mirror repository, refuses to overwrite an
   existing version tag, exports the package with
   `scripts/export-bluetooth-sdk-ios-spm.sh --verify`, then pushes `main` and
   the version tag.

## Manual Steps That Remain

Maven Central still uses `user_managed` publishing. After the workflow uploads
the deployment, a maintainer must open
`https://central.sonatype.com/publishing/deployments`, inspect the deployment,
and manually publish it. The workflow intentionally does not auto-release the
Sonatype deployment until maintainers decide that is safe.

If npm or SwiftPM publish succeeds and a later artifact fails, rerun the workflow
after fixing the problem. Existing npm versions and SwiftPM tags are skipped.
Maven reruns are safe only after confirming there is no open Sonatype deployment
for the same version; if Maven Central already shows both artifacts, the workflow
skips Maven publishing.

## Dry Runs and Verification

Use `workflow_dispatch` with `dry_run=true` to exercise the build/export path
without publishing. This performs npm `--dry-run`, Maven `publishToMavenLocal`,
and SwiftPM export verification unless the exact version already exists in that
registry, in which case the matching artifact job skips rather than attempting a
duplicate publish. Set `force_release=true` only when you intentionally want to
run release jobs even though the SDK package version did not change.

After a real release:

```bash
npm view @mentra/bluetooth-sdk@VERSION version
curl -fsS "https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/VERSION/bluetooth-sdk-VERSION.pom"
curl -fsS "https://repo.maven.apache.org/maven2/com/mentraglass/lc3Lib/VERSION/lc3Lib-VERSION.pom"
git ls-remote --tags git@github.com:Mentra-Community/mentra-bluetooth-sdk-ios.git VERSION
```
