---
status: draft
owner: Alex Israelov / Nicolo (OS-2055)
---

# Glasses audio setup as Bluetooth SDK state

## Result

The Bluetooth SDK decides whether the user has to do anything to get glasses audio working, and publishes that decision as one state per connected glasses. The Mentra App and enterprise apps render it. No app holds audio timers, platform rules or firmware checks.

- `GlassesStatus.audioSetup` and an `audio_setup_changed` event carry the state.
- Pairing success depends only on SDK readiness, pair failures and `audioSetup`. The Mentra App no longer waits for `pairing_info` itself.
- Glasses that can report their Classic audio link (A2DP and HFP to the phone) push it to the SDK. The SDK prefers that report over guessing from the phone's audio route.
- A new Mentra App pairs with, connects to and OTA-updates Mentra Live glasses on old firmware. An old Mentra App works unchanged with new firmware.

This applies to every glasses driver in the SDK. Mentra Live is the first; future glasses that bring up Classic audio from a BLE pair (CTKD) implement the same state and need no new app code.

## Why

1. **iPhone audio after pairing is a platform decision, not UI.** iOS has no API to open a Classic audio connection. Whether audio comes up after the BLE bond depends on CTKD support in the firmware, iOS transport bridging and whether another Bluetooth audio device holds the route. Only the SDK sees those inputs. Today the Mentra App owns the 8 s wait, the Pair Audio decision and the 10 s Home grace, so every SDK customer would have to rebuild them.
2. **The phone guesses; the glasses know.** iOS infers audio from `AVAudioSession` (and briefly switches the session to `playAndRecord` to probe it). That route is wrong whenever AirPods or a car hold it, which is the case behind the one recorded failure of automatic audio. The glasses know whether the phone's A2DP and HFP links to them are up.
3. **The app-side `pairing_info` gate duplicates the SDK and can spin forever.** On an explicit secure pair the SDK already withholds readiness until `pairing_info` with `owner_committed` arrives, and it has its own timeout. The Mentra App waits for the same message again. When the two disagree about firmware type, the loading screen spins with no failure, for example an Android pairing target re-listed from saved state with an unknown capability and old firmware that never sends `pairing_info`.

## State

```ts
export type GlassesAudioSetupState =
  /** No glasses session. */
  | {state: "idle"}
  /** This platform and glasses need no user step for audio (Android attaches Classic from the bond; glasses without Classic audio). */
  | {state: "not_applicable"}
  /** The link is up, audio is not, and the SDK still expects audio to come up on its own. */
  | {state: "connecting"}
  /** Classic audio to these glasses is up. */
  | {state: "connected"}
  /** Audio did not come up on its own. The user connects it in system Bluetooth settings. */
  | {state: "needs_user"; action: "connect_in_settings"}
```

`GlassesStatus.audioSetup: GlassesAudioSetupState` is always present. `audio_setup_changed {state}` fires on every change, the same shape as `pairing_state_changed`. Native code encodes the state as a map: `{"state": "needs_user", "action": "connect_in_settings"}`.

Every glasses model publishes it. Models without a driver-specific rule (all except Mentra Live today, including Simulated) report `not_applicable` while connected and `idle` otherwise; this default lives in the shared status layer. A status update that marks the glasses ready carries the matching `audioSetup` in the same update, so the app never sees "ready" with a stale `idle`.

## SDK rules (Mentra Live driver)

**Pairing readiness.** On an explicit pair to secure firmware the SDK reports ready only after `pairing_info` with `owner_committed`, with its existing timeout and pair failure. When the selected glasses' capability is unknown (for example an Android target re-listed from saved state), the SDK waits up to `UNKNOWN_CAPABILITY_PAIRING_INFO_WAIT_MS` (5 s) after `glasses_ready`: a secure `pairing_info` switches to the secure rule; otherwise the glasses are treated as legacy and reported ready. Readiness never waits without a deadline.

**Android.** `idle` without a session, otherwise `not_applicable`. Android attaches Classic from the BLE bond (CTKD on new firmware, `createBond` on old firmware), and there is no user step to offer.

**iOS.** With a session:

- **Audio is up** when the glasses report A2DP or HFP connected, or the phone sees a connected HFP input, a matching Bluetooth output or the Classic bond (the existing three signals). Either source is enough. Audio up gives `connected`.
- **Otherwise the SDK waits from a start time, then gives up:**

