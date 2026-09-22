# Native Mac PR installer

`Installer.swift` is the AppKit entrypoint for `Install Mentra.app` in the existing
Mac PR ZIP. First-time **Install & Open** retains this native app at
`~/Applications/Install Mentra.app` and hands off to that permanent copy through
NSWorkspace. Subsequent **Install on Mac** links in `#pr-builds` select a PR,
commit, run and attempt with the `mentra-install` URL scheme; the permanent
installer downloads, verifies, installs and opens the selected build.

`InstallerCore.swift` verifies and installs `Mentra.app` and owns the one-time
helper bootstrap. `Distribution.swift` accepts only immutable CI coordinates
from links and downloads their receipt and Mac ZIP from the fixed Mentra CDN.
The package builder supplies the app's Info.plist, icon, and exact `build.json` in
`Contents/Resources`, then signs and notarizes **the installer**. The iOS payload
remains outside it and keeps its original Apple signature and provisioning.

```sh
xcrun swiftc -parse-as-library -O -target arm64-apple-macos14.0 \
  mobile/ci/pr-ios/mac-installer/InstallerCore.swift \
  mobile/ci/pr-ios/mac-installer/Distribution.swift \
  mobile/ci/pr-ios/mac-installer/Installer.swift -o Installer
bash mobile/ci/pr-ios/mac-installer/test.sh
```

Opening a downloaded bootstrap verifies and displays its build; it does not
install until the user selects **Install & Open**. If Gatekeeper translocates the installer away
from its sibling files, a normal folder picker asks for the extracted package.
The selected `build.json` must equal the copy inside the signed installer byte
for byte. No scripts from the download are executed. Bun, Xcode, and a separate
launcher are not needed on the receiving Mac.

A clicked PR installation link authorizes that selected build's automatic
installation and launch. Requests are processed in order, with an additional
filesystem lock protecting app replacement. The helper rejects malformed links
and temporary handoff conflicts. Legacy CI ZIPs are accepted only with their
expected original format; their bundled `Install.command`, Bun script and
launcher are never executed. The new bootstrap's embedded manifest must remain
version 2 and match its adjacent `build.json` exactly.

All installation and app-opening paths also share
`~/.cache/mentra-e2e/com.mentra.mentra.lock` with the automated harness and repository
installer. The native lease mirrors `mobile/scripts/app-ownership.mjs`: an atomic
`.reclaim` directory serializes ownership publication, and an exclusive private
PID/token record remains held through launch and installation cleanup. An existing
test or installer lease prevents these operations. An interrupted installer writes
retained ownership that the harness will not reclaim solely because its PID exited;
an abandoned `.reclaim` guard is not automatically removed either. Explicit recovery
must reconcile the app, installed manifest and retained transaction files before
clearing these records. Releasing ownership removes only the matching PID/token.

Downloads use an owned private cache instead of Downloads. Successful runs and
ordinary failed installs remove their request directories; an unfinished tool's
recovery files are retained. The downloader prunes old owned request directories
only when their originating process has exited. The helper can remain running
with its window closed; **Quit Install Mentra** or **⌘Q** exits it when no
replacement transaction is active.

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

## Permanent-helper ownership and upgrades

The signed native bundle is copied without modification. The bootstrap verifies
its signature and identifier, then records the copied executable hash in the
private `~/Library/Application Support/Mentra Installer/installed-helper.json`.
It will reuse an existing helper only when that owned record and its intact
signature match. An unrelated app already occupying the destination is never
overwritten. Bootstrap failure retains a `.bootstrap-lock` when rollback cannot
finish. Initial trust comes from launching the installer through macOS; CI
requires Developer ID signing and notarization. An explicitly launched local
signed development preview can exercise the same copy path, without relaxing
verification of downloaded iOS app signatures.

This version does not automatically update the permanent helper. A maintainer
upgrading it should finish active installations, quit the helper, and inspect
any retained recovery lock first. Move both the owned
`~/Applications/Install Mentra.app` and its `~/Library/Application Support/Mentra Installer`
state folder to a backup location, then open the newer verified bootstrap and
complete **Install & Open**. Do not remove the separate `Mentra E2E` app directory
or its data. Keep the backup until a new PR link has been verified successfully.
