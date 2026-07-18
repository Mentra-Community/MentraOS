# `speaker.createStream()` — live PCM output

Implementation and release contract for cross-platform live speaker audio in
the Mentra Miniapp SDK.

## Contract

`session.speaker.createStream()` opens a bounded native playback stream from a
miniapp background. It accepts signed 16-bit little-endian mono PCM at 16, 24,
or 48 kHz and routes it through the phone's media output (normally A2DP to the
connected glasses).

```ts
const writer = await session.speaker.createStream({
  sampleRate: 16_000,
  channels: 1,
  volume: 1,
  stopOtherAudio: true,
})

await writer.write(pcmBytes)
await writer.close() // drains queued audio
// or: await writer.abort() // drops queued audio immediately
```

Writes are serialized even when callers overlap them. The SDK splits large
chunks into bridge-safe requests, and each write resolves with `bufferedMs`.
Native playback applies backpressure above two seconds and rejects a producer
that accumulates more than ten seconds. Invalid sample rates, channel counts,
volume, base64, sample alignment, and oversized requests fail before playback.

## Runtime path

```text
miniapp background
  -> SPEAKER_STREAM_OPEN / WRITE / CLOSE / ABORT
  -> LocalMiniappRuntime
  -> AudioPlaybackService
  -> Android AudioTrack or iOS AVAudioEngine
  -> phone media route -> glasses speakers
```

The background JSContext owns the producer so playback survives WebView close
and phone screen lock. `AudioPlaybackService` owns audio focus, A2DP volume
handling, interaction with `play()` / `speak()`, and teardown when a miniapp
stops or disconnects.

## Platform implementations

- Android: `PcmStreamPlayer.kt` uses `AudioTrack` in `MODE_STREAM` with a
  dedicated feeder thread, bounded queue, drain-on-close, and immediate abort.
- iOS: `PcmStreamPlayer.swift` uses `AVAudioEngine` and
  `AVAudioPlayerNode`, converts PCM16-LE to float buffers, and recovers from
  route changes and audio interruptions. A media-services reset fails the
  stream so the producer can reopen it cleanly.
- The native module aborts every remaining stream on destruction on both
  platforms.

## Compatibility

Miniapps that require live PCM must declare `minHostVersion: "2.13.0"` or
newer. Earlier Mentra App builds do not implement the four native stream
requests. Speaker-capable hardware should also be a required hardware
capability when live output is core functionality.

## Automated validation

- Miniapp protocol and writer tests cover wire values, chunking, overlapping
  write ordering, input validation, close, and abort.
- Runtime tests cover native adapter routing, stop-for-app cleanup, and active
  playback accounting.
- Android compiles through `./scripts/check-android-compile.sh bluetooth-sdk`.
- iOS compiles the Mentra Bluetooth SDK in an Xcode simulator build.

## Hardware acceptance before release

1. Stream a generated 16 kHz tone for 30 minutes on both Android and iOS;
   confirm bounded memory and no gaps at chunk boundaries.
2. Confirm playback continues with the WebView closed and the phone locked.
3. Stall and resume the producer, then overrun it; confirm clean silence,
   recovery, and bounded backpressure.
4. Abort and drain-close mid-stream; confirm instant abort and an unclipped
   final drain.
5. Disconnect/reconnect A2DP and trigger an incoming-call interruption;
   confirm playback resumes or fails clearly so the producer can reopen.
6. Start `speak()` / `play()` during a live stream and exercise both values of
   `stopOtherAudio`.
7. Stop the miniapp and kill/relaunch the Mentra App; confirm no zombie native
   player remains.
8. Run the Mentra Call Recall mixed-audio loop on Meet, Teams, and Zoom and
   check end-to-end latency, echo, mute, and Wi-Fi recovery.

Native simulator/compile checks prove API shape and lifecycle safety, but the
two-platform hardware pass remains the release acceptance gate for audio
quality and routing.
