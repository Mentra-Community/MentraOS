# Install a PR build on iPhone or Mac

The final **#pr-builds** Slack message has two downloads from one signed iOS
Release app. These are ad hoc builds for registered test devices. They do not
use TestFlight or require a source build or local re-signing. They use the dev
backend and normal product defaults.

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

## One-time signing setup (maintainer)

Use the existing Apple Distribution certificate and add an **ad hoc** profile
for `com.mentra.mentra` to the encrypted `Mentra-Community/match-certs` store.
Include the test iPhones and test Macs in this same profile. For a Mac, get the
**Provisioning UDID** from System Information → Hardware (not Hardware UUID).
For an iPhone use Xcode's Devices and Simulators identifier.

From an authorized checkout's `mobile` directory, with Match credentials loaded
securely and the devices registered in Apple Developer:

```sh
bundle exec fastlane match adhoc --force_for_new_devices
```

This requires write access to the signing store and Apple Developer profile
management. CI only runs `match adhoc --readonly`: it never creates devices,
profiles or certificates and never changes the App Store profile. The existing
`MATCH_PASSWORD` and `MATCH_GIT_BASIC_AUTHORIZATION` GitHub secrets are reused.
New devices require a refreshed profile and export; existing downloaded IPAs
cannot acquire a new device authorization. Profile expiration also requires a
fresh export. No new certificate per tester is needed.

## Evidence and recovery

CI publishes a JSON receipt with PR head and actual checkout SHA, run/attempt,
profile expiration, app and archive hashes. Slack links only verified downloads
from the matching run. The receipt does not list registered device IDs (the
embedded Apple profile inherently contains them). Downloads may expire after
7 days; the provisioning expiration is separate.

The signed outputs are handed off as a GitHub Actions artifact. If CDN
publication fails, rerun failed jobs to reuse those exact bytes. If signing is
missing, fix Match provisioning and rerun the build. The source archive and
upload bytes are never re-signed by the publication job.