| Phase | Starts at | Wait | Then |
| --- | --- | --- | --- |
| Pairing, firmware reports `auto_audio` | readiness after `pairing_info.owner_committed` | `PAIRING_AUTO_AUDIO_WAIT_MS` (8 s) | `needs_user` |
| Pairing, no `auto_audio` (old firmware) | readiness | 0 | `needs_user` at once |
| Reconnect (any firmware) | readiness | `RECONNECT_AUDIO_GRACE_MS` (10 s) | `needs_user` |

- While waiting the state is `connecting`. A later "audio up" moves any state to `connected`. Losing audio after `connected` starts the reconnect wait again.
- A glasses report of "A2DP and HFP both down" does not shorten the wait: iOS may still be bringing the link up.
- The SDK logs the time from start to `connected` (`PAIRFLOW: audio_setup connected afterMs=…`) so the 8 s value can be set from real devices. The value stays 8 s until that data exists.

- The SDK switches the iOS audio session to `playAndRecord` to read Bluetooth inputs only until the glasses send `classic_link` in the current session. After that it uses the glasses' report and passive route observation, so the probe cannot report a route that is not there.

The rules live in one pure policy per platform (`GlassesAudioSetupPolicy.swift` / `.kt`) with mirrored table tests. `MentraLive` feeds it inputs and a deadline timer.

## Firmware report (`classic_link`)

New firmware sends `{"type":"classic_link","a2dp":<bool>,"hfp":<bool>}` (48 bytes) to the phone over BLE:

- as a snapshot when the phone sends `phone_hello` with protocol 4 or later;
- after any A2DP or HFP connect or disconnect with a phone, if the connected phone announced protocol 4 (`g_phone_protocol`, reset on disconnect).

Old Mentra Apps never send `phone_hello`, so they never receive the message. `pairing_info` is unchanged: it is already 215 of its 246 bytes.

- **Values.** `a2dp` and `hfp` are read from link state, not from the event that triggered the send: `app_bt_is_a2dp_connected(i)` and `app_bt_is_hfp_connected(i)` ORed over the `BT_DEVICE_NUM` phone slots. `hfp` is the HFP service-level connection, not an active call (SCO). Codec reconfiguration does not flip the A2DP value.
- **Triggers.** A2DP `IDLE`, `OPEN` and `CLOSED` and HFP `SLC_OPEN` and `SLC_DISCONNECTED` in `services/app_ibrt_v2/src/app_ibrt_customif_ui.cpp`, plus Classic ACL down. Each trigger restarts a ~200 ms `app_ctrl_later_timer`. When it fires on the app thread, the firmware samples both values and sends only if they changed since the last send. This merges the A2DP and HFP connects into one message and absorbs duplicate mock events.
- **Delivery.** Through `lxy_pairing_send_json`. The BLE queue drops messages until the phone subscribes, which is why `phone_hello` triggers a snapshot. If the queue refuses a message, the last-sent values stay unchanged and the timer retries every second while the phone stays connected, so the phone never keeps a stale "audio up".
- **Unrelated message.** The existing `sr_btst` push reports the AVRCP control channel, not audio, and no phone code reads it. It stays as is.
- **Gates.** A host test covers the builder and its size. `make` and `make transfer` both pass. `./build_pz.sh OTA` with the pinned ARM GNU 14.3.Rel1 toolchain keeps the raw image below 1,966,080 bytes. The change costs about 0.5 KB of a ~24 KB margin.

## Mentra App

- **Loading screen.** Remove the `pairing_info` listener, the 5 s `pairing_info` timer, `autoAudio` and the 8 s timer. Once the target is ready: `connected` or `not_applicable` shows success; `needs_user` opens Pair Audio; `connecting` keeps the spinner. Pair failures (including `ios_forget_pairing`) are unchanged.
- **Pair Audio.** Continues on its own when `audioSetup` becomes `connected`. There is no option to skip audio setup. The back arrow ("Cancel pairing") asks first ("Cancel pairing?" / "Your glasses will be unpaired from this phone." / Keep pairing, Cancel pairing), then unpairs the selected glasses through the SDK's `unpair` (the glasses forget this phone too) and returns Home. An attempt that never paired the selected glasses is only abandoned, and a different, earlier pairing is never unpaired. On iPhone the next pair of those glasses goes through "Forget the old pairing".
- **Home.** On Mentra Live, `needs_user` shows the existing "Glasses audio disconnected" prompt (Ignore / Connect), and any other state dismisses it. The app-side 10 s grace is deleted.
- `mobile/src/utils/pairing/pairAudio.ts` keeps only the route constant.

