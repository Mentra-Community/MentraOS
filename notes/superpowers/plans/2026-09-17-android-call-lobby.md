---
status: active
owner: philippe
---

# Android Call guest admission follow-up

Follow-up to merged PR #4078, based on dev `2668275c49`. Continue the
Call qualification in `2026-09-16-mentra-call-ios.md`. Keep OTA and Call
routines separate; preserve the instrumented glasses during this diagnosis.

## Reproduction and cause

On Motorola Razr Plus 2024 `ZY22JWCN97` (Android 16), PR #4078 APK at
`55378ed` joins the meeting but fails to admit the named anonymous Teams guest:
`java.lang.IllegalArgumentException: The cookie is not valid: {0}.`
The guest stays in the browser lobby. This is not a browser cookie error.

A separate Android app using only Microsoft's calling SDK reproduces this
without Mentra, Bluetooth, glasses, camera permission or microphone permission.
It joins as Presenter, initializes and retains CallLobby before the guest
arrives, subscribes to lobby updates, and admits only the named guest. Both
versions use the same phone, Graph meeting, ACS identity, anonymous browser
profile, guest name, common SDK 1.3.0 and source. No meeting policy is modified.

| Calling SDK | Lobby collection | Selected guest admission | Browser |
| --- | --- | --- | --- |
| 2.16.0 | remote=1, lobby=0 | Invalid native result handle | Remains in lobby |
| 2.16.1-beta.7 | remote=1, lobby=1 | successCount=1, failedParticipants=[] | Connected |

The 2.16.0 exception originates at `ProjectedObjectCache.getOrCreate`, called
by `AdmitParticipantsResult.getInstance` from `CallLobby$1.get`. The published
Java wrapper passes a zero result handle returned from native admission.
The installed PR APK's three arm64 ACS libraries are byte-identical to the
published 2.16.0 AAR. Initializing the lobby earlier does not fix this version.

## Change and validation

- [x] Pin calling SDK to 2.16.1-beta.7, the tested preview, without lobby-policy
  changes, automatic admit-all, retries or a new lifecycle wrapper.
- [x] Preserve the existing selected-guest, capability and call-generation guards.
- [x] Log native admission exceptions with their stack for actionable diagnosis.
- [x] Verify anonymous browser admission in the isolated native SDK comparison.
- [x] Run Android native unit tests against the updated SDK: 223 passed,
  zero failures/errors/skips. The existing generated Android host loaded the
  new worktree's ACS module through a local Gradle settings override.
- [ ] Build and install the exact follow-up PR APK; record active Call bundle.
- [ ] Qualify selected admission, advancing remote video, audible audio both
  ways, mute/unmute, background operation, roster/leave/rejoin and owned cleanup.

**Risk:** this intentionally uses a preview Microsoft dependency because its
stable predecessor fails the observed guest-admission path. The comparison is
admission evidence, not a full product/media qualification or an OTA pass.
Do not mark the full routine passing until the remaining device checks pass.

Local evidence: `.test-results/pr-4078-android-qualification-55378ed/` in the
mentra-e2e integration worktree. `android-call-live-01` contains the failing
Mentra recording and audit; `sdk-lobby-probe/native.log` contains both SDK
runs and the complete stack, and `sdk-lobby-probe/browser-beta` records the
connected browser guest. Credentials and meeting links stay local and private.
