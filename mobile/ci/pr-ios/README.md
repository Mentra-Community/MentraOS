# Install a PR build on iPhone or Mac

The final **#pr-builds** Slack message has two downloads from one signed iOS
Release app. These are ad hoc builds for registered test devices. They do not
use TestFlight or require a source build or local re-signing. They use the dev
backend and normal product defaults. Settings identifies the canonical app version,
PR branch and actual checkout commit; the receipt also records the PR head and
numeric native build.

## iPhone

Download the **iPhone IPA** to a Mac. Connect and trust your registered iPhone,
then add the IPA to the phone with Apple Configurator, or Xcode → Window →
Devices and Simulators → Installed Apps → `+`. Launch the Mentra App on the
phone. The browser download itself is not an over-the-air installer.

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
