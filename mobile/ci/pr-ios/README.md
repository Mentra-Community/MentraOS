# Install a PR build on iPhone or Mac

The final **#pr-builds** Slack message offers iPhone installation and iPhone/Mac
downloads from one signed iOS Release app. These are ad hoc builds for registered test devices. They do not
use TestFlight or require a source build or local re-signing. They use the dev
backend and normal product defaults. Settings identifies the canonical app version and current PR branch/head. The
receipt separately records the actual candidate checkout, original compilation
revision, fingerprint and numeric native build.

Glasses OTA is enabled on both iPhone and Mac. Each packaged app selects
`ota-pr-<PR number>-<full head SHA>.json`, the same manifest used by that PR's
Android APK. The ASG workflow publishes it with the matching ASG client and
BES/MTK firmware targets. Wait for the ready Slack post before testing updates.
CI checks the pin in the exported IPA and delivered Mac app, and records it as
`app.otaManifestUrl` in the receipt. An absent or stale pin fails packaging.
Unsigned compile checks and unconfigured local builds keep OTA disabled.

## iPhone

In **#pr-builds** on your iPhone, tap **Install on iPhone** and confirm **Install**
in the iOS prompt. This direct link skips the intermediate webpage. Return to
the Home Screen, wait for installation to finish, then open the Mentra App.
No Mac or TestFlight is needed.

