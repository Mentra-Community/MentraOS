---
status: active
owner: Philippe
---

# Mentra App end-to-end harness: iOS app on Mac

## Decision

Use the real iOS app on Apple Silicon as the system under test, initially installed from TestFlight and then built locally to verify our accessibility fixes. Discover its behavior with native computer control, then turn the verified routine into **typed TypeScript tests running under Bun, backed by a small Swift macOS accessibility driver**. Normal replay must run from a terminal with **zero model calls**.

For app iteration, `bun ios:mac` builds the existing iOS target for Xcode's **My Mac (Designed for iPhone/iPad)** destination. Release is the default because bundled JavaScript makes replay independent of Metro and matches the packaged-app execution model. Debug plus Metro remains available for development. This avoids TestFlight's upload/distribution delay while keeping the iOS runtime; it does not introduce Catalyst or a simulator. The current PR CI provides an unsigned compile check, not an installable IPA. A local development-signed build is therefore the direct path. See the [setup guide](../../../tools/mentra-e2e/SETUP.md) for provisioning and reproducible commands.

Record the running executable and JavaScript hashes. When supplied with a local build manifest, the runner checks those hashes before any action and records source provenance only after they match. A dirty local build remains explicitly dirty. During relaunch, TestFlight needs its installed outer wrapper; accept that wrapper only when its executable and JavaScript match the current process, so another installed build cannot be substituted silently.

The English routine, standalone Swift/Bun runner, continuous video and step viewer are implemented. The original seven-step login/validation proof passed twice from a terminal. Authenticated discovery exposed missing accessibility semantics; this branch now fixes those controls in the app and removes coordinate/visual input fallbacks. A local signed Release build exposes these controls, and three consecutive full 70-step terminal replays passed in 91–93 seconds with zero model calls. Each produced 70 screenshots and accessibility snapshots plus an MP4 with English chapters. README records the exact qualification evidence and remaining browser/provisioning limits.

The existing Maestro tests do not constrain this choice. The deciding factors are the actual execution target, reliable selectors, independent replay, and how much infrastructure we need to maintain.

## Target and evidence collected on September 15, 2026

| Item | Observed fact |
| --- | --- |
| Host | Apple Silicon, macOS 26.6.2 |
| Running app | Mentra, bundle ID `com.mentra.mentra` |
| Installed version | `3.2.0`, build `320000235` |
| Binary platform | `iPhoneOS`, SDK `iphoneos26.2`; an iOS app running on macOS |
| Source reference | Branch `codex/mentra-e2e-harness`, isolated worktree based on `origin/dev` commit `95dfa6c4b2f341917b687798ff7b0065365d3115` |
| Initial UI | Signed out, on the authentication start screen |
| Native accessibility | Exposes text, buttons, an email text field, and a secure password field |
| Interaction proof | Opened **Log In**, verified the form, used its back button, verified the start screen returned |
| Artifacts | Three PNG screenshots, with accessibility observations, in the probe folder below |

Probe artifacts, relative to the repository root:

```text
.test-results/mentra-e2e/design-probe/2026-09-15T20-43-59-123Z/
```

After the design probe, real sign-in reached onboarding and the unpaired home fixture. Settings reports `MentraOS v3.2.0-dev.235`. Profile, account forms, logout cancellation and feedback were observed. The installed commit/backend identity remains unknown; the checkout SHA is only a source reference. Earlier failed runs remain in the evidence directory.

Two app paths resolve to the same bundle ID on this Mac. Selecting by bundle ID was ambiguous; `/Applications/Mentra.app` did not attach through the discovery tool, while selecting the running wrapper's full path worked. That wrapper resides under a temporary `/var/folders/.../Wrapper/Mentra.app` path. **Do not hard-code that path in replay.** Resolve the running process and its actual bundle URL each run, verify bundle ID/version, and reject an unresolved multiple-process ambiguity.

## What is covered

Phase 1 tests behavior available without physical glasses: authentication, navigation, the home and all-apps surfaces, account screens, local preferences, privacy and speech screens, miniapp presentation, and honest disconnected states. Cloud requests made by the real app remain real; there is no mocked backend hidden behind a passing E2E result.

Use separate fixture profiles:

