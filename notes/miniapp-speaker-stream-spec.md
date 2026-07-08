# speaker.createStream() — live PCM audio to glasses from a miniapp

Investigation doc. What exists, what to build, what to touch, and how to test.
No code yet.

## Goal

Let a miniapp background push live audio chunks (raw PCM) to the glasses
speakers with low latency. Today `session.speaker` only has `play(url)` and
`speak(text)` — a clip must be a file or URL before it can play. That blocks
live audio (e.g. Mentra Call meeting audio).

## Why the background runtime is the right place

- The background JSContext keeps running when the phone is pocketed / screen off.
  The UI webview does not.
- The background already has `WebSocket` and `fetch`
  (`mobile/modules/jspolyfill/src/startup.ts` — WS impl at ~line 815, backed by
  OkHttp/URLSession). So it can receive live chunks from a server.
- What it cannot do is play them. It is a headless JS engine — no AudioContext.
  The only audio door is `session.speaker`, which has no chunk input.
- Native background audio already works: TTS (`speak`) plays through
  `AudioPlaybackService` while the app is backgrounded.

So the whole pipeline exists except one link: a chunk sink on the speaker.

## Final architecture

```
server (live audio source, e.g. Recall WS)
   │ wss
   ▼
miniapp BACKGROUND JSContext            (survives screen-off)
   │ session.speaker.createStream()
   │ stream.write(pcmChunk)             base64 over the JS bridge, auto-chunked
   ▼
LocalMiniappRuntime                     (phone, island module)
   │ SPEAKER_STREAM_OPEN / WRITE / CLOSE / ABORT handlers
   │ getRuntimeHooks().audioPlayback.openStream/writeChunk/closeStream
   ▼
AudioPlaybackService (mobile/src)       audio focus, A2DP routing, volume floor
   │
   ▼
native PCM player                       Android: AudioTrack (MODE_STREAM)
                                        iOS: AVAudioEngine + AVAudioPlayerNode
   │
   ▼
phone media route → A2DP → glasses speakers
```

Throughput check: 16 kHz mono 16-bit PCM = 32 KB/s raw, ~43 KB/s base64.
The mic already streams chunks at this rate in the opposite direction
(glasses → background), so the bridge can carry it.

## What already exists (reuse, don't rebuild)

| Piece | Where | State |
|---|---|---|
| Chunked-write SDK pattern | `mobile/modules/miniapp/src/modules/blob.ts` (`BlobWriter`) | copy its shape: open → write(auto-chunk) → close/abort |
| Request dispatch on phone | `mobile/modules/island/src/services/LocalMiniappRuntime.ts` (PLAY_AUDIO at ~line 942, blob handlers) | add 4 cases next to them |
| Hook interface | `mobile/modules/island/src/runtime/config.ts:480` (`AudioPlaybackAdapter`) | extend with stream methods |
| Hook implementation | `mobile/src/services/MantleManager.ts:271` | wire new methods to AudioPlaybackService |
| Audio focus / A2DP / volume logic | `mobile/src/services/AudioPlaybackService.ts` | reuse; add a stream mode beside the URL mode |
| **Android PCM player** | `mobile/modules/bluetooth-sdk/android/.../utils/audio/PCMAudioPlayer.java` | **already written** (AudioTrack, configurable rate/channels/format) but currently unused — adapt or copy it |
| Speaker state machine | `speaker.ts` (`idle/loading/playing/stopped/error`) + `setSpeakerState` in LocalMiniappRuntime | streams emit the same states |
| WS in background | `mobile/modules/jspolyfill/src/startup.ts` | done, nothing to do |

iOS has no ready PCM player. `AVAudioEngine` usage exists in
`bluetooth-sdk/ios` (DeviceManager, MentraLive) as reference, but the chunk
player itself must be written.

## Files to touch

### 1. SDK — `mobile/modules/miniapp/` (small)
- `src/protocol.ts` — add `SPEAKER_STREAM_OPEN`, `SPEAKER_STREAM_WRITE`,
  `SPEAKER_STREAM_CLOSE`, `SPEAKER_STREAM_ABORT` to `MiniappRequestType`.
- `src/modules/speaker.ts` — add `createStream(options)` returning a
  `SpeakerStreamWriter` (`write`, `close`, `abort`), modeled on `BlobWriter`.
  Options: `sampleRate` (16000/24000/48000), `channels` (1), `volume`,
  `stopOtherAudio`. `write()` resolves with `{bufferedMs}` for backpressure.
- `src/index.ts` — export new types.
- `src/modules/speaker.test.ts` — unit tests.

### 2. Phone runtime — `mobile/modules/island/` (small)
- `src/runtime/config.ts` — extend `AudioPlaybackAdapter`:
  `openStream(req)`, `writeStreamChunk(id, base64) → {bufferedMs}`,
  `closeStream(id)`, `abortStream(id)`.
- `src/services/LocalMiniappRuntime.ts` — 4 new cases in the request switch;
  one active stream per miniapp (opening a second closes the first);
  abort stream on miniapp stop/disconnect (same cleanup path as
  `stopForApp`); drive `setSpeakerState`.

### 3. Phone app — `mobile/src/` (medium)
- `src/services/MantleManager.ts` — pass the new adapter methods through.
- `src/services/AudioPlaybackService.ts` — stream mode: owns audio focus,
  volume floor, LC3-mic-suspend, `stopOtherAudio` interaction with URL/TTS
  playback; delegates bytes to the native player.

### 4. Native player (the real work)
- **Android**: adapt `PCMAudioPlayer.java` (bluetooth-sdk) or copy it into an
  expo-module the app can call (crust has native code; bluetooth-sdk is
  already an expo module — decide which owns it). Needs: streaming write,
  buffered-ms report, underrun handling (play silence vs pause), clean release.
