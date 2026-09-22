---
status: active
owner: Philippe
---

# Mac CI installation and permission setup

The first test host is the existing Apple Silicon Mac. Install selected CI builds
without repeating setup for every run, while preserving app identity and privacy
grants. See [host setup](../../../tools/mentra-e2e/SETUP.md) and the
[operational Mac CI guide](../../../tools/mentra-e2e/MAC-CI-SETUP.md) for exact
commands, plus the [CI integration proposal](2026-09-21-ci-routines-and-admin-results.md).

## Distinct gates

| Gate | Cause | Treatment |
| --- | --- | --- |
| Legacy `Install.command` cannot be verified | Downloaded executable script is quarantined. | New shared ZIPs replace it with native `Install Mentra.app`; the automated importer continues to support older packages without executing their script. |
| Legacy `launch-ios-on-mac` cannot be verified | Downloaded helper is ad hoc signed without Developer ID/notarization. | New shared ZIPs have no separate launcher; automated runs use a pinned provisioned helper. |
| Native installer download confirmation | Gatekeeper checks the Developer ID signed/notarized installer. | CI requires notarization and stapling; a normal first-download Open confirmation can remain. |
| Mentra prerelease developer trust | Apple-signed iOS prerelease app. | Complete normal host setup and preserve distribution identity. |
| Mentra Bluetooth prompt | Separate macOS TCC privacy grant. | One-time user grant on an unmanaged host, or qualified MDM policy. |

Removing quarantine does not grant Bluetooth, Local Network, camera, microphone
or screen capture. Signing/notarizing the native installer does not replace the inner
iOS app's Apple Distribution signature or registered-Mac provisioning.

## Verified experiment

On macOS 26.6.2 without MDM enrollment, the following was completed on September
21, 2026. This is a sanitized summary; the original commands, receipts, logs and
screenshots remain in the ignored local run directory.

| Check | Observed result |
| --- | --- |
| Candidate provenance | PR #4132, CI run `35665719711`, artifact attempt 1, app build `302015703`. |
| Package verification | Original Actions receipt/ZIP, archive hash, all 451 extracted package files, strict app signature and expected Mentra Team ID checked. |
| Scoped trust change | Removed `com.apple.quarantine` only from the verified package, then rechecked its bytes. Global Gatekeeper status was unchanged. |
| Installation | Trusted Bun invoked the checked installer into the fixed managed app path; no further Open Anyway action was needed. |
| Bluetooth enrollment | User granted Bluetooth through the normal system prompt. |
| Relaunch and replacement | PR #4132 → PR #4101 build `302018377` → PR #4132 all received `Allowed (User Consent), DB Action:None` for fresh app processes. |
| Restored candidate | Running executable, JavaScript and packaged OTA pin matched PR #4132's original artifact. |

Both CI apps had the same designated signing requirement. The result proves
permission reuse on this already-provisioned host, not silent first use, reboot,
certificate renewal, OS upgrade or every other privacy grant. An in-app Bluetooth
audio-disconnected notice remained; TCC authorization is not audio pairing proof.

Local evidence filenames include `commands.jsonl`, `verification.json`,
`installation.json`, `running-app-verification.json`, `RESULT.json`,
`restored-home.png` and the separate replacement/restoration records. These contain
machine-specific data and are intentionally not committed or linked as public
artifacts. No TCC database was modified.

## Reusable importer now implemented

`tools/mentra-e2e/mac_ci.py` validates an explicitly selected successful PR producer,
receipt, archive, package hashes, signer and packaged OTA pin. Verification is the
default; `--install` opts into replacement. Installation invokes the trusted
repository installer with the preinstalled helper pinned by `--launcher` and
`--launcher-sha256`. It never executes the downloaded installer or launcher.

Unlike the original Finder-package experiment, it downloads the Actions artifact
into a new private directory and extracts regular files without Finder quarantine
metadata. It does not call `xattr` or change global trust settings. The importer
and pinned-launcher interface include focused unit tests. The
`e2e-setup-checks.yml` workflow executes the guard tests on Ubuntu only; it does
not execute hardware routines or enable nightlies.

