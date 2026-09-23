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

- Full Swift SDK package: 190 tests pass, including Live journal/context and NIMO reconnect inventory. Extended AR99 timeout/old-readback/restart suite: six tests pass.
- Full Android SDK compile and unit suite: 456 tests across 74 suites pass. Extended AR99 recovery tests also pass.
- Mobile OTA regression run: 198 tests across 14 suites pass. Follow-up identity/navigation/recovery UI run: 52 tests across seven suites pass; additional Live dismissed-host and AR99 configuration cases pass.
- Isolated Live hook: 16 tests pass. File-provider/shared contracts, native observation, staging, gallery and synthetic fourth-provider suites passed earlier; final package sweep remains tracked below.
- Engine build and mobile typechecking pass after rebuilding the public declaration output. Changed-file lint retains existing errors in the unrelated `focusEffectPreventBack` hook; new code's errors are being checked separately.
- PR checkpoint CI: Android app build, Swift package, Android tests, quality, public boundary, lockfile and release-family checks pass. iOS app build reached successful build steps and was uploading its post-job cache at the latest inspection. Revalidate the final pushed head.
- Manual Maestro firmware-check flow exists but has **not** been run.

## Review and remaining work

- First independent Codex review requested changes for idle NIMO reconnect inventory, completion navigation blocked by the screen lock, and AR99 uncertain-transfer recovery. The first two are fixed with native/UI regression tests; AR99 rollout is gated and the existing flow restored.
- Live custom presentation now preserves the host's selected native target and entry point. Late completion callbacks do not navigate an unmounted host.
- [ ] Finish final public package, type/lint and regression checks.
- [ ] Push review fixes, merge latest `dev`, rerun independent Codex review on the final head, and address supported findings.
- [ ] Monitor final CI and review bots; mark the implementation ready for review when those checks are complete.
- [ ] Request permission before Live phone testing and record actual hardware acceptance. Keep unavailable AR99/iPhone and NIMO release gates explicit.

This is not a production firmware release or a claim of regression-free hardware behavior. The architecture can be reviewed before hardware acceptance; merging/enabling unvalidated device migrations remains a separate gate.
