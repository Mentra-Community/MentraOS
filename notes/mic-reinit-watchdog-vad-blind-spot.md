# Mic reinit watchdog fires on normal VAD silence (OS-1712)

Fix spec for a native-code bug (Kotlin + Swift). Not implemented here — this
document is the handoff for whoever picks up OS-1712.

## Symptom

On a physical Pixel 8 + Mentra Live, this log line fires every 10 seconds,
continuously, indefinitely, for the entire lifetime of a connected session:

```
CORE: MAN: No audio activity in the last 5 seconds from glasses, reinitializing glasses mic
```

Each occurrence re-sends an `enable_custom_audio_tx` BLE command to the
glasses. This isn't a one-off blip — it was observed firing every ~10.01s for
15+ minutes straight in a single session with no gaps.

## Root cause

The watchdog is purely a packet-arrival timer with no awareness of voice
activity detection (VAD).

- Android: `DeviceManager.checkAndReinitGlassesMic()` —
  `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/DeviceManager.kt:326-341`.
  Condition: `System.currentTimeMillis() - (lastLc3Event ?: 0L) > 5000`, gated
  only by `glassesMicEnabled && glassesConnected`. Runs on a repeating
  `Runnable` set up in `init()` (lines 314-323), firing every 10s.
- iOS: equivalent `checkAndReinitGlassesMic()` —
  `mobile/modules/bluetooth-sdk/ios/Source/DeviceManager.swift:802-813`, same
  5s-threshold / 10s-interval pattern.
- `lastLc3Event` is stamped unconditionally at the top of
  `handleGlassesMicData()` (Android `DeviceManager.kt:715`, before any
  decode/validation) whenever *any* glasses SGC pushes a raw LC3 audio chunk
  — called from `G1.kt:637`, `G2.kt:4924`, `MentraNex.kt:1237`,
  `MentraLive.kt:9091`, `RemoteHarness.kt:203` (iOS analogues at
  `G1.swift:1229`, `G2.swift:4983`, `MentraLive.swift:3274`,
  `MentraNex.swift:2061`, `RemoteHarness.swift:243`). None of these paths
  check speech vs. silence — it's a byte/packet-count-style timer, not
  content-aware.
- The watchdog lives in the shared `DeviceManager`, not per-SGC code, and
  runs identically for every connected model (G1, G2, MentraLive, MentraNex,
  ...) as long as mic is enabled and glasses are connected. The
  `enable_custom_audio_tx` BLE command it re-sends
  (`MentraLive.kt:6465-6486`) is MentraLive-specific plumbing, but the
  trigger logic deciding *when* to fire it is model-agnostic.

Mentra Live does have a real on-device VAD channel that the watchdog never
consults: `sr_vad` K900 messages -> `handleSpeakingStatus()`
(`MentraLive.kt:4362-4372`, `4676-4685`), which only forwards to
`Bridge.sendSpeakingStatus(speaking)` for JS/UI consumption. There's also
`voice_activity_detection_enabled` in `DeviceStore` (`MentraLive.kt:4687-4690`)
and a phone-side Silero VAD (`VadGateSpeechPolicy`, wired in
`DeviceManager.kt:290-312`) reporting `Bridge.sendVoiceActivityDetectionStatus`.
Both exist and are plumbed to JS, but neither is read by
`checkAndReinitGlassesMic()`.

## Why this matters

If Mentra Live's firmware suppresses packet transmission during confirmed
silence (VAD-gated), then 5+ seconds of a user simply not talking trips this
exact code path and fires a spurious, harmless-but-noisy `enable_custom_audio_tx`
resend — a false-positive "reinit," not evidence of a dead mic. For G2 (no
confirmed VAD gating on this codepath), the same logic is more plausibly a
genuine recovery mechanism for real mic dropouts, so the watchdog can't simply
be deleted — it needs to distinguish "silence because VAD says so" from
"silence because the mic actually died."

Continuously re-sending a BLE command every 10s for the lifetime of every
session has a real cost even when harmless: unnecessary radio wake-ups /
battery drain, and log noise that can mask a real reinit when one is needed.

## Suggested fix

Before firing the reinit in `checkAndReinitGlassesMic()`, check the model's
own VAD state and skip the reinit if the model reports VAD-confirmed silence
rather than "no signal at all."

Note that this state does not exist yet and must be added first:
`voice_activity_detection_enabled` in `DeviceStore` is only the
enable/disable SETTING, and the `sr_vad` handler
(`MentraLive.kt:4676-4684`) just forwards each event via
`Bridge.sendSpeakingStatus(speaking)` without persisting anything. The
implementation therefore needs to record the latest VAD speaking status and
its timestamp somewhere the watchdog can read (e.g. a
`lastVadStatus`/`lastVadStatusAtMs` pair updated from the `sr_vad` handler,
in `DeviceManager` or `DeviceStore`). Do NOT gate on the
`voice_activity_detection_enabled` setting itself; that would suppress real
mic recovery whenever VAD is merely enabled. Concretely:

- For SGCs that expose a reliable VAD/speaking-status channel (confirmed:
  Mentra Live via `sr_vad`), gate the 5s-silence check on "no VAD status
  update either," not just "no raw audio packet."
- For SGCs without a confirmed VAD channel (G2), leave the existing
  packet-timer behavior as the sole recovery mechanism — don't accidentally
  suppress real recovery for a model that needs it.
- This likely means adding a per-model capability flag (something like
  `hasReliableVad: Boolean` on the SGC registry entry introduced in the
  Phase 2 `SGCManager` refactor) rather than hardcoding a model check inline
  in `DeviceManager`.

## Repro

Pair a phone to Mentra Live, sit quietly (don't talk) for 15+ seconds with
the mic enabled, and watch:

```bash
adb logcat -v time --pid=$(adb shell pidof com.mentra.mentra) | grep -i "reinitializing glasses mic"
```

One line every ~10s, indefinitely, confirms the bug. To rule out a dead mic
as the actual cause, correlate with BLE traffic (`enable_custom_audio_tx`
being re-sent each time with no gap where the glasses stayed connected and
otherwise healthy — battery/heartbeat traffic still flowing normally in
between).
