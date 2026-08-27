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
