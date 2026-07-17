# Mic reinit watchdog is VAD-blind (OS-1712)

Investigation and implementation handoff for a native-code bug in the Android
and iOS Bluetooth SDKs. This document separates the code path that is confirmed
from the Mentra Live firmware behavior that still needs an A/B hardware test.
No runtime fix is included in this PR.

## Observed symptom

On a physical Pixel 8 paired with Mentra Live, this log line fired every
~10.01 seconds for more than 15 minutes while the user was quiet:

```text
CORE: MAN: No audio activity in the last 5 seconds from glasses, reinitializing glasses mic
```

For Mentra Live, each occurrence calls `setMicEnabled(true)` and immediately
re-sends the `enable_custom_audio_tx` command over BLE.

## Confirmed code path

The watchdog is a packet-arrival timer with no awareness of voice activity:

- Android schedules `DeviceManager.checkAndReinitGlassesMic()` every 10 seconds
  from `DeviceManager.init()`. If the glasses are connected, their mic is
  enabled, and `lastLc3Event` is more than five seconds old, it calls
  `sgc?.setMicEnabled(true)`. A missing timestamp is treated as `0`, so Android
  also attempts recovery when no audio frame has ever arrived.
- iOS schedules the equivalent method every 10 seconds from
  `DeviceManager.init()`. Its five-second check starts only after the first LC3
  frame because `lastLc3Event ?? Date()` evaluates to a fresh time on every
  check while the value is `nil`. Whether iOS should recover when the stream
  never starts is a separate parity decision the implementation should make
  explicit.
- Android and iOS stamp `lastLc3Event` at the start of
  `DeviceManager.handleGlassesMicData()`, before decode or validation. Raw LC3
  reaches that method from the G1, G2, Mentra Live, and Mentra Nex SGCs. Android
  Nimo reports equivalent liveness through
  `DeviceManager.reportGlassesAudioActivity()` because it decodes Opus inside
  its SGC. There are no `RemoteHarness` SGC files in the current tree.
- The trigger is shared by all SGCs. Its effect is model-specific because it
  dispatches through `SGCManager.setMicEnabled(true)`. Mentra Live's
  implementation starts its micbeat path, which sends
  `enable_custom_audio_tx`; other models use their own microphone command.

Relevant symbols:

- Android:
  `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/DeviceManager.kt`
  (`init`, `checkAndReinitGlassesMic`, `handleGlassesMicData`,
  `reportGlassesAudioActivity`)
- iOS: `mobile/modules/bluetooth-sdk/ios/Source/DeviceManager.swift`
  (`init`, `checkAndReinitGlassesMic`, `handleGlassesMicData`)
- Mentra Live Android:
  `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/MentraLive.kt`
  (`setMicEnabled`, `startMicBeat`, `sendEnableCustomAudioTxMessage`,
  `handleSpeakingStatus`)
- Mentra Live iOS:
  `mobile/modules/bluetooth-sdk/ios/Source/sgcs/MentraLive.swift`
  (the same symbols)

## VAD hypothesis (not yet proven)

Mentra Live receives on-device VAD state through `sr_vad` K900 messages and
forwards it from `handleSpeakingStatus()` as a `speaking_status` event. The
watchdog does not consult that state.

The working hypothesis is that, when glasses-side VAD is enabled, firmware
intentionally suppresses LC3 packets after `sr_vad` reports `on=0`. If so,
normal silence is indistinguishable from a dead microphone to the current
watchdog, and the repeated re-enable is a false positive.

The existing observation does not prove that causal link. Battery, heartbeat,
or other healthy BLE traffic proves that the connection is alive, not that the
microphone path is healthy or that VAD intentionally stopped LC3. Do not ship a
VAD-based suppression rule until the validation below confirms the firmware
behavior on the affected firmware version.

The two similarly named status sources are not substitutes for this evidence:

- `voice_activity_detection_enabled` in `DeviceStore` is the requested
  enable/disable setting, not the current speaking state.
- Android's phone-side `VadGateSpeechPolicy` configures a callback, but the
  current `DeviceManager` never calls `processAudioBytes()`. It is not an
  active liveness signal for this watchdog.

## Required hardware validation

Record the phone model, OS version, Mentra App build, Mentra Live firmware
versions, and whether the glasses-side VAD setting is enabled.

