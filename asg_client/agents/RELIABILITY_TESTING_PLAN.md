# MentraLive Reliability Testing Plan

## Known Breaking Points

| Feature          | Root Cause                                                                                         | Code Location                      |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Gallery sync     | FileManager null → empty status; BLE 19KB limit; query-response only (no push)                     | `GalleryCommandHandler`            |
| Photo capture    | Semaphore deadlock risk; AVIF fails silently → JPEG fallback; 200ms BLE race                       | `CameraNeo`, `MediaCaptureService` |
| Video corruption | No integrity checking (no CRC/checksum); segment valid only after `recorder.stop()`                | `CircularVideoBufferInternal`      |
| OTA updates      | Battery checks commented out; MTK install is async fire-and-forget; "FINISHED" sent before install | `OtaHelper`                        |
| Livestream       | 60s keep-alive timeout; keep-alive during init doesn't reset timer (bug); 10 reconnect max         | `RtmpStreamingService`             |
| SDK photos       | Auth token lost on BLE fallback; original file deleted before BLE can use it                       | `MentraLive.requestPhoto()`        |

---

## Phase 1: ADB Scripts (`asg_client/scripts/`)

| Script                 | What it tests                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --- |
| `test-photo.sh`        | Trigger photo via ADB, verify JPEG exists + valid header, 10x sequential, low-battery rejection | ✅  |
| `test-video.sh`        | Record 5s video, verify MP4 + moov atom, 5x corruption check                                    | ✅  |
| `test-gallery-sync.sh` | Count files before/after photo+video, verify increments                                         | ✅  |
| `test-wifi.sh`         | Send WiFi creds, verify connection, ping, disconnect                                            | ✅  |
| `test-ota.sh`          | Trigger version check → download → verify checksum (don't install)                              | ✅  |
| `test-low-battery.sh`  | Attempt all operations, report what battery level allows/blocks                                 | ✅  |
| `test-storage-full.sh` | Fill storage, verify graceful failure, cleanup, verify recovery                                 | ✅  |

## Phase 2: StressTestRunner (phone-side, Kotlin)

Create `mobile/modules/core/android/src/main/java/com/mentra/core/testing/StressTestRunner.kt`, expose via `CoreModule`. Filter results: `adb logcat -s STRESS_TEST`

| Test               | Actions                                            | Catches                                                       |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| Rapid mic toggle   | `setMicEnabled()` 50x, 200ms apart                 | Handler leaks in `micBeatHandler`                             |
| Audio permutations | 6 sequences of LC3 + music start/stop              | Race in `handlePhoneAudioStateChanged()` vs `setMicEnabled()` |
| SCO during LC3     | Start LC3 → enter SCO → exit SCO → verify recovery | Audio route conflicts                                         |
| BLE command burst  | 50 mixed commands, no delay                        | Queue overflow, `CommandProcessor` choking                    |
| Camera rapid fire  | 10 photos, no delay                                | Semaphore deadlock, cooldown not resetting                    |

## Phase 3: Endurance Tests (ADB scripts, run overnight)

| Script                        | Duration                            | What it catches                        |
| ----------------------------- | ----------------------------------- | -------------------------------------- |
| `test-endurance-photo.sh`     | 1 photo/min for 1hr                 | Memory leaks, file handle exhaustion   |
| `test-endurance-music.sh`     | A2DP for 1hr, monitor BLE every 30s | BLE disconnect during audio            |
| `test-endurance-mic.sh`       | LC3 mic for 1hr                     | Handler leak (micbeat should fire ~2x) |
| `test-endurance-sco-cycle.sh` | SCO on/off every 5min for 1hr       | Audio state recovery failures          |
| `test-memory-fill.sh`         | Photos until storage full           | Graceful failure + recovery            |

## Phase 4: Livestream Tests (later, needs RTMP test server)

| Script                     | What it tests                                             |
| -------------------------- | --------------------------------------------------------- |
| `test-stream.sh`           | Start stream, verify publishing, run 5min, clean shutdown |
| `test-stream-reconnect.sh` | Kill WiFi mid-stream, verify reconnection                 |
| `test-stream-cycle.sh`     | 5x start/stop, verify no resource leaks                   |

---

## Open Questions

- **Sentry access**: Where are dashboards? Need to correlate test failures with crash reports
- **FW crash logs**: How to save BES chip logs after crash? (Ask Liu)
- **FW test suite**: What does Liu's FW suite already cover?

## Implementation Order

1. Phase 1 ADB scripts (fastest, immediate value)
2. Phase 2 StressTestRunner (requires mobile build)
3. Phase 3 endurance (run overnight)
4. Phase 4 livestream (needs test server)
