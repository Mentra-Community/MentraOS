# Pluggable device OTA implementation

**Goal:** Implement the approved provider architecture for Live, NIMO and AR99; preserve Live policy/recovery; validate the mobile/native paths; open a PR to `dev`, mark it ready for review, and address CI/review findings. Do not merge automatically.

**Spec:** [Device-owned OTA](../specs/2026-09-22-pluggable-device-ota-design.md).

**Branch / PR:** `device-ota-providers`, [PR #4149](https://github.com/Mentra-Community/MentraOS/pull/4149), targeting `dev`. Previous NIMO integration PR #4076 is merged.

## Implemented

- Shared native-device provider registry, explicit pairing/setup requirements, revisioned observation, retained sessions, admission and resource ownership, diagnostics, artifact staging and source policy.
- Live headless session, availability and per-flow auto-chain ownership; existing manifest, transport, timing and presentation behavior. Native journal and connection-context fencing wrap the existing commands. Cold recovery queries status without restoring install/chain approval.
- NIMO Swift/Kotlin protocol, native updater, integrity checks, full firmware/packed/peer compatibility, fresh inventory, reboot verification and conservative interrupted-session recovery. Device differences stay below miniapps.
- AR99 provider and native ownership around the existing transport, preserving vendor requests and reconnect offsets. Image validation remains separate from running-version verification.
- Shared pairing/settings/background/recovery UI, native-identity-preserving Wi-Fi return, scoped hotspot cleanup, runtime/logout admission, and a passive recovery indicator outside signed-in routes.
- Public Engine/SDK observation APIs, OEM composition support and package consumer fixture.

## Rollout and hardware gates

**No phone installs or glasses tests have run for this implementation.** The owner has a Motorola Android phone paired to Live E7FA and explicitly requires permission before any hardware testing. Finish builds/reviews first, then ask. The iPhone is offline. No AR99 is available.

- **Live:** phone regression acceptance remains required. Automated preservation tests do not prove Wi-Fi/hotspot, old firmware, BES/MTK reboot, screen-off or interruption behavior on a physical device.
- **AR99:** the managed replacement is opt-in (`EXPO_PUBLIC_ENABLE_MANAGED_AR99_OTA=true` in the consumer host, or an explicit OEM vendor source). The existing modal/service remains the default. A failed transfer followed by old-version readback does not establish a safe remote abort; tests deliberately retain the unsafe journal and reject reflash. Verify recovery and activation on hardware before removing the old execution path. This is the spec's staged migration gate, not a completed AR99 rollout.
- **NIMO:** the catalogue contains the bench-verified compatibility identity but no production firmware distribution pin. The earlier Mac bench update used the vendor's dirty/Debug image; broad distribution, eligible starting versions and interruption recovery remain unapproved/unverified. That bench device is already on the target and is not an eligible old-firmware phone test. Do not downgrade or reflash it speculatively.

## Validation evidence

Logs are under `.context/ota-implementation/`; earlier research is in `.context/ota-design-review/`, and NIMO protocol/bench evidence is in `.context/nimo-ota-bench/`.

- Full Swift SDK package after merging current `dev`: 200 tests pass, including Live journal/context and NIMO reconnect inventory. Extended AR99 timeout/old-readback/restart suite: six tests pass.
- Full Android SDK compile and unit suite: 466 tests across 74 suites pass. Extended AR99 recovery tests also pass.
- Mobile OTA regression run: 198 tests across 14 suites pass. Follow-up identity/navigation/recovery UI run: 52 tests across seven suites pass; additional Live dismissed-host and AR99 configuration cases pass.
- Full Engine sweep: 1,100 tests pass with no failures, followed by ten passing script/package tests. This includes all 16 Live hook tests, NIMO safe-exit coverage and the synthetic fourth-provider UI. The later provider-open failure close test also passes.
- Engine build and mobile typechecking pass after rebuilding the public declaration output. Changed-file lint retains existing errors in the unrelated `focusEffectPreventBack` hook; new code's lint errors are fixed.
- PR checkpoint CI: Android app build, Swift package, Android tests, quality, public boundary, lockfile and release-family checks pass. iOS app build reached successful build steps and was uploading its post-job cache at the latest inspection. Revalidate the final pushed head.
- Manual Maestro firmware-check flow exists but has **not** been run.

## Review and remaining work

- First independent Codex review requested changes for idle NIMO reconnect inventory, completion navigation blocked by the screen lock, and AR99 uncertain-transfer recovery. The first two are fixed with native/UI regression tests; AR99 rollout is gated and the existing flow restored.
- Live custom presentation now preserves the host's selected native target and entry point. Late completion callbacks do not navigate an unmounted host.
- Second independent review and Bugbot identified explicit recovery reconnect rejection and mismatched native progress units. Both platforms now delegate same-device recovery reconnects to the retained SGC and use fractional progress. Tests verify that a different native identity is rejected without replacing the owner.
- The second review also found the NIMO setup lockout and broken hook test initialization. Safe setup cancellation now returns to device selection without onboarding success; missing-source, unknown-version, failed-check and unsafe-transfer cases have provider coverage plus actual host navigation coverage.
- Native follow-up: 13 Swift recovery/DeviceManager tests pass; Android SDK compile and targeted Live/NIMO/DeviceManager tests pass. The new Live observation record survives a second phone restart without restoring Start approval.
- [x] Finish public package, build and type checks after the setup-result API addition.
- GitHub Codex also found that an initial provider-open failure had Retry but no exit. The generic view now releases a safely idle failed provider and closes, preserving cancelled setup as a distinct outcome; three generic UI tests pass.
- Third independent review found that Live's established BES reboot and legacy APK version completion did not release the new native journal, and that NIMO recovery preparation retries could retain the old manager connection generation. Both are fixed. Live binds the existing coordinator verdict to the native device/updater/session/generation/revision, persists completion before releasing ownership, and keeps the flow retained until native confirms it. Unsupported providers reject host completion evidence. NIMO rebinds the manager only after the current channel is prepared; stale-generation replies cannot complete recovery.
- Follow-up validation: 95 mobile coordinator tests (including actual BES/APK completion), five Engine completion-fence tests, 21 Swift updater tests, and Android SDK compile with the new Live/NIMO recovery tests pass. Full Engine suite and ten package/script tests pass. Public completion evidence is exported through the SDK/Engine facade.
- The third review posted findings but its receipt verification failed because the branch advanced during the run. It is not counted as a final-head review; keep the next review head fixed.
- iOS checkpoint CI failed on artifact-storage network timeouts before compilation; the failed job has been rerun. Android app and other checkpoint checks passed.
- Merged `dev` at `c08c2fa07a`, resolving the old hook versus provider conflict by moving the new version-info failure copy/state into the Live session/presentation. All 16 Live hook tests, including the incoming assertion, pass. Engine build, mobile types and public consumer/boundary checks pass. No `routine:day1-ota` label is enabled; automated hardware testing remains unrequested.
- Fourth independent review completed on `5dd8e7f` with three findings: a failed Live completion handoff had no retry; iOS NIMO cold recovery discovery still required a pairing name; Android NIMO abort retained the previous link's OTA subscription state. All three are fixed. Completion retries re-read and fence the same native transaction (three attempts for revision races), then expose a recoverable error whose Retry only repeats completion. Recovery discovery uses the retained UUID; ordinary pairing retains its name policy. Shared Android link teardown clears OTA characteristics/subscription state.
- Fourth-review regression evidence: 114 Live session/provider/coordinator tests, six completion-fence tests, 16 public Live hook tests, six Swift compatibility/discovery tests, Android SDK compile and a real SGC/CCCD resubscription test pass. The latter rejects old-GATT acknowledgments and waits for the new subscription acknowledgment. Engine build, mobile types and changed-file lint pass.
- Current-head CI at this checkpoint passed all checks except the queued iOS app build/gate. Bigbob is reachable with three active workers; there is no identified user permission dialog. Hardware testing remains disabled.
- All CI checks, including the signed iOS build/publication and Android APK, passed at `34cc29b212`. The fifth independent run stalled once and restarted automatically. Its follow-up found that a phone-side BES timeout could replace the required reboot instruction with completion retry. The coordinator now publishes release safety; unsafe BES failures retain their restart instruction and refuse Done until the existing reconnect/status path proves safety. Completed-pass verification retries remain available.
- Additional AR99 audit: legacy start/end now publish native ownership into the shared snapshot, including across connection changes, so JS blocks logout/device replacement before destructive settings changes. Existing explicit legacy retry/cancel remains admitted; the wire flow and managed rollout gate are unchanged.
- Follow-up validation: 115 Live session/provider/coordinator tests, 13 shared-service tests, 16 Live hook tests, seven Swift AR99 updater tests, and Android SDK compile/AR99 tests pass. Engine build/mobile types and changed-file lint pass; the complete Engine sweep also passes.
- Sixth independent review completed on `007a532` and reproduced a legacy AR99 provider release gap: native returned to safe idle, but the retained provider stayed unsafe. The provider now consumes that transition, releases its runtime lease, clears the stale offer and exposes Check/Close without claiming successful activation. Twelve AR99 provider tests pass, including provider/service integration for legacy completion, cancellation/error, reconnect and reopening.
- The stock Live failure screen now respects both `canRetry` and `canFinish`; unsafe BES recovery has no inert Done button. A renderer test covers restart guidance, safe Done and completion Retry. Engine build, mobile typechecking and changed-file lint pass for this follow-up.
- Seventh independent review completed on `efa793c`: a transient Live native observation error remained latched, and the old mobile watchdog assertion still expected unsafe Done. Fresh identity-validated reads/events now recover the observation without changing the bound transaction; a missed terminal event updates release safety. Twelve completion tests cover initial/refresh failures, healthy recovery and identity rejection. The mobile watchdog regression covers unsafe timeout followed by authoritative terminal status; all 31 progress-screen tests and the full mobile Jest suite (138 suites, 1,203 tests) pass locally.
- [ ] Push the seventh-review fixes and rerun independent Codex review on a fixed head; address supported findings.
- [x] Mark PR #4149 ready for review (not hardware-accepted or ready to merge).
- [ ] Monitor final CI and review bots and resolve supported findings.
- [ ] Request permission before Live phone testing and record actual hardware acceptance. Keep unavailable AR99/iPhone and NIMO release gates explicit.

This is not a production firmware release or a claim of regression-free hardware behavior. The architecture can be reviewed before hardware acceptance; merging/enabling unvalidated device migrations remains a separate gate.
