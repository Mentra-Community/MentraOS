# @mentra/acs-meeting

Phone-native Azure Communication Services Teams client for MentraOS.

WHEP decode → ACS raw outgoing video/audio; ACS `RawIncomingAudioStream` PCM →
MentraOS `AudioPlaybackService` / `PcmStreamPlayer` (A2DP).

## Spike verification (P2–P6)

Filter device logs:

```
adb logcat -s ACS-SPIKE
```

| Phase | Log / artifact | Pass |
|---|---|---|
| P2 | `ACS call state=CONNECTING` then `IN_LOBBY`/`CONNECTED` | Guest in Teams roster |
| P3 | `P3 video 1280x720 fps=~15` for ≥60s | Frames continuous |
| P4 | `P4 pcm rate=…` and `P4 wrote …/acs-whep-p4.wav` (`dumpPcmWav: true`) | WAV intelligible |
| P5 | `P5 negotiated format` + Teams sees glasses / hears wearer | Second client confirms |
| P6 | Remote speech on glasses via `onIncomingPcm` → `PcmStreamPlayer` | No double-audio |

iOS is foreground-only in V1. Re-run P3–P6 on iOS; Android routing answers do not transfer.

Quarantined runbook: [spike/README.md](spike/README.md). P8 scratch: [example/background.ts](example/background.ts).

Incoming PCM delivery: **Expo event → `AudioPlaybackService` → `PcmStreamPlayer`**
(`setOwnAppAudioPlaying` for MCU duplex). SDK-playback is an optional experiment only.