- `unpaired`: no selected/paired glasses and no active Phone Mode session.
- `paired-disconnected`: an existing pairing, with the device disconnected. Do not erase it to make the test fit the unpaired profile.
- `phone-mode`: explicitly running the app's simulated/Phone Mode feature. It is useful no-hardware coverage, but has different expected UI from either disconnected profile.

Record the profile before running. A connected physical device is a precondition failure for this suite. Current source shows that **Set up without glasses** can lead into simulated pairing, and Phone Mode's **Start** connects a simulated device. It must not silently change the disconnected fixture.

Passing this suite establishes behavior of this binary on this Mac. It does not establish BLE, OTA, glasses capture, audio transport, SoftAP transfer, or iPhone screen-off behavior. Existing iOS background and gallery functionality remains established product behavior; this target simply does not exercise those paths.

## How I will interact with the app

### Discovery and the first English walkthrough

The initial probe used the native computer-control interface (`cua_repl`). After the shared-desktop requirement, discovery switched to the same Swift accessibility driver used for replay, through its recorded `discover` command, to:

1. Attach to the running app and inspect its macOS accessibility tree.
2. Identify controls by their current meaning, role, placeholder, and surrounding screen.
3. Click, type, scroll, and navigate using the real UI.
4. Inspect the resulting tree and screenshot after each action.
5. Save the observation, assertion, screenshot, and successful action into the run's evidence.

This has already worked for the start → login → start probe. That initial probe proved external discoverability. Subsequent recorded Swift-driver discovery and the complete terminal pass proved AXPress/AXValue operation for the routine without global input.

Element indices displayed by the discovery tool are transient. For example, **Log In** changed from index 12 to 13 after returning to the same screen. Store semantic selectors, never those indices, in durable tests.

### Replay outside an AI session

Use these components:

| Component | Proposed technology | Responsibility and justification |
| --- | --- | --- |
| Test runner | Bun + TypeScript | Ordered steps, typed selectors, assertions, deadlines, fixtures, cleanup, and reports. Bun is available on this machine; no application build is needed. |
| Native driver | Small Swift executable using AppKit and ApplicationServices | Locate the target process/window, read attributes, invoke `AXPress`, set editable `AXValue`, and invoke exposed page-scroll actions. No global input or focus activation. |
| Video and screenshots | ScreenCaptureKit stream + H.264 MP4 | Record only Mentra, without audio/cursor, and save PNGs from the same stream. Separate screenshot capture interrupted video in the initial experiment. |
| App accessibility | Labels, button roles, test IDs and ordinary accessible actions | We own the app. Fix inaccessible controls at their source so assistive technology and replay use the same product behavior. No OCR, coordinate or visual input fallback. |
| Reports | JSON events, PNGs, Markdown and static HTML | Machine-readable results and a browsable step-by-step artifact folder without a report server. |

The driver exposes a small JSON command interface. Keep assertions and app-specific screen knowledge in TypeScript, not in Swift. Supported interaction primitives are snapshot, accessibility press, editable value entry and exposed accessibility actions; capture and normal relaunch are separate lifecycle operations. Add other primitives only when a verified test requires them; do not build a general desktop automation framework.

Require a working accessibility press action. A control without one fails with an actionable app-accessibility error. Text entry uses `AXValue`; the original spike proved that it triggers both real validation and successful sign-in. Secure values go through an in-memory input channel, not shell arguments or the clipboard. There is no mouse/keyboard injection, visual matching or focus/raise command in the driver.

A standalone process needs its own working macOS Accessibility and screen-capture permissions. The existing computer-control tool's access does not establish that access for a new executable. Include an explicit permission preflight and a stable driver installation/signing identity. Report missing permission as setup failure before clicking anything; do not change system permission settings silently.

The Mac must be awake and unlocked with the Mentra window open. Only one run owns that window at a time. The user may work in other apps: AX actions do not move the pointer or activate Mentra. You may move the window during recording. Keep its size fixed; do not minimize or close it. Relaunch uses `activates = false`; an isolated lifecycle probe now passes on dev.235 with capture reattachment and Codex retaining desktop focus. Both relaunches also passed in the complete local-build routine. A dedicated Mac Mini remains the simplest permanent test station.

## Why this choice, and when to change it

