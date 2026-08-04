# Releasing the Android Maven Artifacts

The normal release path is the GitHub Actions workflow documented in
`RELEASING_CI.md`. It publishes these public Android artifacts when
`mobile/modules/bluetooth-sdk/package.json` changes on `staging`:

- `com.mentraglass:bluetooth-sdk`
- `com.mentraglass:lc3Lib`

Use the manual process below for local smoke checks, emergency recovery, or when
you need to inspect a Sonatype deployment outside CI.

The source of truth stays in this monorepo under
`mobile/modules/bluetooth-sdk`. Maven Central is the public artifact mirror, not
a second source tree.

## When to Run This

Run the release from the branch or commit that contains the complete Android SDK
feature set for the release. Do not run the publish from a partial split PR
branch unless that branch intentionally contains every Android source file and
companion library expected in the public artifacts. In CI, that branch is `dev`
after the SDK package version bump has merged.

The commands below assume the full MentraOS Android Gradle build layout, where
the SDK module is included under `mobile/android` as `:mentra-bluetooth-sdk`.
That is the layout used for Maven Central releases. In a fresh
checkout where `mobile/android` is not present yet, run
`cd mobile && cp .env.example .env && bun expo prebuild --platform android`
after installing dependencies.

For a local Android compile check without publishing, run this from the
MentraOS repo root:

```bash
./scripts/check-android-compile.sh bluetooth-sdk
```

The script prepares `mobile/android` when needed and uses the generated Gradle
wrapper with `-PmentraPublicSdk=true`. Do not run `gradle` directly from
`mobile/modules/bluetooth-sdk/android`; that directory is included as a module
by the Expo Android project and does not carry its own wrapper or Android Gradle
plugin classpath.

The public SDK publication uses `-PmentraPublicSdk=true`. Leave this property
off for normal MentraOS Android app builds so the app keeps the optional local
STT, VAD, and Vuzix integrations it needs. With the property enabled, those
MentraOS-only integrations are compile-only for the SDK artifact and are not
published as runtime transitive dependencies.

## Prerequisites

- A clean MentraOS checkout on the release source branch.
- Java 17 and the Android SDK installed.
- Push or release approval for publishing `com.mentraglass` artifacts.
- Sonatype Central credentials and GPG signing configured locally or in CI. For
  CI, see `RELEASING_CI.md` for the exact GitHub secret names.

Use `android/gradle.properties.example` as the template. Put real values in
`~/.gradle/gradle.properties` or CI secrets, not in the repository:

```properties
sonatypeTokenBase64=...
sonatypePublishingType=user_managed
signing.useGpgCmd=true
signing.gnupg.executable=/opt/homebrew/bin/gpg
signing.gnupg.keyName=...
signing.gnupg.passphrase=...
```

The Gradle publications read `mobile/modules/bluetooth-sdk/package.json` by
default, matching the React Native package version. Capture it once so the
manual verification commands use the same version string:

```bash
version=$(node -p "require('./mobile/modules/bluetooth-sdk/package.json').version")
```

## Publish to Maven Local

From the MentraOS repo root:

```bash
cd mobile/android

MENTRA_MAVEN_VERSION="${version}" ./gradlew \
  :lc3Lib:publishToMavenLocal \
  :mentra-bluetooth-sdk:publishToMavenLocal \
  -PmentraPublicSdk=true
```

Use this only as a local smoke check. Consumer validation for a Central release
should not rely on stale `mavenLocal()` artifacts.

`MENTRA_MAVEN_VERSION` is passed explicitly in the commands below to keep the
shell's `version` variable and Gradle's publication version locked together. If
it is omitted, Gradle falls back to the same package metadata version.

## Publish to Sonatype Central

From `mobile/android`:

```bash
MENTRA_MAVEN_VERSION="${version}" ./gradlew \
  :lc3Lib:publishReleasePublicationToSonatypeCentralRepository \
  :mentra-bluetooth-sdk:publishReleasePublicationToSonatypeCentralRepository \
  :mentra-bluetooth-sdk:uploadSonatypeCentralDeployment \
  -PmentraPublicSdk=true
```

The upload task requests a Sonatype Central deployment upload for the
`com.mentraglass` OSSRH compatibility repository. If the Gradle publications
succeeded but the upload request needs to be sent manually, use the same
credential from `~/.gradle/gradle.properties`:

```bash
TOKEN=$(grep '^sonatypeTokenBase64=' ~/.gradle/gradle.properties | cut -d= -f2-)

curl -fsS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://ossrh-staging-api.central.sonatype.com/manual/upload/defaultRepository/com.mentraglass?publishing_type=user_managed"
```

Because the documented configuration uses
`sonatypePublishingType=user_managed`, Sonatype Central will not release the
deployment automatically after upload. Open
`https://central.sonatype.com/publishing/deployments`, inspect the deployment,
and manually confirm/publish it.

## Check Deployment Status

Load the Sonatype token if it is not already in your shell:

```bash
TOKEN=$(grep '^sonatypeTokenBase64=' ~/.gradle/gradle.properties | cut -d= -f2-)
```

Find the Sonatype deployment:

```bash
curl -fsS -H "Authorization: Bearer ${TOKEN}" \
  "https://ossrh-staging-api.central.sonatype.com/manual/search/repositories?ip=any&profile_id=com.mentraglass"
```

Then check the Central Publisher status using the returned
`portal_deployment_id`:

```bash
deployment_id=...

curl -fsS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://central.sonatype.com/api/v1/publisher/status?id=${deployment_id}"
```

## Final Checks

After the deployment is available, verify the published POM and module metadata:

```bash
curl -fsS \
  "https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/${version}/bluetooth-sdk-${version}.pom"

curl -fsS \
  "https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/${version}/bluetooth-sdk-${version}.module"
```

Then build a consumer app against public repositories. The Partner Kit Android
example should only need `google()` and `mavenCentral()` for a completed public
release. Remove or bypass `mavenLocal()` when checking a completed Central
release so the test cannot pick up stale local artifacts.

If the public release is not visible yet, Maven Central mirror propagation can
lag briefly. Retry after the artifact appears under
`https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/`.
