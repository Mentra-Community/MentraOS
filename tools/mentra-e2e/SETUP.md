# Set up another Mac or Mac Mini

This guide provisions the standalone harness and the optional local app build. Replay does not require an AI agent or the monorepo's dependencies. The target is the real iOS app running on an Apple Silicon Mac, installed through TestFlight or built locally for **My Mac (Designed for iPhone/iPad)**.

For the USB-connected Android comparison phone, see [Android setup, identity gate and backend evidence](ANDROID.md). It is a separate discovery lane, not a qualified replacement for the Mac routine.

## 1. Prepare the Mac

1. Use an Apple Silicon Mac with a logged-in graphical desktop. Keep a display connected for initial qualification; a headless Mac Mini has not been qualified.
2. Install macOS compatible with the TestFlight app. Match the qualified machine's macOS version when reproducing a failure. The native recorder requires macOS 15 or newer; the initial host is macOS 26.6.2. Older OS versions have not been qualified.
3. Install Apple's command line tools, or Xcode with its command line tools selected. The helper uses Swift 6 and the macOS SDK's AppKit, ApplicationServices, CoreImage and ScreenCaptureKit. It does not build the Mentra App.
4. Install Bun from its official distribution. Initial development uses Bun **1.4.0** and Swift **6.4**. Keep the actual versions in the run evidence; changing versions requires rerunning the driver proof.
5. Start with the Mac awake, unlocked, and available. The recorder automatically runs Apple's `/usr/bin/caffeinate` with idle-system, idle-display and user-activity assertions while recording. Cleanup releases them after success or failure; the assertions also end when the runner exits or after four hours. This does not edit system preferences, move the pointer or activate Mentra. Other people may work in other apps. You may move the window; keep its size fixed and do not minimize or close it during a run. Manually locking the Mac or closing the laptop lid remains outside this keep-awake guarantee.

Verify the tools:

```sh
uname -m
sw_vers
xcode-select -p
swiftc --version
bun --version
```

If the Apple tools are missing, use Apple's installer:

```sh
xcode-select --install
```

Bun installation instructions: <https://bun.com/docs/installation>. Use a consistent version across test machines. `swiftformat` is needed only when editing Swift source, not when replaying tests. `ffprobe`/FFmpeg is useful for independent video verification, but recording uses native Apple frameworks.

For a longer discovery/build work session between recordings, run `caffeinate -diu -t 14400` in a separate terminal. It expires after four hours; Control-C releases it earlier. `pmset -g assertions` shows the active `caffeinate` assertions. This is a temporary session, not a change to the Mac's permanent lock policy.

## 2. Install the real app

### CI artifact (preferred for PR qualification)

Use [MAC-CI-SETUP.md](MAC-CI-SETUP.md) to select a signed PR Mac artifact,
verify its provenance and install with the trusted repository installer and a
pinned host launcher. Provision developer trust and required privacy grants once;
subsequent builds preserve app identity and data. Run outputs remain local.

### Local source build (for developing the routine)

Use this route to develop accessibility changes before a CI artifact is ready. It needs full Xcode, its iOS platform support, CocoaPods, Bun, and the mobile dependencies. `bun ios` targets a physical iPhone/iPad; it does not select the Mac. PR CI also publishes signed iPhone and Mac artifacts for registered devices; a local build is a different qualification input.

After checking out the branch in section 3:

1. Open Xcode once, finish component installation and select it with `xcode-select` if necessary. Initial host: Xcode 27.0 (27A266a).
2. In **Xcode → Settings → Accounts**, sign in to the Apple developer account for the app's team. Ensure **Manage Certificates** has a valid Apple Development certificate with its private key. Let Xcode create/update the development provisioning profile and register this Mac when required. Do not copy another Mac's Keychain database.
3. Configure `mobile/.env` using the normal mobile development setup. Provide the correct backend settings, Firebase configuration files, Mapbox public runtime token and Mapbox Downloads:Read credentials via the team's existing secure setup. SPM may ask for GitHub Keychain access on first resolution; approve the intended Xcode access. Never paste credentials into build scripts or Git.
4. Allow sufficient disk space for dependencies, Pods, Swift packages and derived data. The native build is substantially larger than the standalone replay helper. Before capture, the runner requires **20 GiB free on the macOS system Data volume** and **5 GiB free on the artifact volume**, and saves both observations in `run.json` under `captureStorage`. Both requirements apply even when recordings are written to an external drive. The 20 GiB reserve is an operational margin after a recording started with 10.18 GiB free and macOS's `replayd` received `cacheDeleteUrgencyHigh`, stopping capture with ScreenCaptureKit error `-3821`; it is not a macOS guaranteed threshold. Preserve failed runs and restore storage headroom before starting another recording. Regenerable Xcode caches may include `mobile/build/ios-mac/Build/Intermediates.noindex`, `ModuleCache.noindex`, `SDKExplicitPrecompiledModules` and `SourcePackages/repositories` under the actual build worktree's derived-data folder. Verify those paths exist and no build is running before reclaiming them. Keep `Archives`, the build manifest, the managed installation under `~/Applications/Mentra E2E`, and `.test-results/mentra-e2e` to retain builds and test evidence. The next native build recreates deleted caches.

