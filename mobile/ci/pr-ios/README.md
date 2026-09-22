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
compatibility requirement), and registration in the build's ad hoc profile.
New **Install on Mac** links in **#pr-builds** hand the selected build to a
persistent native installer. Bun, Xcode and Terminal are not required.

**First setup:** use the Mac ZIP download on the installation page, unzip it and
open **Install Mentra.app** inside the `Mentra PR` folder. If it asks for a folder,
select that extracted folder. Check the PR/build and click **Install & Open**.
The installer retains itself in `~/Applications/Install Mentra.app` for later
links. Complete any normal macOS first-use approvals.

**Later builds:** click **Install on Mac** in **#pr-builds** and allow the browser
to open the installed Mentra installer if asked. It downloads the selected build
into its managed cache, verifies it, replaces the Mentra App and opens it. There
is no new folder to find in Downloads. The page also has an explicit Open button
if the browser prevents automatic handoff. Old posts remain download-only.

The installer accepts only Mentra PR/build coordinates through `mentra-install:`;
the link cannot supply an arbitrary download URL or executable. Expired or
missing builds fail visibly instead of selecting a different build.

The installer checks the profile/device, Apple signature and build hashes,
normally quits the running app, and installs into
`~/Applications/Mentra E2E/Mentra.app`. It shares the managed installation used
by the E2E harness. It preserves account/pairing data and saves the previous
installation as `previous-installation.zip`. Do not install during a live test or
call; installation normally closes the running Mentra App before replacement.

CI signs the native installer with Developer ID, notarizes it with Apple and
staples its ticket before publishing the ZIP. Its signed manifest identifies the
exact adjacent iOS app; the iOS app retains its original Apple Distribution
signature. This removes the old script/helper verification warnings. A normal
downloaded-app **Open** confirmation can still appear. Mentra's prerelease
developer trust and Bluetooth or other privacy requests are separate first-use
approvals. The installer does not change privacy settings or disable Gatekeeper.
If a launch approval delays opening, the verified app remains installed; complete
macOS setup and click **Open Mentra** again.

For repeated automated installations, use the repository's
[Mac test-host setup](https://github.com/Mentra-Community/MentraOS/blob/dev/tools/mentra-e2e/MAC-CI-SETUP.md). It verifies the
selected Actions artifact and invokes a trusted repository installer with a
pinned preinstalled launcher, without executing the downloaded installer. That
path supports both the new native-installer ZIP and older ZIPs containing
`Install.command`, `install.mjs` and an ad hoc launcher. Initial prerelease
developer trust and app privacy grants remain host provisioning; notarization
does not grant Bluetooth. Older ZIPs are unchanged and do not gain notarization
retroactively.

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

### iOS app and registered test devices

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

### Native Mac installer

The native installer needs a **Developer ID Application** certificate and its
private key for the Mentra Apple team (`T5XXXL6N36`). This is a different identity
from the iOS Apple Distribution certificate. Find or manage it in
[Apple Developer → Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list),
not App Store Connect. Reuse the company's existing Developer ID identity when
available; CI does not create or revoke certificates.

If the team has no Developer ID Application certificate, the Apple Developer
Account Holder must create it. Apple's certificate page disables that choice
for other team members, even when they can manage iOS signing. The holder can
use a certificate signing request from the Mac that will retain the private key,
then return the issued public certificate to that Mac for the `.p12` export.

Obtain a password-protected `.p12` export of the certificate **and its private
key** from the Mac/keychain or secret store that owns that key. A downloaded
public `.cer` file alone cannot sign the installer. Store the certificate pair in
Doppler project **`mentra-mobile-client`**, config **`prd`**, through the company
secret-management process. The existing MentraOS Actions service token
`DOPPLER_TOKEN_MOBILE_PRD` selects that project/config; the signing step fetches
only these two named secrets:

| Secret | Purpose |
| --- | --- |
| `MAC_INSTALLER_P12_BASE64` | Base64-encoded Developer ID Application certificate and private-key export. |
| `MAC_INSTALLER_P12_PASSWORD` | Password protecting that `.p12` export. |

Keep the existing notarization credentials in MentraOS Actions secrets:

| Secret | Purpose |
| --- | --- |
| `ASC_API_KEY_P8_B64` | Existing App Store Connect API private key, reused for Apple notarization. |
| `ASC_API_KEY_ID` | Existing API key ID. |
| `ASC_API_ISSUER_ID` | Existing API key issuer. |

App Store Connect API credentials authenticate notarization; they do not replace
the Developer ID signing certificate/private key. Keep exports, passwords and API
keys out of chat, source files, logs and tracked test fixtures. The signing
configuration uses Python's HTTPS client with Basic service-token authentication
against Doppler's single-secret endpoint. It rejects redirects, malformed or
missing values, limits each response to 1 MiB and uses a 20-second socket timeout.
It never downloads the full config, writes the certificate credentials into
`mobile/.env`, or exports them to subsequent workflow steps.

Local runs may supply both `MAC_INSTALLER_P12_BASE64` and
`MAC_INSTALLER_P12_PASSWORD` directly in the process environment instead. If
either variable is present, both must be nonempty and valid; an incomplete pair
fails without fetching or mixing in Doppler values. With neither variable set,
the same `DOPPLER_TOKEN_MOBILE_PRD` service-token path is used. The temporary P12
file is private and removed immediately after its keychain import.

CI checks private-key access and notarization authentication before building the
app. The downloaded Developer ID intermediate is matched by exact DER bytes
against certificates in the disposable job keychain. An identical existing
certificate is reused; a missing certificate is imported and verified again.
Other keychain/import errors remain fatal. It signs only `Install Mentra.app` with Developer ID and hardened runtime,
submits that installer to Apple, requires an Accepted result, then staples and
validates the ticket. The iOS payload remains outside the notarization submission.
CI also verifies the installer after extracting the final Mac ZIP. Missing
credentials or failed notarization stop publication; there is no unsigned
fallback. The existing Mac artifact name, Slack link and iPhone IPA remain the
distribution contract.

Qualification status: Developer ID credential provisioning and a real notarized
CI download still need validation. A locally compiled installer preview verifies
neither Apple notarization nor first-use Gatekeeper behavior. Keep that distinction
when reporting test results.

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
