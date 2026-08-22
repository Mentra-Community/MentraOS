# Bluetooth SDK Release CI

The Bluetooth SDK release workflow lives at
`.github/workflows/bluetooth-sdk-release.yml` and follows the same
**channel-promotion scheme** as the miniapp/engine pipelines
(`.github/scripts/npm-channel.mjs`): git holds one prerelease base version
(`X.Y.Z-dev.N`, only ever edited on `dev`) and the branch derives what
publishes — merging up the chain IS the promotion, no version edits ride the
branches:

| Branch | Publishes | npm dist-tag | Publish mode |
| --- | --- | --- | --- |
| `dev` | `X.Y.Z-dev.N` | `dev` | direct — no approval |
| `staging` | `X.Y.Z-beta.N` | `beta` | staged — human approves per store |
| `main-bluetooth-sdk` | `X.Y.Z` | `latest` | staged — human approves per store |

The SDK's prod branch is **`main-bluetooth-sdk`, not `main`** — SDK prod
releases trigger independently of the monorepo's main promotions. To go public,
merge `staging` into `main-bluetooth-sdk` (create the branch from `staging` the
first time). After a plain `X.Y.Z` has shipped, the base is spent: start the
next cycle by bumping `dev` to `X.Y.(Z+1)-dev.0`.

Detection is **registry-state across all three stores**: a release fires when
the derived version is missing from any of npm, Maven Central, or the SwiftPM
mirror's tags, and each store's job re-checks and skips itself when already
complete — re-runs, re-merges, and partially-failed releases all heal. There is
no paths filter; every push to a channel branch reconciles in seconds.

The staged ("human approves") mode maps to each store's native mechanism:

- **npm** — `npm stage publish --tag <channel>`: approve in npmjs.com's Staged
  Packages tab (or `npm stage approve <stage-id>`).
- **Maven Central** — the Sonatype upload uses `publishing_type=user_managed`:
  publish the deployment at
  <https://central.sonatype.com/publishing/deployments>. The `dev` channel
  uploads with `publishing_type=automatic` instead (no approval).
- **SwiftPM** — SPM resolves **tags only**, so the export+commit to the mirror
  is invisible to consumers; the tag push is the release act and lives in a
  separate job behind the `bluetooth-sdk-release-approval` GitHub environment.
  Approve it in the workflow run's UI. **Configure required reviewers on that
  environment once** (Settings → Environments) — until then the gate is a
  no-op. The `dev` channel tags through the unprotected
  `bluetooth-sdk-dev-release` environment without waiting.

The same derived version drives all public artifacts:

- ASG OTA manifest:
  `https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-VERSION-version.json`
- Portable self-hosted OTA bundle:
  `https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-VERSION-ota-bundle.zip`
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
| `NPM_TOKEN` | Secret | npm automation token used for dev-channel direct publishes (staged beta/latest publishes use the OIDC Trusted Publisher). |

The Sonatype publishing type is no longer a repository variable: the workflow
derives it from the channel (`automatic` on `dev`, `user_managed` on
`staging`/`main-bluetooth-sdk`).

## Flow

1. The detector job derives the channel version from the base in
   `mobile/modules/bluetooth-sdk/package.json` and the branch, then checks all
   three stores for it (npm E404-strict; both Maven poms — a partial pair is a
   hard error; the SwiftPM tag via `ls-remote`). If every store already has the
   derived version, the workflow exits after writing a summary. Publish jobs
   stamp the derived version into the CI checkout's manifest before
   building/packing (never committed) — the repo keeps the base version.
2. The SDK OTA job builds the ASG client APK from the same release commit,
   generates a versioned manifest with ASG APK metadata plus the MTK and BES
   metadata from `asg_client/ota_manifests/firmware_live.json`, then uploads the
   APK and manifest to the persistent `bluetooth-sdk-ota` GitHub release. It also
   downloads and hash-verifies those same referenced artifacts and packages them
   with a host-relative copy of the manifest as a portable self-hosted ZIP. The APK
   asset name includes the SDK version, ASG `versionCode`, and commit SHA; the
   manifest asset name includes the SDK version.
   The ASG `versionCode` uses the same Jan 1 2025 wall-clock offset formula as
   rolling staging builds, but uses the release commit timestamp so reruns of the
   same SDK release commit produce the same ASG target.
3. The SDK OTA job verifies the GitHub release manifest URL before package
   publishing starts. If the same SDK release is rerun after OTA publishing
   succeeded, existing APK or manifest assets are reused only when their content
   is byte-for-byte identical; mismatched assets fail hard.
4. The npm job installs mobile workspace dependencies, stamps the derived
   version, builds the SDK package, re-checks the registry, runs
   `npm pack --dry-run`, then publishes: **directly with `--tag dev`** on the
   dev channel (NPM_TOKEN), or via **`npm stage publish --tag <beta|latest>`**
   on staging/prod — a maintainer must approve the staged package before it
   goes live.
5. The Maven job installs the mobile workspace, runs Expo prebuild to create the
   generated `mobile/android` Gradle project, checks Maven Central for both
   Android artifacts, runs a public-mode `publishToMavenLocal`, then uploads the
   signed public-mode `lc3Lib` and `mentra-bluetooth-sdk` publications to
   Sonatype Central — `publishing_type=automatic` on dev (goes live on its
   own), `user_managed` on staging/prod (publish it in the Central Portal).
6. The iOS export job checks out the SwiftPM mirror repository, refuses to
   overwrite an existing version tag, stamps the derived version, exports the
   package with `scripts/export-bluetooth-sdk-ios-spm.sh --verify`, and pushes
   the commit to `main` — **without the tag**. A separate tag job then pushes
   the version tag at the exported commit: immediately on dev, or after a
   reviewer approves the `bluetooth-sdk-release-approval` environment gate on
   staging/prod. The tag going live IS the SwiftPM release.

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
curl -fsSI "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-VERSION-ota-bundle.zip"
curl -fsS "https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/VERSION/bluetooth-sdk-VERSION.pom"
curl -fsS "https://repo.maven.apache.org/maven2/com/mentraglass/lc3Lib/VERSION/lc3Lib-VERSION.pom"
git ls-remote --tags git@github.com:Mentra-Community/mentra-bluetooth-sdk-ios.git VERSION
```