```sh
cd mobile
bun install --frozen-lockfile
bun ios:mac
```

`ios:mac` runs Expo prebuild without deleting the native project, the shared CocoaPods installer, then `xcodebuild` for this Mac's iOS-on-Mac destination. It defaults to **Release** with bundled JavaScript: subsequent runs need no Metro server. Development signing is local; this command does not upload to TestFlight. After a successful build it normally quits any running app with the same bundle ID, installs into the fixed `~/Applications/Mentra E2E/Mentra.app` path, and opens it with foreground activation disabled. It preserves the app's existing container and does not clear account or pairing data.

Explicit environment settings take precedence over `mobile/.env`. The build writes
the effective public settings as quoted exports to `ios/.xcode.env.local`, keeping
spaces and shell metacharacters literal. It uses an explicit `NODE_BINARY` when
provided, otherwise a working prebuild Node pin or Node from `PATH`; Bun is never
used as the Node executable for Xcode build phases.

The Mac build applies the app's configured deployment minimum to dependency targets, because Xcode 27 rejects old Pod minimums below iOS 15 on this destination. The checked-in Expo Router patch adds its missing iOS 16 availability check; it does not upgrade the dependency or raise the app's support minimum. Derived data lives outside `mobile/ios/` so CocoaPods' project scan cannot try to rewrite read-only Swift package checkouts.

For a compile without replacing the running process, use `bun ios:mac --build-only`. For iteration with Metro, run `bun start` separately and use `bun ios:mac --debug`. Do not use the repository's release/upload scripts for this local lane.

Build products, immutable signed build ZIPs (`Archives/`) and `build-manifest.json` live in `mobile/build/ios-mac/`. The manifest records configuration, destination, source commit/status, source diff hash, executable/JavaScript/archive hashes, code-signing requirement and Mach-O UUID. The installed manifest is `~/Applications/Mentra E2E/installed-build.json`; a build-only manifest describes an archive that may not yet be installed. A dirty source build is recorded as dirty; it is not evidence that the binary exactly equals the recorded commit. The harness separately records the installed app identity—verify the running binary before using a local build as qualification evidence.

For local-build runs, pass `--build-manifest mobile/build/ios-mac/build-manifest.json` to the harness `run` or `discover` command from the repository root. It compares the running app's bundle ID, executable and bundled JavaScript hashes with the manifest and fails before UI actions if they differ. Relaunch resolves an outer registered iOS-on-Mac wrapper and accepts it only when both executable and JavaScript hashes match the running app. It cannot silently switch to another TestFlight/local build with the same bundle ID.

For a verified CI PR Mac package (package version 2), pass its existing `Mentra PR/build.json` to `--build-manifest`. The report validates the PR identifiers and OTA pin, then compares the running bundle ID, version, build number, executable and JavaScript hashes. It records `verifiedCiBuild` separately from `verifiedLocalBuild`; `installedAppCommit` is the manifest's `mobileSourceCommit`, which can differ from both PR `headSha` and packaging `buildSha` when compilation is reused. This does not invent a local Release configuration or clean working-tree assertion. Import the artifact through `mac_ci.py` first: report validation checks the supplied manifest against the running app, while the importer verifies GitHub receipt provenance, archive contents and signing identity.

If CocoaPods reports that its sources do not contain an already published pinned version, run `pod repo update`, then rerun the build. This resolved the initial Mac's stale WebRTC-SDK catalog. Do not downgrade a pinned dependency to work around a stale catalog.

The local signed Release build, background launch, accessibility controls, sign-in and full 68-step routine have been exercised on the initial Mac. Record and qualify setup/launch gates independently on the second Mac.

### Stable installation and Local Network approval