| Alternative | Strength | Fit for this first target | Decision |
| --- | --- | --- | --- |
| Swift accessibility driver + TypeScript | Direct access to the installed app; few runtime components; clear artifact ownership | Matches the accessibility surface already observed, but we own driver maintenance and must qualify input/capture | Recommended for the bounded first lane, subject to the spike |
| Appium Mac2 | Maintained macOS XCTest driver, existing queries and automation ecosystem | Strongest alternative; requires Appium, Mac2, Xcode/WebDriverAgent setup and permissions. Compatibility with this wrapped TestFlight app has not been tested | Prefer it if the native spike uncovers substantial work in querying, input, or window handling |
| Native macOS XCTest | Apple-supported UI test machinery and assertions | Viable candidate for external-app testing, but this iOS-on-Mac target still needs a proof and Xcode test-target setup | Reconsider with Mac2 before growing a custom driver |
| Maestro | Concise YAML, waits and mobile test tooling | Its documented targets cover mobile devices/simulators and web; a Mac host running the CLI is not evidence that it can drive an iOS app hosted as a Mac application | Good later candidate for a simulator/Android lane; no verified adapter for this exact target |
| Appium XCUITest / Detox | Established iOS automation or React Native synchronization | The current target is not an iOS simulator/device session; Detox normally needs an instrumented app build | Not the first lane for the installed TestFlight binary |
| Playwright | Excellent browser automation | Cannot drive the surrounding native app. Potentially useful for a separate miniapp web test suite | Not the native driver |
| Coordinate macros / AppleScript-only GUI scripting | Fast to prototype | Blind coordinates drift; GUI scripting still needs selectors, waits, screenshots and failure reporting | Reject coordinate macros; fix app accessibility instead |
| AI on every step | Can interpret unfamiliar screens | Repeats inference cost and latency; changes behavior from run to run | Use for discovery and repairing a failed routine, not replay |

The cost of the recommended choice is real: maintaining a native boundary, managing macOS permissions, and writing reliable selectors. Its advantage is a narrow local dependency stack for an already accessible app. **Fix app-side accessibility defects in the app. If the native driver itself needs substantial infrastructure, compare Mac2 before extending it. Changing drivers is not a substitute for making a control accessible.** No claim is made that the custom driver will be faster or more reliable than Mac2 before measurement.

Why TypeScript rather than YAML: the routine needs scoped selectors, state restoration, secret references, branch-specific assertions, and evidence hooks. Typed code handles those directly and avoids inventing a growing YAML language. Keep each test declarative where possible. Every step carries its English instruction and expected outcome; the runner generates the checklist from those fields once the routine is implemented. A `.yml` file is not inherently more reproducible than an ordinary versioned test.

## The reusable routine: what “compiled” means

The English checklist is the starting specification. During the first walkthrough, convert each verified step into a deterministic action plus a meaningful assertion. Review changes to expected behavior against source and product intent; an observed bug must not become the expected result just because it appeared in the first run.

The resulting cache is ordinary checked-in test code, selectors, fixture definitions, and app accessibility contracts. It is not a cache of the model's thoughts, a saved live accessibility tree, or a replay of old coordinates.

Illustrative step metadata (the implemented `Step` interface lives in `runner/suite.ts`):

```ts
step({
  id: "AUTH-02",
  instruction: "Open Log In from the authentication start screen.",
  expected: "The login form shows an email field and a secure password field.",
  run: async (ui) => {
    await ui.expectScreen("auth-start")
    await ui.press({description: "Log In", within: "main-content"})
    await ui.expectVisible({role: "textField", placeholder: "Email address"})
    await ui.expectVisible({role: "secureTextField", placeholder: "Password"})
  },
})
```

The runner, rather than each test author, owns screenshot capture and event persistence around every step. If a human checklist item expands into multiple clicks, record numbered action substeps and capture each resulting state. English coverage and executable coverage must be traceable by the same IDs.

Selector rules:

1. Give app-owned controls stable `testID` values, human-readable localized accessibility labels, correct roles and working accessibility actions. IDs belong on the actual native interactive element, and must be unique in their active screen/container.
2. Verify the installed build exposes each identifier and its action in the native tree. A source prop or an `AXPress` success code alone is not acceptance; assert the resulting UI state.
3. Existing meaningful roles/labels/placeholders may identify controls that already work. Resolve freshly before every action; reject missing or ambiguous matches.
4. If a control is anonymous, cannot be activated through accessibility, or disappears behind a gesture-only wrapper, stop that scenario, preserve evidence, fix the app and install the rebuilt version. Do not fall back to element bounds, screen positions, OCR or screenshots.
5. Accessibility actions call the same product handlers as ordinary touch. Do not expose test-only navigation, secret routes or a test backend that bypasses product behavior.

Current source fixes cover capsule minimize/close, shared Back, home grid launchers, all-apps open/search/clear/dismiss, and running-miniapp open/select/dismiss controls. See [the accessibility contract](../../../tools/mentra-e2e/ACCESSIBILITY.md). The old dev.235 binary predates these changes. The local Release build has been exercised with the new identifiers; an older binary correctly fails their contract.

Wait for expected state with bounded polling, initially up to 10 seconds for local navigation and 30 seconds for network-dependent screens. Record actual timings and adjust from evidence. Avoid fixed sleeps as synchronization. Retry observation while waiting, not state-changing actions whose completion is uncertain.

A replay failure stops the affected scenario, captures evidence, and reports the failed assertion. It does not call a model, guess an alternate route, or silently update the baseline. Independent scenarios may continue only after their start state is re-established.

## English routine

The complete numbered Step 1 checklist is in [ROUTINE.md](../../../tools/mentra-e2e/ROUTINE.md), with expected results and current verification status. Keep the stable step IDs when translating it to executable flows. The exact executable order is generated into COMPILED-ROUTINE.md. A first full replay passed; final revision qualification is recorded in README.

## Screenshots, reports and secrets

Every run records a continuous MP4. `index.html` displays the video with searchable English step descriptions that seek to their start times; `chapters.json` is the portable timestamp index. PNGs remain useful for quick inspection. A failed recording makes the run incomplete.

Run layout (step filenames use `passed`/`failed`):

```text
.test-results/mentra-e2e/<UTC timestamp>-<unique suffix>/
  run.json
  events.jsonl
  checklist.md
  summary.md
  index.html
  routine.mp4
  chapters.json
  screenshots/
    000-preflight.png
    001-AUTH-02-pass.png
    002-AUTH-03.01-pass.png
    003-AUTH-03.02-pass.png
    004-HOME-02-fail.png
  accessibility/
    001-AUTH-02.json
  failures/
    HOME-02.json
```

The repository already ignores `.test-results`. Each discovery run and each replay gets a new folder; never overwrite a previous run. The manifest records test revision/hash, native driver version/hash, installed app identity, verified/unknown app commit, backend/fixture identity, host OS, locale, geometry/scale, start/end time, completion status and cleanup status. Keep source SHA and binary identity as separate fields.

Every executed action/substep captures the resulting target-window image after its assertion settles, or at the point of failure. Store full accessibility snapshots rather than diffs for independently readable evidence. A skipped step has a reason, not an invented screenshot of an unvisited screen. Capture failure context before cleanup and flush events as the run proceeds so a crash leaves usable evidence.

Screenshot creation is itself checked: missing/empty/undecodable captures are harness failures. ScreenCaptureKit support for this window, transient dialogs and secure-input/autofill overlays must be qualified. A screenshot is evidence, not an assertion by itself. Start with semantic behavioral assertions and manual visual review of the first baseline. Add deterministic visual comparisons only for stable regions, with masks for timestamps, dynamic account data and animations; do not declare full-screen pixel equality to be functional correctness.

Use secret references such as `MENTRA_E2E_EMAIL` and `MENTRA_E2E_PASSWORD`, supplied to the runner through an existing local secret mechanism or an interactive non-echoing prompt. Never check the supplied password into this document, tests, fixtures or command lines. Redact secure fields and credential values before writing AX snapshots or events. Keep password visibility off, including on failure. A Keychain-backed setup can be added when credential storage is deliberately configured; provisioning new stored credentials is not part of this design probe.

Reports may contain account identity and content visible in the test app. Keep runs local by default. Sharing/uploading results is a separate action, with redaction appropriate to their destination.

## Implementation and acceptance

See the companion [implementation plan](../plans/2026-09-15-mentra-app-e2e-harness.md).