If the direct link does not open, use **Install via Safari** beside it. Open that
page in Safari (use Slack's browser menu if needed), tap **Install on iPhone**,
and confirm Install. The page identifies the PR, commit, version and native
build. The GitHub PR comment links to this HTTPS page as well.

Your iPhone must already be included in the build's ad hoc provisioning profile;
registering it after this build was exported requires a refreshed profile and a
new build. The installation replaces the existing Mentra App. Keep the app
installed to preserve its data. PR download links may expire after 7 days.

If there is no installation prompt, open the page in Safari and tap Install
again. If installation fails, verify device inclusion and profile validity and
use a fresh PR link. Downloading an IPA into Files does not install it.

For USB installation, download the **iPhone IPA** to a Mac. Connect and trust your registered iPhone,
then add the IPA to the phone with Apple Configurator, or Xcode → Window →
Devices and Simulators → Installed Apps → `+`. Launch the Mentra App on the
phone. Older PR messages that only offer **Download IPA** use this USB method.

## Apple Silicon Mac

Requires Apple Silicon, macOS 14 or later (also subject to the app's iOS/macOS
compatibility requirement), and [Bun](https://bun.sh). Unzip **Mac app**, open
the `Mentra PR` folder, and run `Install.command`, or from Terminal:

```sh
bun install.mjs --manifest build.json
```

The installer checks the profile/device, Apple signature and build hashes,
normally quits the running app, and installs into
`~/Applications/Mentra E2E/Mentra.app`. It shares the managed installation used
by the E2E harness. It preserves account/pairing data and saves the previous
installation as `previous-installation.zip`. Run with `--no-launch` to install
without opening the app. Close a running Mentra App only when ready to replace
it; do not install during a live test or call.

No Xcode is required on the Mac for this installation: the launcher is included.
macOS may require its normal first-use approvals. The installer does not change
privacy settings or disable Gatekeeper. If a launch approval delays opening,
the verified app remains installed; approve through macOS and open it again.

For repeated automated installations, use the repository's
[Mac test-host setup](https://github.com/Mentra-Community/MentraOS/blob/dev/tools/mentra-e2e/MAC-CI-SETUP.md). It verifies the
selected Actions artifact and invokes a trusted repository installer with a
pinned preinstalled launcher, without executing the downloaded installer/helper.
This avoids those per-download executable prompts. Initial prerelease developer
trust and app privacy grants remain host provisioning; signing a Mac helper does
not grant Bluetooth. The current portable ZIP helper is ad hoc signed, not
Developer ID signed/notarized.

## Compilation reuse

Android and iOS use the same fingerprint/selection and PR configuration contract.
CI searches published signed apps for matching source, dependency, toolchain and
compiled-environment inputs. A verified iOS match skips dependency installation,
Pods, prebuild and Xcode compilation. It then updates Expo's packaged
`extra.mentraPrBuild` configuration and `CFBundleVersion` and signs with the
current distribution identity/profile. Both fresh and reused apps use this path.

The packaged OTA target and current PR identity are independent of the JavaScript
bundle. Settings and reports therefore identify the current candidate while the
receipt retains `mobileSourceCommit` for the original compilation. CI compares
all other resources/frameworks byte-for-byte and the main executable with its
signature removed, then checks the final signatures and unchanged entitlements.
A mismatched or unavailable cached app results in a fresh compilation.

The delivered IPA is the reusable artifact; no separate permanent iOS binary
cache is published. The existing seven-day retention applies. The build summary
and receipt state whether compilation was reused. A device-only profile refresh
can reuse compiled code when its capabilities and signing identity still match.

## Signing setup (maintainer)

The distribution certificate/private key stays in the encrypted
`Mentra-Community/match-certs` store. PR CI fetches only that existing identity
with `match adhoc --readonly --skip_provisioning_profiles true`.

The PR-specific ad hoc profile is stored separately in the MentraOS Actions
secret **`IOS_PR_PROFILE_BASE64`**. This lets an Apple Developer administrator
maintain test-device authorization without write access to the certificate
repository. The App Store profile is unchanged.

To create or renew it in Apple Developer → Certificates, Identifiers & Profiles:

1. Choose **Profiles → Add → Ad Hoc** and App ID `com.mentra.mentra`.
2. Select the Apple Distribution certificate used by CI (its fingerprint must
   match the identity in Match). Do not create or revoke a certificate.
3. Check **Include Mac Devices** and select the registered test devices. For a
   new Mac, register its **Provisioning UDID** from System Information → Hardware,
   not Hardware UUID. For an iPhone use Xcode's Devices and Simulators identifier.
4. Name it **`match AdHoc com.mentra.mentra`**, generate it and download it.
5. Upload the profile as base64 without putting it in the repository:

```sh
base64 < /path/to/profile.mobileprovision | tr -d '\r\n' |
  gh secret set IOS_PR_PROFILE_BASE64 --repo Mentra-Community/MentraOS
```

The runner uses its existing Homebrew Ruby (`brew --prefix ruby`) with job-local
Bundler gems. Existing `MATCH_PASSWORD` and `MATCH_GIT_BASIC_AUTHORIZATION`
secrets are reused. CI never creates devices, profiles or certificates.

New devices require registering them, regenerating the profile, replacing this
secret and rerunning the build/export. Already downloaded IPAs cannot acquire
new device authorization. Profile or certificate expiration also requires a
fresh export. No new certificate per tester is needed.

## Evidence and recovery

The publisher generates a static HTML installation page and an Apple XML
manifest referencing the exact verified IPA. It serves them over the existing
HTTPS artifact CDN as `text/html` and `text/xml`. The page starts installation
only when the tester taps its `itms-services` link; opening a Slack preview
does not initiate installation. No signing or device-enrollment change is needed.

The version 2 publication receipt includes hashes and sizes for the IPA, Mac
ZIP, manifest and page, and is published only after all four uploads verify.
The notifier downloads the small installation files and verifies their decoded
sizes, SHA-256 hashes and MIME types before advertising the link. CDN compression
can omit or change the HTTP Content-Length header. The large IPA and ZIP retain
their HEAD availability checks. Existing version 1 receipts remain download-only.

CI publishes a JSON receipt with PR head and actual checkout SHA, run/attempt,
profile expiration, app and archive hashes. Slack links only verified downloads
from the matching run. The receipt does not list registered device IDs (the
embedded Apple profile inherently contains them). Downloads may expire after
7 days; the provisioning expiration is separate.

The signed outputs are handed off as a GitHub Actions artifact. If CDN
publication fails, rerun failed jobs to reuse those exact bytes. Android, iOS
and ASG each invoke the shared notification job after their build/publication
jobs finish, including retries. An iOS-only recovery automatically updates the
PR build comment and sends the ready Slack post; Android does not need rerunning.
Repeated completion events are deduplicated. If signing is
missing, fix the certificate or PR profile secret and rerun the build. The
source archive and upload bytes are never re-signed by the publication job.
