# Native Mac PR installer

`Installer.swift` is the AppKit entrypoint for `Install Mentra.app` in the existing
Mac PR ZIP. `InstallerCore.swift` verifies and installs the external `Mentra.app`.
The package builder supplies the app's Info.plist, icon, and exact `build.json` in
`Contents/Resources`, then signs and notarizes **the installer**. The iOS payload
remains outside it and keeps its original Apple signature and provisioning.

```sh
xcrun swiftc -parse-as-library -O -target arm64-apple-macos14.0 \
  mobile/ci/pr-ios/mac-installer/InstallerCore.swift \
  mobile/ci/pr-ios/mac-installer/Installer.swift -o Installer
bash mobile/ci/pr-ios/mac-installer/test.sh
```

Opening the app verifies and displays the build; it does not install until the
user selects **Install & Open**. If Gatekeeper translocates the installer away
from its sibling files, a normal folder picker asks for the extracted package.
The selected `build.json` must equal the copy inside the signed installer byte
for byte. No scripts from the download are executed. Bun, Xcode, and a separate
launcher are not needed on the receiving Mac.

For a prepared signed bundle, qualification can run:

```sh
'/path/to/Install Mentra.app/Contents/MacOS/Installer' \
  --package '/path/to/Mentra PR' --verify-only
```

`--package /absolute/path --no-launch` explicitly installs without opening Mentra.
`--package /absolute/path` explicitly installs and opens it. Neither mode approves
privacy dialogs or removes quarantine. `--verify-only` checks the actual app,
signature, hashes, profile expiration and this Mac's registered provisioning UDID
without touching the installed app or requesting Bluetooth access.

The managed path and ownership marker match `mobile/scripts/install-ios-mac.mjs`:
`~/Applications/Mentra E2E/Mentra.app`, owner `mentra-ios-mac-v1`. Installation
preserves the app's container and signed contents, requests a normal quit, keeps
one previous-installation ZIP, and promotes the app and its `installed-build.json`
together. A launch/permission failure leaves the verified new build installed so
the user can finish macOS setup and retry **Open Mentra**. A replacement failure
rolls back; a failed rollback retains the lock and both generations for recovery.
Never remove a retained `.install-lock` until its contents and the installed
manifest have been reconciled. The installer never force-quits an app.

The tests use private temporary fixtures. They cover candidate binding, signing
and provisioning identity inputs, unsafe paths, existing-installation ownership,
metadata/app promotion, injected rollback failures and retained recovery state.
They cannot prove Developer ID notarization, Gatekeeper launch, Bluetooth grant
reuse or iOS app launch; those require the delivered ZIP on a real Mac.