Use one installed development app per test Mac. Earlier versions of this harness launched a separate `.app` directory for every executable/JavaScript hash. Apple documents unexpected Local Network settings behavior with multiple versions installed (FB15568200) in [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy). The installer now preserves signed builds as ZIPs and replaces one managed path only after the running process terminates. A marker prevents it from replacing an unrelated installation; an install lock prevents concurrent replacement. The previous installation is retained as `previous-installation.zip`. Account storage and pairing remain in the existing app container.

The new manifest is staged before replacement. If promoting that manifest fails,
the installer restores the previous app and retains its matching manifest. A
rollback failure preserves `.install-lock/previous.app` and the staging folder
for recovery, and the lock prevents another installer from overwriting them.
A launch permission prompt after a successful commit leaves the verified new
app and its matching manifest installed.

To install or restore an already built archive without compiling again, from `mobile/`:

```sh
bun scripts/install-ios-mac.mjs --manifest /absolute/path/to/build-manifest.json
```

`--no-launch` installs after normal termination but does not open the new app. No command changes Local Network privacy settings. On a new Mac, approve the expected Mentra Local Network prompt when the app first contacts the glasses. Reuse the same Apple-issued signing identity, bundle identifier and installed path. Do not strip or replace the executable UUID. Record approval and verify actual app-to-glasses traffic; a successful terminal `curl` is not proof that the iOS process has permission. First installation, changed signing identity or an OS change can still require human setup. This reduces duplicate-installation problems; it is not a promise to suppress every OS prompt.

For an older harness checkout, retain its known build manifests and recordings. Archive and verify owned per-build wrappers before removing those obsolete installed copies. Do not remove the App Store/TestFlight installation or unrelated application folders automatically. Old `.app` paths in historical evidence are provenance, not the preferred replay target; restore the matching archived build into the managed path and verify hashes instead.

### TestFlight build

1. Install TestFlight from Apple's App Store.
2. Sign in with the Apple account that has access to the Mentra TestFlight build and accept the applicable TestFlight invitation.
3. Install the intended Mentra iOS build on the Mac. This requires that the build is available for Apple Silicon Macs. If TestFlight does not offer it, resolve build/account availability before continuing; a simulator build is a different test target.
4. Launch Mentra and leave its window open. Initial reference: bundle ID `com.mentra.mentra`, version `3.2.0`, build `320000235`.
5. Install a build containing this branch’s app accessibility changes before qualifying the complete routine. The original build `320000235` lacks identifiers such as `miniapp.minimize` and `home.allApps.open`; the harness intentionally has no coordinate fallback. Source edits cannot change an already installed TestFlight binary. Follow [ACCESSIBILITY.md](ACCESSIBILITY.md) to validate native actions after installing the new build.
6. Use English for the qualified routine. Record any changes from the reference build. Do not install a newer app during a run.

There may be both `/Applications/Mentra.app` and a temporary iOS wrapper under `/var/folders/...`. Do not copy or hard-code the temporary wrapper path. The driver finds the running process by bundle ID and reads its actual bundle URL every invocation. Multiple running matches cause a setup failure rather than an arbitrary selection.

## 3. Get this harness revision

The working branch is `codex/mentra-e2e-harness`, based on `dev`. Once that branch is published, use a separate checkout/worktree on the Mac Mini:

```sh
git clone git@github.com:Mentra-Community/MentraOS.git MentraOS
cd MentraOS
git fetch origin codex/mentra-e2e-harness
git worktree add ../MentraOS-e2e -b local/mentra-e2e origin/codex/mentra-e2e-harness
cd ../MentraOS-e2e
```