The reusable path passed a live installation of PR #4132 build `302015703` on
the provisioned Mac. Independent driver observations matched the running
executable and JavaScript to the CI receipt, and installation evidence confirmed
use of the preinstalled pinned helper. The foreground app remained Codex. Fresh
TCC requests received `Allowed (User Consent), DB Action:None` without another
Bluetooth approval. No downloaded helper, `xattr`, global policy change or firmware
action was used. The app-home screenshot retained the separate audio-disconnected
notice; pairing/audio readiness remains outside this result. Raw evidence is local.

The importer records permission readiness as `not-tested`. Automatic readiness
classification, coordinated-release selection, final publication/OTA availability
and fixture leases remain planned. Follow the operational guide for manual
preflight before any firmware preparation.

The importer accepts both legacy ZIPs and `macPackageVersion: 2` ZIPs. For the
latter, it checks `Install Mentra.app`, requires its embedded `build.json` to match
the external manifest bytes, and verifies its strict signature, installer bundle
ID, Developer ID certificate chain and Mentra team. It still invokes repository
code and the pinned host helper. It does not run the downloaded native installer.
Both portable formats receive app provisioning checks without requiring Xcode on
the receiving Mac after host-tool provisioning.

## Current unmanaged-host setup

1. Provision the runner/launcher, Accessibility and recording access. Verify that
   the app's signing/profile supports this Mac before preparing glasses.
2. Authenticate producer metadata, validate the selected archive and signatures,
   then install at the fixed `~/Applications/Mentra E2E/Mentra.app` path.
3. Complete prerelease developer trust and Bluetooth approval using normal macOS
   UI. Record the actual signing identity and required capabilities.
4. Verify relaunch and a second distinct CI build replacement. Preserve bundle ID,
   designated signing requirement and the existing app container.
5. Before each routine, verify launch and required permission readiness. Unexpected
   approvals must stop firmware preparation. Automated `host-setup-required`
   reporting is a planned lifecycle gate, not a current importer guarantee.

Do not reset privacy grants, remove app data or create a different per-build app
identity during routine cleanup. The supported `tccutil` interface resets grants;
it does not grant them. The current Computer Use tool also rejects the protected
Bluetooth system dialog, so initial enrollment requires the operator's click.

Artifact import must authenticate receipt origin, constrain extraction, reject
unsafe paths/links/special files and verify digests and expected signer. The new
importer provides these checks without quarantine removal. Never implicitly trust
an entire Downloads directory or disable Gatekeeper/XProtect globally. Preserve
the inner app signature and verify installed/running identity separately.

## Shared CI ZIP implementation

The default repeat-install experience is an **Install on Mac** link, not a fresh
Downloads folder. One-time bootstrap retains the signed native installer in
`~/Applications/Install Mentra.app` and registers `mentra-install:`. A link
contains only the PR number, full head SHA, producer run and publication attempt.
The installer derives the receipt and archive URLs from the fixed Mentra CDN
origin, validates the receipt and bytes, installs at the existing managed app
path and opens the app. It must not accept arbitrary hosts, paths or commands.
Concurrent incoming requests must not race replacement.

The HTTPS handoff page uses the existing published installation HTML artifact.
It preserves iPhone's explicit installation behavior and attempts the Mac URL
handler only for an explicit Mac request. It provides an Open button if browser
policy blocks automatic handoff, and the Mac ZIP for one-time bootstrap. Browser
confirmation to open an external application remains outside our control.
Already published immutable pages without handoff support remain download-only.
Publication retries must preserve HTML bytes while selecting the current public
receipt attempt, whose archive may belong to an earlier successful build attempt.

Improve the existing Mac ZIP and **#pr-builds** link for every tester. The package
now contains `Install Mentra.app`, `Mentra.app`, `build.json` and `README.md`.
`Install.command`, `install.mjs` and the separate ad hoc launcher are removed from
this format; no additional distribution artifact or Bun prerequisite is added.
The native AppKit installer displays the PR/build, validates the app and Mac
profile, and performs the same managed installation with normal termination,
data preservation, staging and recovery. The source iOS payload stays unchanged.