1. **Driver proof:** attach to the exact installed app, inspect fresh selectors, open login, enter non-secret validation data, prove React Native receives it, navigate back, scroll a suitable screen, and save target-window screenshots. Then prove authorized sign-in and masked secret handling. Resolve temporary wrapper identity and permission preflight. Run the proof twice from a terminal without an AI controller.
2. **Go/no-go on the driver:** if straightforward native operations do not work reliably, run the same proof with Appium Mac2 and choose the lower-maintenance working option. Do not spend weeks building a UI framework.
3. **English walkthrough:** execute the proposed routine, assign precise fixture branches, record bugs separately, and save screenshots at every action. Some authenticated screens have been observed; complete replay remains unqualified.
4. **Encode incrementally:** add each confirmed step immediately; replay each short section without AI before expanding the suite. Generate the English checklist from the test metadata to prevent drift.
5. **Qualify replay:** complete three consecutive full runs of the selected fixture with zero model calls and no manual corrections. Preserve all earlier failures; three passes establish an initial baseline, not a statistical reliability guarantee.
6. **Qualify failure handling:** intentionally use a nonexistent selector and a wrong expected screen in bounded driver/runner checks. Expect timely nonzero exit, a truthful failed step, a screenshot, and completed cleanup reporting. Also verify missing permissions and an ambiguous target cannot produce a false pass.

The doctor is implemented. Full `no-glasses` commands below remain planned and currently fail explicitly as unimplemented:

```sh
bun run tools/mentra-e2e/run.ts doctor
bun run tools/mentra-e2e/run.ts run --suite no-glasses --fixture unpaired
bun run tools/mentra-e2e/run.ts run --suite no-glasses --fixture paired-disconnected
```

Credentials are supplied independently; the command does not contain them. The runner prints the artifact folder and exits nonzero for failed required coverage, setup failure, or interrupted/incomplete runs. A pass can include only predeclared not-applicable branches and must show those counts; an unimplemented required step cannot turn green.

The planned code lives in `tools/mentra-e2e/` with `native/`, `runner/`, `flows/`, `fixtures/` and a short README. Keep it independent of the mobile build and of the legacy Maestro flows. Pin the toolchain/dependencies used by the runner, and record the native artifact identity. Build the Swift helper once and rebuild when its source/toolchain changes.

After a UI update, retain the failed run, inspect the changed screen, revise only affected selectors/actions or intentional expectations, and replay the revised section plus the full smoke routine. Versioned tests are the reusable cache; an app update should not require rediscovering every unchanged screen.

## Sources and limits of this design

Local source inspected: `mobile/src/app/home.tsx`, `mobile/src/components/home/AppsGrid.tsx`, `AllAppsGridSheet.tsx`, `PairGlassesCard.tsx`, `mobile/src/app/auth/email-login.tsx`, `mobile/src/app/index.tsx`, `mobile/src/app/onboarding/welcome.tsx`, `mobile/src/app/miniapps/settings/{settings,profile,appearance,privacy,speech,miniapp-dev}.tsx`, `mobile/src/components/settings/DeviceSettingsSection.tsx`, `mobile/src/components/dev/VersionInfo.tsx`, and `mobile/src/constants/miniapps.ts`.

Existing tests were inspected as historical context: `mobile/.maestro/` contains old tab/navigation and sample-login assumptions; `.github/workflows/mentra-app-maestro-android.yml` currently has `if: false` with a flakiness comment. That says nothing about the intrinsic quality of Maestro and is not the reason to reject it for this target.

External references consulted:

- [Appium Mac2 overview](https://github.com/appium/appium-mac2-driver): macOS automation through Apple's XCTest framework.
- [Appium Mac2 setup](https://appium.github.io/appium-mac2-driver/latest/getting-started/): Appium/Xcode requirements and permissions.
- [Maestro project overview](https://github.com/mobile-dev-inc/Maestro): documented platform scope and YAML approach. Its supported-platforms documentation URL returned HTTP 403 during this investigation; no native macOS driver was verified.

Open questions are bounded: standalone driver compatibility, first-login onboarding/profile, exact installed commit/backend, semantic access to icon-only/navigation controls and embedded miniapp content, and screenshot behavior for overlays. Resolve those with the proof and first walkthrough before claiming the routine is executable.