- **iOS**: new `AVAudioEngine` + `AVAudioPlayerNode` chunk player,
  same interface. Audio session category must match existing playback
  (see AudioPlaybackService session handling).

### 5. Docs/versioning
- Bump miniapp SDK version; miniapps using `createStream` need a
  `minHostVersion` gate in `miniapp.json` (old hosts reject unknown request
  types with `unknown method` — SDK should surface a clear
  `NOT_SUPPORTED` error).
- `mintlify-docs/` page for the new API.

## Design decisions (locked unless argued)

| Question | Decision | Why |
|---|---|---|
| Format v1 | raw PCM 16-bit LE mono | no codec work; server decodes MP3/Opus before relaying |
| Sample rates | 16000 / 24000 / 48000 | covers speech + TTS + music |
| Concurrent streams | 1 per miniapp | matches "one active playback" model; second open closes first |
| Backpressure | `write()` returns `{bufferedMs}`; SDK throttles when > ~2 s | bridge is fast enough but the producer (WS) can outrun playback |
| Underrun | keep track playing, insert silence, emit a state event | pausing/restarting AudioTrack causes pops |
| Mixing with play()/speak() | `stopOtherAudio: true` default, same as today | consistent |
| Platform order | Android first | test rig (Samsung + Mentra Live) is Android |

## Is this production ready?

The design is production-shaped, but call it **beta until these are closed**:

1. **iOS parity** — Android ships first; iOS is a separate native effort.
   Until then the API is Android-only, which is fine for local dev but not
   for a store release.
2. **Underrun/jitter handling** — live WS audio has jitter. Needs a small
   jitter buffer (200–500 ms) in the native player and a tested underrun
   strategy. This is the most likely source of "sounds bad" bugs.
3. **Lifecycle hardening** — stream must die cleanly on: miniapp stop, bridge
   crash, BLE/A2DP disconnect, phone call interruption (audio focus loss),
   app kill. Any leak = stuck AudioTrack = battery drain.
4. **Battery** — a persistent WS + continuous AudioTrack while pocketed is a
   real drain. Measure. Likely fine for calls (bounded sessions), wrong for
   hours of background audio.
5. **A2DP behavior** — verify chunk audio actually routes to glasses and the
   existing volume-floor bump applies. A2DP adds its own ~150–300 ms latency;
   fine for meetings, but measure the end-to-end number.
6. **No permission gate today** — `play()` has no manifest permission. Decide
   whether streaming audio needs one (probably not for v1, but note it).
7. **Echo (Mentra Call specific)** — glasses speaker → glasses mic feedback.
   Turn on `startStream({audio: {echoCancellation: true}})` on the WHIP
   uplink and test with a real meeting early.

Nothing here is exotic; it's the normal hardening list for a native audio
path. Estimate: ~1 day SDK+runtime, 2–3 days Android native + E2E, iOS later.

## Test cases

### Unit (SDK, `speaker.test.ts` — mock transport)
1. `createStream()` sends `SPEAKER_STREAM_OPEN` with options.
2. `write(Uint8Array)` base64-encodes and auto-splits large buffers into
   bridge-safe chunks (reuse blob chunk-size constants).
3. `write()` after `close()`/`abort()` throws.
4. `close()` sends CLOSE and resolves on host result; `abort()` is idempotent.
5. Backpressure: `write()` surfaces `bufferedMs` from host reply.
6. Old-host behavior: OPEN rejected → clear `NOT_SUPPORTED` error code.

### Runtime (island, LocalMiniappRuntime tests)
7. OPEN → adapter.openStream called; state goes `loading` → `playing`.
8. Second OPEN from same miniapp closes the first stream.
9. WRITE for unknown/closed stream id → error result, no crash.
10. Miniapp stop/disconnect aborts the active stream (no orphan).
11. CLOSE drains then emits `stopped` with durationMs.
12. Two different miniapps: `stopOtherAudio` semantics respected.

### Device E2E (Samsung + Mentra Live, example-miniapp tester page)
13. Sine-wave generator in background → `createStream` → tone on glasses,
    continuous, no seams (this replaces the blob/file:// workaround test).
14. Screen off / app backgrounded mid-stream → audio keeps playing.
15. WS relay test: server sends 16 kHz PCM over WS → background pumps to
    stream → measure end-to-end latency (target < 500 ms phone-side;
    + A2DP on top).
16. Producer faster than realtime → bufferedMs grows → SDK throttle holds
    buffer ~2 s, no memory growth.
17. Producer stalls (kill WS 5 s, resume) → underrun handled (silence),
    playback resumes without restart.
18. `stop()` / `abort()` mid-stream → instant silence, state `stopped`.
19. Interruptions: incoming phone call, then return → stream state sane.
20. BLE/A2DP drop mid-stream (walk away / power off glasses) → clean error,
    no stuck AudioTrack; audio falls back to phone speaker per OS routing.
21. `speak()` and `play(url)` fired during an active stream →
    `stopOtherAudio` behavior correct both ways.
22. Long soak: 30-min stream, watch memory, battery, thermal.
23. Kill the app mid-stream → no zombie audio, no crash on relaunch.

### Mentra Call integration (after the API ships)
24. Recall `audio_mixed_raw` WS → backend relay → background → glasses:
    full-loop conversation test with a real Zoom/Meet call.
25. Echo test: participant speaks, verify no feedback of their own voice
    (WHIP `echoCancellation: true`).
26. Mute/unmute + mid-call pocket test.