## Backward compatibility

| Phone app | Glasses firmware | Behavior |
| --- | --- | --- |
| New | Old field firmware (no secure pairing) | Listed as legacy and pairable (no `MP` advertisement marker, so `securePairingCapable=false`). Readiness at `glasses_ready`; no `pair_select`, `phone_hello` or rejection streak. iPhone: `needs_user` at once if audio is down, then Pair Audio; the user connects audio in Settings (old firmware lists the glasses under Other Devices). Android: `not_applicable`. Home and the OTA check work; the glasses download and flash updates themselves, so BLE carries only control messages. |
| New | Secure pairing without `classic_link` (#91 before this change) | Phone signals only. Same as today's PR behavior. |
| New | Secure pairing with `classic_link` | Glasses report plus phone signals. |
| Old (3.1/3.2) | New firmware | No `phone_hello`, so no window events and no `classic_link`. The owner reconnects. A new pair works inside the window. An old-app owner after a transfer shows "reconnecting" indefinitely and retries into 0x14 refusals. Ship the app before or with the firmware. |

**Glasses rolled back from secure to old firmware.** Today an iPhone saves every name it has seen with the secure trailer (`mentra_live_secure_pairing_names` in `UserDefaults`), never clears it and treats any later trailer-less advertisement from that name as partial. A rolled-back unit, or another unit with the same short name, then never appears in the scan, and `isSecurePairingTarget()` still matches the name, so a pair waits 40 s and fails. Android keeps the same set in memory until the app restarts. Required changes:

1. Remember a secure trailer per peripheral identifier, in memory, for a short time (about 10 s) within the current scan. Persist nothing. Clear it on forget.
2. `isSecurePairingTarget()` uses only the selected scan row's capability (`pending_device_secure_pairing_capable`), never the name memory.
3. Android clears `securePairingAddresses` on each `startScan`.
4. `mentra_live_secure_firmware` is refreshed each session: true on a secure `pairing_info`, false when a ready session gets no `pairing_info` within 15 s.

**Acceptance.** A new Mentra App reaches Home and offers an OTA on old firmware on iPhone and Android, including glasses that were rolled back from secure firmware.

## Testing

- Policy table tests on Swift and Kotlin with the same cases: each phase, both audio sources, audio lost after `connected`, session drop, glasses report arriving before and after phone signals.
- SDK scan tests: rolled-back unit lists as legacy once the short secure memory expires; a same-named legacy unit is not hidden; `isSecurePairingTarget()` follows the selected row.
- SDK readiness tests: unknown capability with no `pairing_info` is reported ready after 5 s; unknown capability with a secure `pairing_info` follows the secure rule.
- Mentra App Jest: loading screen for each state, no `pairing_info` dependency, old firmware, non-Mentra Live glasses (`not_applicable`); Pair Audio advance; Home prompt from `needs_user`.
- Firmware host test for the `classic_link` builder, size and protocol-4 gating.
- Devices:
  - iPhone pair on new firmware: number of Settings trips, time to audio from the log, with and without AirPods connected.
  - iPhone pair on old firmware through Pair Audio to Home and an OTA.
  - Android pair on old firmware to an OTA.
  - Rolled-back unit on iPhone and Android.
  - iPhone without a Classic bond on old firmware (app restarted on Pair Audio, then Ignore on Home), OTA to secure BES: the glasses may boot unowned and open pairing, and the saved-glasses path can wait up to 150 s, longer than the 120 s BES restart timeout. If that reproduces, the SDK skips the pairing-mode pause for the saved glasses while an OTA restart is pending.

## Decisions

- No option to skip audio setup in the pairing flow.
- The `AVAudioSession` probe stays for firmware that does not send `classic_link` and is not used once it does.
- Leaving Pair Audio cancels the pairing and unpairs the glasses after a confirmation.
