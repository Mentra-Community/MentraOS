# ACS Teams media spike (P2–P6)

Throwaway verification lives in the product module behind `ACS-SPIKE` logcat
tags and `dumpPcmWav`. A second Android Studio app was not added so we do not
ship two WebRTC/ACS stacks. After P4 passes on device, this folder is the
quarantined runbook — not a second implementation.

```
adb logcat -s ACS-SPIKE
```

Join through Mentra Call (`MENTRA_PUBLIC_TEAMS_PROVIDER=acs`) or a scratch
miniapp (`example/App.tsx`). For the P4 WAV dump, pass `dumpPcmWav: true` on
native `join` (AcsMeetingService can be temporarily patched, or call the native
module from a debug screen).

| Phase | What to check | Pass |
|---|---|---|
| P2 | `ACS call state=` CONNECTING → IN_LOBBY/CONNECTED | Guest in Teams roster; leave idle |
| P3 | `P3 WHEP 201` then `P3 video … fps=` for ≥60s | No ICE failed |
| P4 | `P4 pcm rate=` then `P4 wrote …/acs-whep-p4.wav` | WAV intelligible (HARD GATE) |
| P5 | `P5 negotiated format` + second client sees/hears glasses | Wearer mic, not phone mic |
| P6 | Remote speech on glasses; no double-audio | Path: Expo `onIncomingPcm` → AudioPlaybackService → PcmStreamPlayer |

SDK-playback experiment (optional): do **not** set `IncomingAudioOptions.stream`.
Pass only if A2DP media route at media quality without SCO/voice mode.

iOS: re-run P3–P6; Android routing does not transfer. Foreground-only in V1.

## E1 — `OutgoingAudioOptions.setMuted(true)` vs a `RawOutgoingAudioStream`

Recorded 2026-08-28. Live Teams ear-test is a Phase 1 device-gate item; the
code default is set from the ACS 2.16.0 contract so glasses PCM is not
accidentally suppressed at join.

1. **Does `setMuted(true)` suppress a `RawOutgoingAudioStream`?**
   Treat as **unknown / do not rely on it**. Microsoft documents `setMuted` as
   starting with the **physical microphone** muted, and the SDK rejects
   `muteOutgoingAudio` on a virtual stream (`CANNOT_MUTE_VIRTUAL_AUDIO_STREAM`).
   We have only ever confirmed `sendRawAudioBuffer` ran, never that a Teams
   receiver heard it while join-muted.

   **Decision: `glassesRequiresUnmutedTransport = true`.** Glasses joins
   transport-unmuted; `userMuted` is enforced solely by the PCM gate. Phone
   joins with `transportMuted = userMuted`.

2. **What mute state does Teams display while the software gate is closed?**
   Unknown until a live receiver check. ACS has no API to publish mute state
   for a virtual stream. If Teams shows unmuted while we are gating PCM, that
   is a recorded UX limitation, not a leak: the encoder is not fed.

   Device gate must confirm a Teams participant hears silence when Mentra Call
   mute is on in glasses mode, regardless of the Teams mute icon.

## Phase 1 device gate

Unit tests (`:mentra-acs-meeting:testDebugUnitTest`, PolicyKit `swift test`,
engine `scripts/test.sh`, Mentra-Call `bun test backend miniapp`) are the
off-device gate. Live Teams cannot be run in CI. On a device with
`adb -s RZCW61KNR0X logcat -s ACS-SPIKE`:

- glasses, join and speak without ever touching mute — receiver hears the glasses
- glasses unmuted — `activeStream=virtual`, outgoing PCM sent, receiver hears glasses
- glasses muted — `glassesPcm=false`, no `sent` lines, receiver hears silence
- phone unmuted — `activeStream=local`, zero outgoing PCM sent, receiver hears handset
- phone muted — `activeStream=local`, `isOutgoingAudioMuted=true`, receiver hears silence
- mute/unmute cycled 5x in both modes — state matches, no repeated ACS mute spam
- `preferred_mic` changed mid-call — `activeStream` does not change
- injected mute failure in phone mode — escalation to `stopAudio`, `activeStream=none`, silence
- `audioSafety=safe` throughout; `unsafe` never appears in a normal call

`AudioRecord ... source=7` still appears at CONNECTED; that is ACS diagnostic
capture, not a leak. The assertion that matters is `activeStream`.

## Phase 2 device gate

In phone mode, capture the WHIP offer SDP from asg_client logs and confirm
**no** audio `m=` section. In glasses mode confirm the audio `m=` section is
present and audio still reaches Teams.

