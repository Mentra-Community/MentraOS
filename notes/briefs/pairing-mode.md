---
status: active
owner: nicolo
last_verified: 2026-10-19
covers:
  - mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/MentraLive*Pairing*.kt
  - mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/MentraLiveOwnerLossPolicy.kt
  - mobile/modules/bluetooth-sdk/ios/Source/sgcs/MentraLive*Pairing*.swift
  - mobile/modules/engine/src/facades/pairing.ts
  - mobile/src/app/pairing/**
  - mobile/src/effects/PairingModePopup.tsx
  - mobile/src/utils/pairing/**
  - mobile/src/components/home/DeviceStatus.tsx
  - asg_client/app/src/main/java/com/mentra/asg_client/audio/PairingCodeSpeaker.java
  - asg_client/app/src/main/java/com/mentra/asg_client/service/core/handlers/PairingAudioCommandHandler.java
---

# Mentra Live pairing mode and ownership: context brief

Read this first for any pairing, pairing-mode, owner-loss, or ownership-transfer question.
It exists so a chat does not re-read `m8_pairing.cpp` (3.3k lines) and `MentraLive.kt`
(12.4k lines) from the top to rebuild the same picture. In past chats those two files
were read more than 1,000 times in total.

This is a map and a pitfalls log, not a spec. Rules change by branch and by flag. When
this brief and the spec disagree, the spec wins; then fix this file.

## Sources of truth, in order

1. Firmware contract: `/Users/mentra/Documents/mentra-live-bes/docs/pairing-spec.md` (rules R1 to R16, flags, hardware matrix status).
   Implementation: `mentra-live-bes/apps/xysmart/m8_pairing.cpp`, `mentra-live-bes/apps/xysmart/m8_pairing_policy.h`. Behavior tests: `mentra-live-bes/apps/xysmart/host_tests/test_pairing_host.c`. Wire messages: `mentra-live-bes/docs/wire-proxy-contract.md` (pairing section).
2. Phone state machine (Android and iOS mirror each other input for input): `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/MentraLivePairingStateMachine.kt`, `.../MentraLiveOwnerLossPolicy.kt`, `.../MentraLivePairingAdvertisement.kt`; iOS in `mobile/modules/bluetooth-sdk/ios/Source/sgcs/`.
3. History only: `agents/OS-1615-mentra-live-pairing-ux-plan.md` (its header says superseded by OS-2055; the body is design history).

## Flags (both sides must agree)

- Firmware: `MENTRA_SECURE_PAIRING`, `MENTRA_OWNERSHIP_TRANSFER` (build-time).
- App: `EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING` (`mobile/src/utils/pairing/securePairingFeature.ts`). The spec also names `EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER`, but it was not found in `mobile/` on branch `nicolo/os-2055-ownership-transfer` (checked 2026-10-17). Confirm which branch has it before assuming the app can show the transfer confirm screen.
- Behavior differs by flag. "Flag off" means forget-on-entry; "flag on" means the owner is retained on entry. Check which one the question is about before reading code.

## Phone-side model

- Public state: `Normal`, `PairingMode(windowId, endsAtMs)`, `Rejected` (wire value `pairing_rejected`).
- State machine effect after each input: `NONE`, `PAUSE`, `RESUME`, `REJECT`.
- Entry points:
  - `entering_pairing_mode` notice from the glasses (field `owner_retained` selects yield vs forget).
  - Connect-time rejection with HCI reason `0x05` (Authentication Failure) means "not your glasses": `MentraLive.recordAuthRejection()` then `onAuthRejection()` then `Rejected`.
- Engine mirror: `DeviceEventRouter.ts` handles `pairing_state_changed`. UI: `mobile/src/components/home/DeviceStatus.tsx` (Pair Again) and `mobile/src/effects/PairingModePopup.tsx`.
- Owner-loss never fires for an explicit pairing attempt from the scan screen.

## Glasses-side model (from the spec, verify before relying)

- Three power presses open a window, only after MTK is ready. Unowned glasses open one automatically once per boot at MTK readiness.
- Window is 120 s, with an absolute cap of 300 s (R7). A three-press in the first 2 s after the window opens does not cancel (`LXY_PAIRING_CANCEL_GRACE_MS`).
- First phone to complete a BLE bond becomes owner (R6). Outside the window only the owner connects (R8).
- Media is never wiped by pairing or ownership change.

## Pitfalls log: failures already found and fixed

These cost real time. Check them before proposing a "new" theory.

1. Pairing mode looked on but glasses were invisible. Mentra Live has one BLE slot. Entering pairing mode disconnects the current phone asynchronously, and advertising is refused (`ADV not allowed`) until that finishes, yet the LED and voice prompt had already started. The old phone also re-took the slot within a few hundred ms. Fix: LED first, then disconnect, then delete every saved BLE and Classic bond.
2. Boot loop. The "MTK ready, expose radio" path read saved BLE bonds before BLE storage was initialized, so the chip asserted and rebooted.
3. Classic audio never attached after a completed bond (`a2dp` and `hfp` stayed 0), and the app waited up to 8 s because the first `pairing_info` still had `classic_bond_ready: false`.
4. iPhone showed an empty list in Settings. Glasses deleted the bond but the iPhone kept its copy, reconnected with the old key and was hung up (reason `0x13`). Symptom: pairing mode must be entered twice and the phone must forget the glasses.
5. `pairing_info` is a readiness signal only. Do not gate UI or commands on `had_previous_bond`.
6. Do not re-arm the retired Design B parts: media wipe, pairing finalize/abort, transfer-status APIs.

## Open items and known doc conflicts

- The OS-1615 plan header says pairing forgets the previous owner immediately. The BES spec says this branch builds ownership transfer on and keeps the owner on entry. Both describe real code paths behind different flags. Do not "fix" one to match the other without reading both flags.
- The spec states matrix cases T1 to T9 have not passed on hardware and T6 needs product sign-off. The hardware harness and run logs are in `asg_client/tools/pairing-matrix/` (start with `cases.py` and `runs/m1/findings.md`; the `runs/` output is untracked local data).
- The ownership-transfer confirm screen is Android-only until the iPhone spike passes (per the spec).

## How to use this in a chat

- Start the chat with `@notes/briefs/pairing-mode.md`.
- Ask for the delta ("what changed since this brief?") instead of "what is the pairing design?".
- When a chat learns something durable (a new failure mode, a changed rule), add one line to the pitfalls log in the same change.
