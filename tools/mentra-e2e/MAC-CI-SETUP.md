# Install CI builds on the Mac test host

Use this for a **selected PR artifact** on an Apple Silicon Mac. The harness and
host setup live in MentraOS for now. Migrating them to a private repository is
deferred. The [Mac installation spec](../../notes/superpowers/specs/2026-09-21-mac-test-host-installation.md)
records the design and tested permission behavior.

For manual installation, the existing **Mac app** download in **#pr-builds** now
packages native **Install Mentra.app**, the signed iOS payload and its build
manifest. See the [download guide](../../mobile/ci/pr-ios/README.md) for its GUI
and maintainer signing setup. The automated path below continues to use trusted
repository code and a pinned host launcher, including for those new ZIPs.

## What needs approval

| Gate | Initial host setup | Subsequent CI installations |
| --- | --- | --- |
| Native `Install Mentra.app` in new ZIPs | CI requires Developer ID signing, notarization and stapling. A normal first-download Open confirmation can remain. | The automated importer verifies but does not execute the downloaded installer. |
| `Install.command` and ad hoc launcher in older ZIPs | Use the trusted repository path below. | Legacy artifacts remain supported; neither downloaded program is executed. |
| Apple prerelease developer trust | Approve the signed Mentra developer through normal macOS UI. | Preserve signing identity, bundle ID and managed installation. |
| Bluetooth and other app privacy grants | Approve the needed services through normal macOS UI. | Reuse the same app identity/container; verify readiness for the selected routine. |
| Harness Accessibility and Screen Recording | Follow [SETUP.md](SETUP.md) for the stable native driver/recorder. | Keep the same provisioned helper identity. |

Normal Bluetooth consent survived two distinct CI builds and restoration on the
first Mac. Fresh-Mac setup, reboot, signing certificate rotation and other privacy
services still need separate qualification. Bluetooth permission does not prove
Bluetooth Classic audio connectivity or pairing. The new native installer's
Developer ID credentials and real notarized CI download still need qualification;
the earlier Bluetooth experiment did not test notarization.

The original downloaded-package experiment removed quarantine only from the
authenticated, byte-verified package. This importer instead downloads the original
Actions artifact into a private run directory and extracts regular files using
Python; it does not copy Finder's quarantine/resource-fork metadata or call
`xattr`, disable Gatekeeper, modify privacy databases or grant permissions.

## Provision this Mac once

Prerequisites: an unlocked Apple Silicon Mac, Python 3.9+, Bun, authenticated
GitHub CLI, and Xcode command-line tools to build the launcher. The Mac's
provisioning UDID must already be in the selected app's ad hoc profile; the
installer checks device inclusion and expiry. Registering a Mac requires a new
CI export; local re-signing is not part of this path.

From a trusted MentraOS checkout, compile the small host launcher once:

```sh
mkdir -p "$HOME/Library/Application Support/Mentra E2E/host-tools"
xcrun swiftc -parse-as-library -O mobile/scripts/launch-ios-on-mac.swift \
  -o "$HOME/Library/Application Support/Mentra E2E/host-tools/launch-ios-on-mac"
shasum -a 256 "$HOME/Library/Application Support/Mentra E2E/host-tools/launch-ios-on-mac"
shasum -a 256 mobile/scripts/launch-ios-on-mac.swift
```

Record those hashes and the trusted source commit in the host's local setup
record. Use the **recorded binary hash** below, rather than accepting whatever hash
the file happens to have on each run. The installer rejects an incomplete pin,
hash mismatch, symlink or noncanonical helper path before replacing the app.
Do not rebuild the launcher for every candidate. Reprovision explicitly when its
implementation changes.

## Select and install a PR build

Wait for the successful iOS producer and ready PR build publication. Select the
full PR head SHA, run ID and artifact attempt from its receipt. These are explicit
inputs; the tool does not silently select a different build or claim the PR head
is still current. A successful workflow rerun may retain an artifact from an
earlier attempt: select that actual artifact attempt.