The branch is published in [PR #4069](https://github.com/Mentra-Community/MentraOS/pull/4069). To transfer committed work without using the remote, create an incremental Git bundle on the source Mac and copy it to the Mac Mini:

```sh
# Source Mac, from the harness worktree, after committing the harness:
git bundle create /tmp/mentra-e2e.bundle origin/dev..codex/mentra-e2e-harness

# Mac Mini, in a clone that has fetched dev and contains the bundle prerequisites:
git bundle verify /path/to/mentra-e2e.bundle
git fetch /path/to/mentra-e2e.bundle codex/mentra-e2e-harness:refs/heads/local/mentra-e2e
git worktree add ../MentraOS-e2e local/mentra-e2e
```

Check the expected commit with `git rev-parse HEAD`. Do not transfer credentials, Keychain databases, device pairings, or old macOS privacy databases. Run artifacts are local and ignored; copy any historical evidence separately if wanted. The current build wrapper is local too; build and sign anew on the destination Mac.

## 4. Build and check permissions

Run from the repository root, in the same terminal application you will use for replay:

```sh
bun run tools/mentra-e2e/run.ts doctor
```

The first invocation compiles the Swift helper into `.test-results/mentra-e2e/bin/mentra-driver`. Later invocations rebuild only when the native source or Swift toolchain changes.

`doctor` must report the intended app identity, `accessibility: true` and `screenCapture: true` (`postEvents` is diagnostic only; the driver no longer injects input events). It exits nonzero when required access is missing. No test should be counted as passing when this preflight fails.

macOS can attribute permissions to the **application launching the process**, rather than to the helper's filename:

- In Terminal, expect **Terminal**; in another terminal, expect that application.
- In this Codex desktop session, macOS displayed **ChatGPT** (`com.openai.codex`).
- **Codex Computer Use** is a separate permission entry. Enabling it does not authorize terminal replay.

Open **System Settings → Privacy & Security** and grant the responsible launcher:

1. **Accessibility**, for inspecting and controlling Mentra's interface.
2. **Screen & System Audio Recording**, for screenshots and video. The harness configures screen capture only; system audio and microphone capture are disabled.

If the launcher is absent from the recording list, trigger the standard request from that launcher:

```sh
printf '%s' '{"op":"request-screen-capture"}' | .test-results/mentra-e2e/bin/mentra-driver
```

If macOS presents a choice to select a window or allow direct capture, direct capture is needed for unattended replay to identify Mentra without asking you to pick the window each run. The OS permission is broader than the actual capture filter: the recorder allows only the Mentra window and excludes other applications, the desktop and Dock.

macOS may show **Quit & Reopen** / **Later** after a permission change. On the initial Mac, choosing **Later** and starting fresh helper processes was sufficient: `doctor` and real capture then worked. On the new Mac, verify instead of assuming. If either still fails, save any work, quit and reopen the responsible terminal application, and run `doctor` again. Do not reset all privacy permissions or modify the TCC database.

Changing the launcher, checkout location, helper signature or toolchain can require rechecking permissions. Do not grant Full Disk Access or disable SIP for this harness.

## 5. Verify the standalone driver before signing in

After installing the accessibility changes, with Mentra on its signed-out welcome screen:

```sh
bun run tools/mentra-e2e/run.ts run --suite driver-proof
bun run tools/mentra-e2e/run.ts run --suite driver-proof
```

The current proof requires the new `navigation.back` identifier. The original legacy proof passed twice on dev.235; those old passes do not qualify the stricter current revision. This opens Log In, enters a deliberately malformed email, verifies the real app's validation, dismisses it, clears the field, and returns to the welcome screen. It does not send bad-password requests or need account credentials.

Each run prints its unique artifact folder. Both runs must exit zero. Run `bun tools/mentra-e2e/view.ts /absolute/path/to/run`, open its printed localhost URL, play the video, and click the English step descriptions to check that seeking works. Keep the viewer process running until review is finished. Use this HTTP viewer for embedded browsers that display `file://` HTML but fail to play its video. Inspect the input/validation screenshots. Merely compiling or seeing a successful `doctor` is insufficient.

The capture implementation takes screenshots from the same live stream as the video. Starting independent screenshot capture processes while recording caused recording-connection failures during development; use the runner's capture path rather than another recorder alongside it.

## 6. Provide the test account at runtime

For an account that has already completed onboarding, run the login suite from an interactive terminal:

```sh
bun run tools/mentra-e2e/run.ts run --suite login
```

This account reaches onboarding after logout as well as on initial sign-in. The small `login` probe expects an already configured home and therefore fails on this state; the full `no-glasses` routine explicitly covers the observed onboarding path. Run `onboarding` after the probe if preparing a new fixture. Preserve that result, finish fixture setup separately, and rerun once established. The runner prompts for the test account email and password without echoing them. Obtain the designated account credentials from the team's existing secure store or the person provisioning this Mac. They are deliberately absent from Git and this guide.

For an unattended runner, inject `MENTRA_E2E_EMAIL` and `MENTRA_E2E_PASSWORD` into its environment using an existing secret manager. Do not put the password in shell command arguments, shell history, checked-in `.env` files, screenshot filenames or test fixtures. The current harness does not provision a new Keychain item automatically.

The password stays in a secure UI field; do not use the visibility toggle during recording. Secure accessibility values are redacted in artifacts. Videos may still contain the test account's email and ordinary account content; keep them local unless deliberately shared.

## 7. Establish the fixture through the real UI

- **Unpaired** means no paired/selected device and no Phone Mode session. A physical device being powered off is not enough to establish this fixture.
- **Paired-disconnected** preserves an existing pairing. It is a separate fixture; do not unpair the user's glasses just to satisfy a test.
- **Phone Mode** connects a simulated device and has separate expectations.

On this account, both initial login and login after logout reached onboarding. The ordinary **Set up with glasses → model selector → Back → relaunch** path reached home without choosing a device. This works because the app records onboarding completion before model selection. The setup suite documents that transition; it does not scan for or connect to glasses. Verify the resulting **Pair glasses** home state rather than trusting the click sequence.

**Set up without glasses** can enter simulated pairing. Do not use it to prepare an unpaired run.

Do not clear app storage, reset Keychain, or overwrite deployment/server settings. Record app/backend identity, theme, locale, account alias, wearable profile and window geometry with the run. Treat unavailable fixture setup as a setup gap.

## 8. Operate and troubleshoot

### Mac hotspot calling fixture

For the selected Mentra Call direct-link routine, connect Ethernet with internet access and keep Wi-Fi enabled for the glasses hotspot. Before starting, use `networksetup -listallhardwareports`, `scutil --nwi` and `route -n get default` to verify the active internet interface is wired. An attached adapter without an active link/address is insufficient. Do not join the glasses hotspot while Wi-Fi is the Mac's only internet route.

Record Location state if Wi-Fi information is unavailable, but do not require a Location grant solely to join an app-configured hotspot. Apple's `NEHotspotNetwork.fetchCurrent` contract allows SSID access when **the app configured the current network with NEHotspotConfiguration**, as an alternative to precise Location authorization. On the first Mac, Location was off and reads of the ordinary Wi-Fi were denied before hotspot association; this does not explain why association failed. Leave privacy settings unchanged unless a specific need is established and the user approves. Do not reset permission databases or launch Gallery merely to solicit a prompt, because that could start photo synchronization.

Confirm the agreed glasses name under the **connected** section of `system_profiler SPBluetoothDataType`; the initial pair is `Mentra_Live_03BE`. A saved or nearby device is insufficient. Verify the app's pairing and audio readiness separately. Start with Direct link on, record the original network/audio state, and capture the checklist and browser media evidence described in [the Call routine](MENTRA-CALL-ROUTINE.md). The updated iOS native path check recognizes Ethernet as well as cellular. This setup has not yet qualified an end-to-end Mac hotspot call.

The first wired attempt enabled the 03BE hotspot but failed native association with `SCOPED_JOIN_FAILED: internal error.` It never joined Teams. The signed app and provisioning profile both had HotspotConfiguration and Wi-Fi information entitlements. Retain the actual error and setup evidence, resolve observed prerequisites, and retry the same transport; do not replace a failed Direct link run with cloud relay. Confirm hotspot teardown, restore input/output/system audio, and verify retirement of any created meeting even when association fails.

### Routine operation

- Run one harness at a time. A per-user lock prevents two checkouts from driving the same app concurrently.
  Acquisition and dead-owner recovery share an exclusive `.reclaim` directory;
  ownership is read again on every attempt while that guard is held. Concurrent
  attempts fail instead of replacing a live owner's lock. The guard is removed
  after acquisition or an ordinary error. If a process crashes inside that short
  critical section, stop all harness runs before manually removing
  `~/.cache/mentra-e2e/com.mentra.mentra.lock.reclaim`. It is never reclaimed
  automatically. An unreadable or invalid main lock also fails closed; remove
  it manually only after confirming all harness runs have stopped.
- Keep the app window at the same size during a run. Capture targets the window independently of its desktop position. Before a normal relaunch, the recorder switches temporarily to an empty window allowlist; it then attaches the new Mentra window to the same video. Other applications stay excluded.
- An assertion failure produces a nonzero exit and preserves the video, screenshots, accessibility snapshots, expected result, and timing. Inspect the failing step before rerunning.
- A recording failure makes the run incomplete even if some UI assertions passed.
- A locked desktop cannot supply usable window video. The runner rejects a foreground macOS login/lock screen before recording or performing the next action. Unlock the existing user session and start a new run; the harness never unlocks the Mac or changes its lock settings. During qualification, ScreenCaptureKit reported only idle frames with no initial image while `com.apple.loginwindow` was foreground.
- Runs go to `.test-results/mentra-e2e/<timestamp>-<suite>-<suffix>/`. Keep failed runs alongside successful runs while debugging. No automatic artifact upload occurs.
- App relaunch requires the recorder to reattach to the new process/window. The isolated `lifecycle-proof` suite passed three times on the initial TestFlight build; its latest run retained Safari as the foreground app and verified unchanged executable/JavaScript hashes. Qualify it again on the Mac Mini and as part of the full routine. A direct launch of TestFlight's temporary inner bundle failed with a beta-availability dialog during development; the driver now verifies and launches the matching installed wrapper instead.
- Keep the design's physical-device limits: the no-glasses routine does not qualify BLE, firmware updates, glasses capture or SoftAP transfers. A Mac-with-glasses result still does not qualify iPhone screen-off operation.

Before accepting the Mac Mini as a test station, run the qualified no-glasses suite three times with zero manual correction, verify video chapter navigation, check deliberate selector/assertion failures, and record the installed app and harness revisions. Refer to the README and implementation plan for the currently qualified suites; a planned suite is not automatically implemented.

## 9. Run the complete routine

Start on English, signed-in, unpaired home, using the designated test account. Keep another app in front when verifying shared-desktop operation. The routine records the foreground application before/after each step. Since a person may click or move Mentra, a focus change is evidence rather than an automatic claim that the harness stole focus.

```sh
# From the repository root; credentials are prompted without echo.
bun run tools/mentra-e2e/run.ts run --suite no-glasses --fixture unpaired --build-manifest mobile/build/ios-mac/build-manifest.json
```

Omit the manifest flag only for a TestFlight build whose source provenance is unknown. The full 70-step routine includes logout and signing back in. Use a test account, not a personal session. Appearance, paired-disconnected behavior and a separate store/detail surface are explicitly reported as not applicable to this fixture.

On failure the remaining ordinary steps become `not-run`. If initial home was verified, recovery normally relaunches the same build, recognizes only home/authentication/onboarding, and restores the designated account through the already verified UI path when necessary. Recovery has separate screenshots/chapters and status; it never turns the original failure into a pass. No preference-changing steps are included, and storage, pairing, media and server settings are retained.

## Launch dialogs and timeouts

`bun ios:mac` creates the standard outer `Mentra.app/Wrapper/Mentra.app` layout with a `WrappedBundle` link. The signed inner app is unchanged. Directly opening the inner `.app` can cause the unsupported-on-this-Mac or invalid-beta dialogs seen during development; the build command now opens the wrapper.

The background launcher only opens or normally terminates the identified app. It does not inspect system-dialog owners or click permission buttons. Launch has a 30-second deadline and reports a setup gate when it cannot finish. Complete first-use privacy prompts normally; do not reset privacy state or create new app identities to work around a denial.

The initial Xcode account/SPM Keychain permissions and the terminal launcher's Accessibility/Screen Recording permissions may require one human setup action. Complete those once, rerun `doctor`, and then replay. Do not reset the macOS permission database between runs. The harness captures only the Mentra window even when a system dialog is diagnosed; unrelated desktop content is not added to recordings.

For independent artifact checks, install FFmpeg through your normal package manager (for example `brew install ffmpeg`), then run `bun tools/mentra-e2e/verify-run.ts <run-folder>`. Normal replay does not require FFmpeg.

## Mentra Call source and target setup

Clone `https://github.com/Mentra-Community/Mentra-Call` on its `main` branch and run `bun install` before packing Call; its source is not the ZIP in this repository. Record the source commit, `miniapp/miniapp.json` version and bundled ZIP hash separately. See [the English Call routine](MENTRA-CALL-ROUTINE.md) for current fixture limitations.

The September 16 dev baseline hid Call on iOS. The separate `codex/enable-mentra-call-ios` branch restores availability and is integrated into the current harness checkout. Its normal hardware/pairing guards still apply: an unpaired host lacks the required camera capability. Run `mentra-call-availability` from signed-in home to verify the enabled launcher and search result, declaring the actual fixture with `--fixture`. The former `mentra-call-ios-availability` exclusion suite is retired; its recordings remain historical evidence. Neither suite qualifies a meeting.

Mentra Live pairing has separate device-selection and Bluetooth audio steps. On this Mac, `blueutil` 2.14.0 (`brew install blueutil`) provides inquiry/pair/connect commands without mouse input. Put the exact target in pairing mode with three quick power-button presses, run `blueutil --inquiry 8 --format json`, and match the user-confirmed name/address before pairing. Use `blueutil --pair <verified-address>` and `blueutil --connect <verified-address>`, then require the app's pairing flow and audio readiness to advance. A CLI return code alone is insufficient. Do not reset Bluetooth globally or touch unrelated keyboard/mouse/headset bonds. An obsolete bond may need to be removed for that exact target, followed by fresh pairing; retain any failure and request pairing mode again if the target stops advertising.

A new Classic bond can connect only HFP while A2DP fails. Require the exact glasses to appear as both an input and output in `system_profiler SPAudioDataType -json`; `blueutil` reporting `connected: true` alone does not prove usable audio. On September 16, reconnecting just 03BE once after successful bonding brought up HFP/AVRCP/A2DP and exposed both devices. Preserve a failed attempt and diagnose it before retrying; do not delete the bond repeatedly.

For reproducible Mac audio setup, install `switchaudio-osx` (`brew install switchaudio-osx`, tested 1.2.2). Record each selected default using `SwitchAudioSource -c -t input -f json`, then `output` and `system`. `SwitchAudioSource -a -f json` lists actual names and UIDs. The routine reads these values and verifies the same UIDs afterward; it does not select or restore devices. Connecting a headset may automatically change the defaults, so finish the user's setup before recording the baseline. Keep browser microphone/camera/speaker selection inside Teams and use the laptop's built-in devices for that participant.

macOS can show a second entry with the same glasses suffix for Bluetooth Classic audio. The September 17 setup was incomplete until the user found and connected that second **03BE** entry. A BLE-connected entry, or a USB **Mentra Microphone**, is not evidence of a Bluetooth speaker. Finish **Connect → Pair Audio** and the normal system pairing step, then require the exact glasses' output UID to appear. The observed 03BE Classic UIDs were `CC-E7-DE-E0-03-BE:output` and `CC-E7-DE-E0-03-BE:input`. Derive these from the selected glasses on another machine; do not copy this fixture's address.

The observed iOS-on-Mac `AVAudioSession` port is named `Mentra_Live_03BE` with raw transport `Bluetooth`, whereas the iPhone profile types are `BluetoothHFP` and `BluetoothA2DPOutput`. The feature branch recognizes the generic type only when `isiOSAppOnMac` is true and the name matches the selected glasses. It also observes route/foreground changes independently of starting microphone capture. No fake connected flag is used.

If Call source needs a release change, use the existing sync workflow from the MentraOS root, with the actual external checkout path because an isolated worktree may not have the normal sibling layout:

```sh
bun scripts/sync-miniapp.mjs --repo /absolute/path/to/Mentra-Call --pack-script pack:prod --bump patch
```

Follow the repository's external-miniapp version/commit/push requirements. Rebuild the Mentra App with `bun ios:mac` after updating its ZIP. A new run records the archives in the actual running binary in `run.json`; compare its current Call ZIP hash with the source-tree artifact. This identifies packaged bytes, not a running miniapp's extracted cache.

Complete camera and microphone permissions on first Call launch. Call 2.1.14 makes calendar optional because its calendar UI is hidden; calendar denial must not block New Call or Join via Link. When Computer Use rejects access to the macOS system-dialog owner, stop automated handling and request the one-time manual grant; do not route around the tool restriction. Preserve that setup gate in the run evidence.

Verify repository write access before publishing an external miniapp release (`gh api repos/Mentra-Community/Mentra-Call --jq .permissions.push`). On this initial machine the account could read Call but could not push; local source and packaging still worked. Resolve that access gate before treating the source commit as published.

### Call cloud-relay diagnostics on a new Mac

The first Mac's camera/microphone permissions are granted. For the paired UI suite, set up the documented fixture once: name Mentra Live, Direct link on, 540p / 15 fps / Auto / 102° bottom; close Call and run `mentra-call-ui` with the actual paired fixture. This routine creates no meetings. A cloud/WHEP meeting test separately turns Direct link off and must restore it afterward. Record all three Mac audio defaults (input, output and system alert), and preserve the user’s selections. For an explicitly declared BLE-only video/roster test, dismiss the Mentra “Glasses audio disconnected” warning with Ignore and exclude glasses return-audio qualification. Do not select audio routes merely to make a UI preflight pass.

For backend diagnosis, install the Porter CLI and run `porter auth login`; complete its browser device authorization. Login may select an unrelated default cluster. Use explicit verified target flags rather than changing the user's global selection:

```sh
porter cluster list
porter app list --cluster 5692
porter app logs cloud-dev --cluster 5692 --target aws-us-west-2-default --service runtime --since 10m --limit 200
```

These IDs were verified in project 15081 on September 16; discover them again on the new machine. The local test host uses dev Core/Runtime while `pack:prod` selects the production Call miniapp backend. Record both endpoints as part of the fixture. Do not silently change environments when one fails.

The first real join failed because Cloudflare accepted the configured token as active but rejected Stream access for its account (403). Check `CF_STREAM_ACCOUNT_ID` and `CF_STREAM_API_TOKEN` in Doppler `cloud-v2/dev_aws` and the merged Porter configuration without printing secrets. The token needs Stream Write for that account; an active-token check alone is insufficient. Porter and Doppler matched during this failure; root `cloud-v2/dev` also held the same account/token pair, so switching to it would not change this result. Ask the token owner to correct scope/account or replace the credential in Doppler, then use the matching coordinated deployment path from the [Porter runbook](../../cloud-v2/docs/runbooks/porter/deploys.md). Do not borrow production credentials or deploy an unrelated image as a workaround. This user's Porter Kubernetes role allowed reads but denied pod exec; that access boundary was retained.

Server logs and generated meeting URLs are private run evidence. Keep sanitized error excerpts and operation results in the report, never commit raw tokens or meeting links. After an unsuccessful create-and-join, verify whether the created meeting object was retired; returning home alone did not do so in the first test.

The recorder uses a fixed video canvas and explicitly scales frames up/down while preserving their aspect ratio. This was verified with Mentra on an external 1x display; earlier recordings that captured a quarter-size image remain unchanged as historical evidence. Keep the app window dimensions constant during a run.

### Mac hotspot API isolation

Desktop focus is not a general setup prerequisite. A controlled foreground retry still returned Apple hotspot error 8; a separate signed UIKit probe reported active application state while another Mac app was frontmost and returned the same error. Keep normal replay in the background. Record UIKit state separately from desktop focus when investigating lifecycle behavior, and do not interpret generic error 8 as Apple's distinct not-in-foreground error 14.

For a minimal API reproduction on another Mac, build a small UIKit app with the existing development identity, provisioning profile, bundle ID and required HotspotConfiguration/Wi-Fi information entitlements. Archive its source and executable hashes separately from the product build. Use a fresh temporary test SSID, invoke `applyConfiguration`, retain error domain/code and elapsed time, remove only that test configuration and confirm its absence. This tests configuration submission, not association to real glasses. Preserve the original signed app wrapper and restore it through a background launch afterward; never reset its container. The first machine's exact source/build/replay scripts are retained under `.test-results/mentra-e2e/2026-09-16T23-52-07Z-minimal-hotspot-probe/`; their local paths and expected product hash must be replaced with the new machine's verified build.

The recorder now uses the actual accessible window title plus process identity. The different-title diagnostic recording verified three screenshot/AX pairs; a separate same-build paired-home relaunch verified recorder reattachment. An earlier attempt failed before executing any probe because the recorder required the literal title “Mentra”; that incomplete run remains preserved.

The subsequent [real-hotspot diagnostic routine](MAC-HOTSPOT-DIAGNOSTICS.md)
records macOS association, successful iOS requests over Wi-Fi with system routing
and explicit source-IP binding, the same-process failure caused by requiring the
Wi-Fi interface type, and an incoming request from the glasses to the actual iOS
WHIP server. It includes the English
steps, local cached script locations, exact run evidence and transfer requirements
for another Mac. None of these results qualifies a Teams call.

When the operator requests spoken attention for setup gates, macOS includes
`/usr/bin/say 'Mentra testing needs your attention; see the pending request.'`.
Use it only for an actionable request, and keep credentials and meeting links out
of speech. Confirm the output route is audible before relying on it; Bluetooth
tests can move audio to the glasses. The September 16 alerts used the MacBook Pro
speakers. Speech requests attention; it never counts as permission approval.

## Glasses OTA on the test Mac

Local builds enable glasses updates only with an explicit public
`EXPO_PUBLIC_ASG_OTA_VERSION_URL` in `mobile/.env`. Select and archive a published
manifest, rebuild the app, then follow [OTA-ROUTINE.md](OTA-ROUTINE.md) for fixture
identity, initial versions, replay commands and independent post-update checks.
The build manifest records the URL and verifies its presence in Release JavaScript.
The glasses need their own download route, such as the office Wi-Fi; the Call
hotspot test is a separate routine. Never copy another Mac's USB transport ID or
another pair's hardware fixture. The completed update recording and deterministic
already-current replay are documented separately from an autonomous installation.


### Local Network permission qualification on repeated launches

A fixed installation path and Apple-issued signature are necessary build hygiene,
but are not yet a proven fix for repeated Local Network prompts on this Mac.
The unchanged signed installation asked again in the 04:45 UTC September 17
run. Record every manual grant and exclude such a run from unattended
qualification. A successful retry after approval only proves current access.
Keep native denial logs, executable UUID/signature and installed path with the
run. Do not reset privacy settings or bypass macOS security as part of replay.
See `MENTRA-CALL-ROUTINE.md` for the current evidence and remaining investigation.