The native installer contains the exact expected manifest in its signed
resources. It reads the adjacent payload when available or uses a standard folder
picker when macOS isolates the downloaded installer from its neighbors. The
selected directory must contain that same manifest and matching Apple-signed
app. It does not scan Downloads, alter privacy databases or disable Gatekeeper.

CI signs `Install Mentra.app` with Developer ID Application, hardened runtime and
a secure timestamp. It submits only the installer app to Apple's notarization
service, requires acceptance, staples and validates the ticket, then assembles
the existing Mac ZIP. The iOS app remains outside the notarization submission and
retains its Apple Distribution signature. CI verifies the installer and ticket
again after extracting the final ZIP; the receipt records the notarization
identity/status alongside the existing app and archive identity.

This separation is deliberate: an iOS device app uses different signing and
provisioning requirements from a directly distributed macOS installer. Wrapping
the iOS app in a nested resource archive is not a supported way to avoid notary
inspection; Apple documents recursive inspection of nested containers.

### Maintainer setup and remaining qualification

The signing certificate belongs in **Apple Developer → Certificates, Identifiers
& Profiles**, not App Store Connect. A maintainer must supply a password-protected
Developer ID Application `.p12` containing the certificate and its private key;
a downloaded public certificate alone is insufficient. Configure Actions secrets
`MAC_INSTALLER_P12_BASE64` and `MAC_INSTALLER_P12_PASSWORD`. Existing
`ASC_API_KEY_P8_B64`, `ASC_API_KEY_ID` and `ASC_API_ISSUER_ID` authenticate
notarization. Those API credentials do not replace the code-signing private key.
Keep all secret values out of chat, tracked files and fixtures. See the
[maintainer instructions](../../../mobile/ci/pr-ios/README.md#native-mac-installer).

Signing and notarization are mandatory for new shared ZIP publication; there is
no silent unsigned fallback. Developer ID credential provisioning and a real
notarized CI download are not yet qualified. Local compilation, unit tests or a
locally launched preview cannot establish that Apple accepted the installer or
that a fresh Mac will pass Gatekeeper. The earlier live importer/permission
experiment remains valid only for that recorded path.

After credentials are available, qualify the quarantined CI download through its
native UI, initial developer trust, two distinct build replacements, relaunch and
reboot. Preserve app bundle ID, distribution identity, entitlements and registered
Mac provisioning. Classify installer trust, app provisioning and privacy failures
separately. Coordinated-release Mac ZIPs remain planned; they should reuse this
packaging contract with the matching app archive and effective OTA manifest.

The new packaging removes the two legacy executable warnings. A normal download
confirmation and the Mentra App's first-use prerelease trust/Bluetooth approvals
remain separate. The demonstrated permission-reuse result does not authorize
silent first-time Bluetooth enrollment.

## Optional managed-host setup

Apple documents MDM preapproval of Bluetooth via PPPC on supported macOS versions.
It requires approved device-management enrollment; the policy is not manually
installable through an ordinary shell command. Target the app's actual signing
requirement, not the launcher:

```yaml
Services:
  BluetoothAlways:
    - Identifier: com.mentra.mentra
      IdentifierType: bundleID
      CodeRequirement: '<verified designated requirement>'
      Authorization: Allow
```

This is an MDM policy fragment, not a local installation command. Apple documents
an allowed entry as granting access without prompting. The field is available
from macOS 11 and deprecated from macOS 27 in favor of AppSettings privacy policy;
choose the policy appropriate to the host and management service.

The iOS-on-Mac wrapper still needs qualification on an enrolled host. No such
managed test has passed here, and Bluetooth policy does not establish other
permissions, radio readiness or glasses pairing. MDM is optional for the initial
one-time manual setup on the current Mac.

## Official references

- [Apple: Safely open apps on your Mac](https://support.apple.com/en-us/102445)
- [Apple: Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple: Custom notarization workflows](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Apple: PPPC deployment settings](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-settings-dep38df53c2a/web)
- [Apple: PPPC identity and authorization](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services-data.dictionary/identity)
- [Apple: PPPC schema](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml)
- [Apple: AppSettings](https://developer.apple.com/documentation/devicemanagement/appsettings)
