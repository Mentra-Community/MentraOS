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

- Full Swift SDK package: 192 tests pass, including Live journal/context and NIMO reconnect inventory. Extended AR99 timeout/old-readback/restart suite: six tests pass.
- Full Android SDK compile and unit suite: 458 tests across 74 suites pass. Extended AR99 recovery tests also pass.
- Mobile OTA regression run: 198 tests across 14 suites pass. Follow-up identity/navigation/recovery UI run: 52 tests across seven suites pass; additional Live dismissed-host and AR99 configuration cases pass.
- Full Engine sweep: 1,092 tests pass with no failures, followed by ten passing script/package tests. This includes all 16 Live hook tests, NIMO safe-exit coverage and the synthetic fourth-provider UI. The later provider-open failure close test also passes.
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
- [ ] Push review fixes, merge latest `dev`, rerun independent Codex review on the final head, and address supported findings.
- [x] Mark PR #4149 ready for review (not hardware-accepted or ready to merge).
- [ ] Monitor final CI and review bots and resolve supported findings.
- [ ] Request permission before Live phone testing and record actual hardware acceptance. Keep unavailable AR99/iPhone and NIMO release gates explicit.

This is not a production firmware release or a claim of regression-free hardware behavior. The architecture can be reviewed before hardware acceptance; merging/enabling unvalidated device migrations remains a separate gate.
