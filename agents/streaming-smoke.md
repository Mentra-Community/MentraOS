# Streaming hardware smoke checklist

Use **one tester**, **real glasses**, and verify pass criteria per scenario. Covers RTMP/WHIP/SRT paths, SDK validation, capture-size / preflight plumbing, and restart behavior.

| # | Scenario | Steps / pass criteria |
|---|----------|------------------------|
| 1 | **RTMP default** (no `video` in payload) | Start managed or local RTMP with defaults. **Pass:** stream starts; logcat shows `capture=` matching a listed sensor mode; no upscale warning. |
| 2 | **RTMP 1920×1080** | Request 1920×1080 video config. **Pass:** stream starts; encoded output matches requested resolution. |
| 3 | **RTMP 854×480** | Request 854×480. **Pass:** stream starts; output matches. |
| 4 | **RTMP 1920×1080, sensor largest mode >4096 wide** | Device with a native mode wider than 4096. **Pass:** logcat shows raw `capture=` (e.g. `4608x2592`), **not** a 4096-truncated value (Codex P2 regression). |
| 5 | **RTMP 320×240** | Request minimum allowed size. **Pass:** stream starts. |
| 6 | **WHIP 1280×720** via `startLivestream` | Start managed WHIP at 1280×720. **Pass:** stream starts; playback OK. |
| 7 | **SRT direct 1920×1080** | Point glasses/app at local listener, e.g. `ffmpeg -i srt://0.0.0.0:4201?mode=listener …` → MP4. **Pass:** correct dimensions; no visible stretch. |
| 8 | **SDK `RangeError`** | `await session.camera.startStream({ video: { width: 2048 } })` (or other out-of-range field). **Pass:** throws `RangeError`; cloud logs show **no** `STREAM_REQUEST` / managed stream request for that invalid attempt. |
| 9 | **Resolution change after stop** | Stream → stop → stream again with a **different** resolution. **Pass:** no stale `captureWidth` / `captureHeight` bleeding from the prior session. |

## Notes

- Selector / preflight logic tied to `CameraCharacteristics` is intentionally covered here rather than in JVM unit tests (see stream PR test plan).
- Log excerpts and screenshots/recordings help when filing issues.
