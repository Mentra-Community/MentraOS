---
status: active
owner: philippe
---

# PR iPhone and Mac artifact implementation plan

Spec: [Installable iPhone and Mac artifacts from PR CI](../specs/2026-09-18-pr-ios-on-mac-artifact.md).

Branch: `codex/ci-ios-mac-artifact`, isolated worktree based on `origin/dev` at `8bb1fba99f049215b149e53cfaab77d56ab44f2c`. Implementation in progress; product behavior and coordinated release workflows are unchanged.

1. **Verify the existing signing/export route.** Inspect certificate and profile metadata on the pinned Mac Mini; confirm this MacBook and the test iPhone are authorized devices. Reuse the existing distribution certificate and one suitable ad hoc profile covering both. If only App Store profiles exist, provision the additional PR-only profile. Check historical PR upload removal and reuse the working release handoff. Prove the exported app installs on iPhone and launches through the existing Mac wrapper before expanding CI plumbing.
2. **Package two downloads from one signed app.** Add a PR-only archive/export path to the existing iOS workflow, retaining cache/retry behavior and unsigned fork checks. Export one ad hoc IPA without device-specific thinning. Publish that IPA for iPhone and package its signed app, wrapper, installer/precompiled launcher and relative-path manifest into a Mac ZIP without modifying the inner app. Reuse the small installer support from #4069; coordinate that dependency without pulling the full harness into this branch. Preserve entitlements and default product behavior. Do not add a TestFlight export or upload.
3. **Publish reliably.** Upload both results with bounded retries, then use the existing release publication pattern for `pr-builds`. Verify final bytes for each and emit a machine-readable receipt tied to PR head, checkout SHA and workflow attempt. Distinguish build failures from upload failures, retaining the built result for publication recovery and handling partial publication without overwriting good assets.
4. **Extend the final PR Slack message.** Update `notify-pr-builds.mjs` and the Android workflow's notification job to include the applicable matching iOS run and publication receipt. Adjust bounded waiting for iOS duration, preserve current-revision/deduplication checks and report individual artifact failures/skips. Add “iPhone — Download IPA”, “Mac — Download app”, installation instructions and iOS build-log links to Slack and the PR build comment. Do not edit coordinated dev/staging release notifications.
5. **Test and qualify both exact CI downloads.** Add focused packaging/provisioning checks and notifier tests for slow iOS completion, one or both missing uploads, wrong SHA/attempt, cancelled/superseded runs, retries and deduplication. Run a real PR build, download both published artifacts, install/launch on a registered iPhone and this MacBook, and verify hashes, settings, replacement behavior and both Slack links. Confirm both artifacts contain the same signed app. Record any device-unavailable qualification gap explicitly. First device validation concerns installation/navigation; streaming and OTA remain separate routines.
6. **Document setup and handoff.** Document registering Macs/iPhones in the shared profile, profile regeneration and re-export when adding devices, iPhone installation through Apple Configurator or Xcode, the Mac installation command, provisioning expiration and how to add the later test Mac Mini. Open a focused PR to `dev` with actual CI artifact/installation evidence and any remaining platform permission prompts.

Proposed final experience: open the PR Slack post → choose iPhone IPA or Mac ZIP → install through the documented platform route → launch Mentra. Both use one signed Release app and a profile authorizing the test devices. The certificate/private key stays on the build infrastructure. No TestFlight, repeated local build or signing steps.

## Implementation evidence (2026-09-18)

- PR archive/export, two downloads, portable Mac installer and publication receipt are implemented locally. The iPhone/Mac app comes from one ad hoc export; publication runs on Ubuntu with the existing artifact CDN helper.
- The notifier waits for applicable iOS publication and verifies both download sizes against a receipt tied to the exact workflow attempt. A publication-only retry retains the original build attempt and bytes.
- Seventeen Node checks and two Python checks pass; the bundled Swift launcher compiles locally. Local profile parsing confirmed that Mac provisioning uses Provisioning UDID and that whole-plist JSON conversion cannot handle its dates; the installer extracts the needed fields individually.
- Signing gate: the shared Match repository currently has only `profiles/appstore/AppStore_com.mentra.mentra.mobileprovision`. Current GitHub credentials can read but cannot push to that repository. SSH to `bigbob` rejects the current key. Requested the signing owner to create the ad hoc profile; no release profile changed.
- Exact CI download installation on iPhone/Mac is pending that signing setup. The paired iPhone is available for qualification. No phone or running Mac app has been replaced by this work yet.

- Draft PR: https://github.com/Mentra-Community/MentraOS/pull/4101. First CI run reached and passed the artifact tests, then exposed that hosted Ruby installation tries `/Users/runner` on the self-hosted Mac. Switched to the runner's existing Homebrew Ruby with job-local gems. A real Xcode project fixture also confirmed the signing edit preserves Debug and framework configurations.

- CI run `35386230120` passed the self-hosted Ruby setup and decrypted Match successfully, then stopped at the confirmed missing `AdHoc_com.mentra.mentra.mobileprovision`. The job cleaned up its keychain. Added explicit Mac inclusion to profile setup instructions and the Apple intermediate-certificate imports used by coordinated signing to the isolated PR keychain. No installable artifacts have been produced yet.