```sh
python3 tools/mentra-e2e/mac_ci.py \
  --pr PR_NUMBER --head FULL_PR_HEAD_SHA \
  --run IOS_WORKFLOW_RUN_ID --attempt ARTIFACT_ATTEMPT \
  --output .test-results/mac-ci/UNIQUE_RUN_ID \
  --install \
  --launcher "$HOME/Library/Application Support/Mentra E2E/host-tools/launch-ios-on-mac" \
  --launcher-sha256 SHA256_RECORDED_AT_HOST_SETUP
```

Omit `--install` and the launcher arguments for verification without app
replacement. Add `--no-launch` with `--install` to replace the app without starting
it. Every invocation requires a **new** output directory and obtains the artifact
from authenticated GitHub; existing evidence is never overwritten. Do not run
installation concurrently with a hardware routine or another app installer.

The command checks the expected repository/workflow/run/head, receipt, archive
size/SHA256, safe extraction, app version, executable/JavaScript hashes, Apple
signer and packaged PR OTA pin. For legacy packages it checks the bundled helper
hash. For `macPackageVersion: 2`, it checks the native installer's exact path,
embedded manifest bytes, strict signature, Developer ID identity and Mentra team.
It invokes
`mobile/scripts/install-ios-mac.mjs` from the trusted checkout, using the pinned
host launcher. Downloaded installer code is retained as evidence but never
executed. The new ZIP has no standalone launcher: invoking the repository
installer for that format requires the pinned host helper, or it exits with
instructions to open the native GUI. The app stays at
`~/Applications/Mentra E2E/Mentra.app`; its data
and existing privacy identity are preserved. A previous-installation archive is
retained by the installer for recovery.

The helper currently supports PR iOS receipts only. Coordinated dev/staging Mac
artifact selection, artifact publication/OTA readiness gates and durable fixture
leases remain planned in the [CI spec](../../notes/superpowers/specs/2026-09-21-ci-routines-and-admin-results.md).
Installing the app does not verify that its pinned OTA manifest and every firmware
asset are available. Resolve/archive those inputs before any firmware downgrade.

## Check readiness before testing

Complete initial developer trust and privacy prompts normally. Run the harness
`doctor` and inspect the app before starting a routine:

```sh
bun tools/mentra-e2e/run.ts doctor
bun tools/mentra-e2e/run.ts inspect
```

`doctor` establishes driver/capture access and app identity; it does not certify
every app permission. Confirm the services the routine needs, paired fixture and
idle state. Unexpected privacy prompts are host setup failures and must be
resolved before destructive setup. Automated host-readiness classification is a
planned lifecycle gate, not implemented by this importer. A launch timeout may
leave a verified app installed awaiting the normal permission UI.

`result.json` records artifact verification and installation, with
`permissionReadiness: "not-tested"`. `failure.json` and `commands.jsonl` preserve
failed attempts. The installer also records the selected launcher and actual app
identity in `~/Applications/Mentra E2E/installed-build.json`. Keep these receipts,
profiles and device logs local; commit the routine source, not run output.

For zero-touch first Bluetooth approval, evaluate Apple's managed-Mac PPPC policy.
It requires approved MDM enrollment and has not been qualified with this app.
The shared Slack ZIP's native installer and the iOS app use different signing
identities. The installer is Developer ID signed/notarized; the inner app keeps
its Apple Distribution signature and device profile. Maintainers must provision
the Developer ID certificate/private key as `MAC_INSTALLER_P12_BASE64` and
`MAC_INSTALLER_P12_PASSWORD`, with the existing `ASC_API_KEY_P8_B64`,
`ASC_API_KEY_ID` and `ASC_API_ISSUER_ID` authenticating notarization. Follow the
[maintainer guide](../../mobile/ci/pr-ios/README.md#native-mac-installer); keep
secret values out of tracked files and chat. No unsigned replacement is published
when these credentials are missing. Notarization does not grant Bluetooth or
complete the Mentra App's initial prerelease developer trust.
