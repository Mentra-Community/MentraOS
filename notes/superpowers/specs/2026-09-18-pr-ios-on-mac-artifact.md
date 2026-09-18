---
status: active
owner: philippe
---

# Installable iPhone and Mac artifacts from PR CI

## Outcome and scope

A successful eligible PR build publishes two downloads from the same signed Release iOS Mentra App: a directly installable iPhone IPA and an app ZIP for registered Apple Silicon test Macs. The existing final PR Slack post links both exact artifacts. A tester downloads, installs and launches without TestFlight, Metro, compiling the app, or signing it locally. The IPA is an ad hoc distribution artifact, not a TestFlight/App Store export; PR CI does not upload either artifact to App Store Connect.

Only PR CI changes are authorized. Dev/staging coordinated releases and their App Store/TestFlight exports remain unchanged. Do not change product feature defaults, enable the Mac network test adapter, or turn on the Call environment override as part of packaging. This is not a Catalyst or Simulator app.

## What exists

- `.github/workflows/mentra-app-ios-build.yml` runs on the in-house ARM64 Mac runner. It builds a Release `generic/platform=iOS` product with signing disabled and currently has no artifact publication step.
- The user confirms that this runner already has signing credentials. Inspect its certificate purpose and available profiles before assuming anything else is required. No new signing credential distribution is planned.
- Release exports use `app-store-connect`. Those IPAs are signed for App Store/TestFlight distribution; that does not establish permission for direct installation on this MacBook.
- The locally working iOS-on-Mac app uses a device-limited provisioning profile and an outer `WrappedBundle` wrapper. PR #4069 contains the corresponding verified installer and manifest support, but is not yet part of this plan's `origin/dev` baseline.
- The Android workflow's `notify-pr-builds` job calls `.github/scripts/notify-pr-builds.mjs`. It waits for the matching ASG run, verifies public artifacts and deduplicates Slack posts. It currently knows nothing about iOS.
- Coordinated releases retain signed-IPA handoff and publication, including bounded artifact-upload retries. Recover the relevant former PR upload behavior from history if available, rather than assuming a disabled block is still in the current file.

## Artifact and signing choice

Publish two assets to the existing `pr-builds` release:

- `mentra-ios-iphone-pr-<number>-<sha>-<run>-<attempt>.ipa`: the Xcode-exported, signed ad hoc IPA for registered iPhones, installed through Apple Configurator or Xcode.
- `mentra-ios-mac-pr-<number>-<sha>-<run>-<attempt>.zip`: the same signed iOS app with the iOS-on-Mac wrapper/installation support, short installation instructions and a portable build manifest.

Hash both final archives in the publication receipt and document the installation route for each. An IPA download link alone is not a tap-to-install web distribution service; adding such a service is outside this plan.

Prefer Xcode-managed archive/export using the existing distribution identity with an ad hoc (`release-testing`, where supported by the installed Xcode) profile authorizing both the test Macs and iPhones. A separate profile per device is unnecessary for the same app: register the devices and include their identifiers in the shared profile before export. The certificate comes from read-only Match; the PR-only profile comes from the encrypted `IOS_PR_PROFILE_BASE64` Actions secret. This supports Apple Developer profile maintenance without granting write access to the certificate repository. Adding a device later requires updating the profile and re-exporting, not rebuilding the source. Do not replace the profile used by release workflows. Verify the profile's allowed devices, expiration, certificate association, bundle identifier and required entitlements. The key distinction is the profile's allowed distribution method and devices, not whether an IPA is signed at all.

Let Xcode generate the correct signatures and entitlements. Do not strip capabilities to make a binary launch, and do not put a provisioning profile on framework targets. Reuse the current compilation cache and build one Release product, not a separate Catalyst or second full app build. Export the IPA once, retaining all supported device variants rather than thinning it for one device, and derive the Mac ZIP from that signed app without modifying its inner bundle or re-signing it.

Use the existing installer behavior from #4069 for the managed path, preservation of account/pairing data, verification and rollback. Resolve that small dependency without importing the entire harness PR into this work. The artifact must be relocatable and include any small precompiled launcher it needs: it must not compile the launcher on the tester's Mac or contain CI workspace paths. A small Bun-based installer is acceptable for the existing harness machines; document that runtime requirement explicitly. Keep normal macOS first-use approvals; do not promise zero prompts or disable platform protections.

## Publication and notification

Keep signing and publishing limited to trusted same-repository PRs, using the existing in-house runner and signing setup. Fork PRs retain unsigned compilation. Do not add a privileged workflow that executes arbitrary PR scripts with release credentials.

Reuse the existing Mac-to-artifact-to-publisher handoff and upload helper where applicable. Bounded retries must inspect an existing upload after an ambiguous failure; they must not overwrite an asset with different bytes. Separate compile/sign, handoff and publication failures so upload recovery does not require rebuilding the app. Verify the downloaded asset's size and hash before emitting its receipt.

Record PR head SHA, actual checked-out merge/build SHA, run ID and attempt, app version/build, bundle ID, architecture, backend, executable/JavaScript hashes, both archive hashes and non-secret signing/profile metadata. Confirm both packages contain the same signed app. A rerun has distinct coordinates. Do not claim a merge-ref build is exactly the PR head.

Invoke one reusable notification job after Android, iOS and ASG build/publication completions, including failures and retries. Serialize updates per PR with `queue: max` so simultaneous completions are retained. Inspect artifact-producing jobs rather than overall workflow completion, because the notifier itself is still part of the workflow. Defer without polling when another producer is pending; that producer's completion invokes reconciliation again. Use the iOS publication job's actual attempt when locating the receipt, including failed-publication and notification-only retries. Align trigger paths with the shared workflow. Handle failed, cancelled, skipped and superseded builds, preserve deduplication and make partial readiness explicit for each artifact. Link the exact published iPhone IPA and Mac ZIP, installation instructions and iOS build logs in both Slack and the existing PR build comment. Only report both downloads as ready after both verify. Keep Android/ASG links and pinned firmware metadata.

## Acceptance

1. A current same-repository PR generates an identified, installable iPhone IPA and Mac ZIP from one signed app, with verified public links for both.
2. The exact downloads install and launch on a registered iPhone and Philippe's MacBook with no source build, local signing, TestFlight or Metro. Native executable and bundled JavaScript match the published manifest and each other. Record device/OS and installation-method evidence; do not infer iPhone success from Mac-only validation.
3. Replacing a prior managed installation preserves account/pairing data and rollback behavior. Missing device authorization is diagnosed before replacement.
4. Required Bluetooth, Local Network/hotspot, keychain and associated-domain capabilities survive packaging; signing checks do not substitute for device behavior qualification.
5. Slack sends one final message for the current PR revision, shows the correct iPhone and Mac artifacts/statuses, and never promotes a missing or stale upload as ready.
6. Existing dev/staging/TestFlight workflows and product defaults are unchanged.