Run an A/B test without changing any other microphone setting:

1. With glasses-side VAD disabled, confirm whether LC3 packets continue through
   quiet periods and whether the watchdog remains silent.
2. With glasses-side VAD enabled, correlate each `sr_vad on=0` and `on=1`
   transition with LC3 packet cessation and resumption.
3. Confirm that speaking after a quiet period resumes LC3 without needing an
   `enable_custom_audio_tx` retry. If it does not, the symptom may be a real
   recovery case rather than intentional VAD gating.
4. Repeat across disconnect/reconnect and VAD disable/re-enable boundaries to
   establish whether `sr_vad` is a transition-only event or a periodic
   heartbeat and whether its last value survives those boundaries.

Only treat VAD-confirmed silence as the cause if the enabled/disabled comparison
and packet correlation are repeatable. Otherwise keep investigating the audio
transport failure.

## Implementation constraints after validation

Do not delete the shared watchdog. Models without confirmed VAD-gated audio,
including G2, still need packet-based recovery. Do not gate recovery on the
`voice_activity_detection_enabled` setting alone.

If the hardware validation confirms the hypothesis:

- Express the behavior on the current SGC abstraction, for example with a
  conservative `hasReliableVadStatus` or `usesVadGatedAudio` property on
  Android's `SGCManager` and the iOS `SGCManager` protocol. Default it to
  `false`; opt Mentra Live in only for validated firmware behavior. There is no
  separate SGC registry in the current implementation.
- Persist the latest speaking value and its receive time in connection-scoped
  native state that the watchdog can read. Clear it when the mic is disabled,
  VAD is disabled, the model changes, or the device disconnects/reconnects.
- A `speaking=true` state plus missing audio must remain a recovery condition.
  Missing, cleared, or stale VAD state must fall back to packet-based recovery.
- Do not treat one `speaking=false` transition as proof of liveness forever.
  If firmware supplies a documented periodic VAD heartbeat, use a freshness
  limit derived from its maximum interval. If `sr_vad` is transition-only, use
  a bounded silence grace followed by a rate-limited probe/re-enable; do not
  either resume the current 10-second loop or suppress recovery indefinitely.
- Track the last recovery attempt separately and use a bounded retry/backoff
  policy so a persistent failure cannot send a command every watchdog tick.

## Secondary Android micbeat bug

The repeated watchdog call exposes a separate timer-lifecycle bug in Mentra
Live's Android `startMicBeat()`:

1. It assigns a new object to `micBeatRunnable`.
2. It calls `removeCallbacks(micBeatRunnable)` on that new, never-posted object.
3. The previously scheduled runnable remains queued, while the new one is also
   posted for 30 minutes later.

Every watchdog retry can therefore add another self-rescheduling micbeat. After
30 minutes those callbacks begin sending additional
`enable_custom_audio_tx(true)` commands, and `stopMicBeat()` can remove only the
most recently stored runnable. The native fix must make `startMicBeat()`
idempotent by removing the previous runnable before replacing it (or by reusing
one stable runnable), and `stopMicBeat()` must leave no callback able to
re-enable the mic. iOS already invalidates its previous `Timer` before creating
a replacement.

## Regression coverage

Extract the watchdog decision into a small testable policy where practical and
cover at least:

- recent audio: no recovery;
- no VAD capability: preserve packet-timer recovery;
- `speaking=true` plus missing audio: recover;
- validated VAD silence: no 10-second retry loop;
- stale or cleared VAD state: recovery eventually resumes;
- disconnect, model change, mic disable, and VAD disable clear the state;
- repeated Android `setMicEnabled(true)` calls leave exactly one micbeat
  callback, and disabling the mic leaves none; and
- the chosen iOS behavior when no first LC3 frame ever arrives.

## Diagnostic command

For the default development package, start with:

```bash
adb logcat -v time --pid=$(adb shell pidof com.mentra.mentra) | grep -Ei "sr_vad|reinitializing glasses mic|enable_custom_audio_tx"
```

The stable and China variants use different package identifiers, so replace
`com.mentra.mentra` when testing one of those builds. Add temporary LC3 packet
counters or the structured BLE trace if the current log level does not expose
packet arrival clearly enough for the required correlation.
