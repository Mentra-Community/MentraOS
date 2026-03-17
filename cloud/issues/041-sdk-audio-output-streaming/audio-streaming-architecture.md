# Audio Output Streaming — Architecture

## Decision

**SDK-side encoding. Cloud is a dumb pipe (zero transcoding). Future microservice for cloud-side encoding if needed.**

```
SDK App (developer's server)          Cloud Relay                    Phone
   |                                    |                              |
   | AI gives PCM/Opus                  |                              |
   | SDK encodes → MP3 locally          |                              |
   | pushes MP3 frames ──────────────>  | pipes bytes straight through |
   |                                    | (zero CPU, just pipe()) ──>  | ExoPlayer/AVPlayer plays
```

Rationale: We don't want transcoding on the cloud — it could freeze the server under load. MP3 encoding runs on the developer's server (their CPU). The cloud relay is just a buffer + pipe. If we later need cloud-side transcoding (for developers who can't encode), we add a separate microservice that scales independently.

## Current System

Audio output from SDK apps follows a one-shot URL-based pattern:

```
SDK App → (WS) → Cloud → (WS) → Phone → (HTTP) → CDN/Origin → Phone → (BLE) → Glasses
```

1. SDK calls `session.audio.playAudio({audioUrl: "https://example.com/audio.mp3"})`
2. Cloud relays `audio_play_request` message to phone via WebSocket (JSON, ~200 bytes)
3. Phone's `AudioPlaybackService` calls `player.replace({uri: audioUrl})` via expo-audio
4. ExoPlayer (Android) / AVPlayer (iOS) fetches the URL, decodes, and plays
5. Audio is routed to glasses speaker via BLE

Key code:
- `packages/sdk/src/app/session/modules/audio.ts` → `playAudio()` sends `AUDIO_PLAY_REQUEST`
- `packages/cloud/src/services/session/handlers/app-message-handler.ts` → `handleAudioPlayRequest()` relays to phone
- `mobile/src/services/AudioPlaybackService.ts` → `play()` → `player.replace({uri})` (L109)
- `mobile/src/services/SocketComms.ts` → `handle_audio_play_request()` bridges WS message to AudioPlaybackService

### What works well

- Simple. Developer provides a URL, everything else is handled.
- ExoPlayer/AVPlayer are battle-tested audio players with buffering, codec support, error recovery.
- The response/callback path (`AUDIO_PLAY_RESPONSE`) already reports success/error/duration back to the SDK app.

### What doesn't work

- No streaming. Must have a complete, downloadable file at a URL before playback starts.
- For conversational AI, the AI generates audio in 20-100ms chunks. Can't wait for the full response.
- `speak(text)` hits a TTS endpoint that generates the whole file server-side before returning the URL.

## Implementation Options

Three fundamentally different approaches. Each has sub-variants.

---

### Option A: HTTP Streaming Relay (cloud-hosted)

Cloud hosts a relay endpoint. SDK pushes audio chunks in, phone pulls a streaming HTTP response out. From the phone's perspective, it's just playing a URL — but the URL is a chunked HTTP response that streams in real-time.

```
SDK App --POST chunks--> Cloud relay --chunked HTTP GET--> Phone (ExoPlayer/AVPlayer)
                         /audio-relay/{streamId}
```

#### How it works

1. SDK calls `session.audio.createOutputStream({sampleRate: 24000})`
2. SDK sends `AUDIO_STREAM_START` message to cloud via WebSocket
3. Cloud creates a relay endpoint: `https://api.mentra.glass/audio-relay/{streamId}`
4. Cloud sends `audio_play_request` to phone with that URL (existing mechanism)
5. Phone's ExoPlayer/AVPlayer opens the URL — cloud holds the response open
6. SDK pushes PCM chunks to cloud (via WS binary frames or HTTP POST)
7. Cloud transcodes PCM → streamable format (MP3 frames or Opus) and writes to the HTTP response
8. Phone plays audio as it arrives (progressive download / streaming)
9. SDK calls `stream.end()` → cloud closes the HTTP response → playback finishes naturally

#### Format: Why MP3

Opus is a better codec, but it has a **container problem on iOS**:

| Container | Android (ExoPlayer) | iOS (AVPlayer) | HTTP streaming? |
|---|---|---|---|
| OGG/Opus | ✅ | ❌ Not supported | ✅ |
| WebM/Opus | ✅ | ❌ Not supported | ✅ |
| CAF/Opus | ❌ | ✅ iOS 11+ | Awkward |
| MP4/Opus | ✅ ExoPlayer 2.14+ | ⚠️ iOS 17+ only | Needs fMP4 |

No single Opus container works on both platforms. We'd need per-platform container wrapping, which is complexity for zero benefit.

MP3 frames are self-describing — no container needed. You concatenate frames and any player on any platform plays them. This is how internet radio has worked since 1998.

| Format | Android | iOS | Container needed? | HTTP streaming? |
|---|---|---|---|---|
| **MP3 frames** | ✅ | ✅ | No — frames are self-contained | ✅ Battle-tested |
| **AAC-ADTS** | ✅ | ✅ | Minimal ADTS header per frame | ✅ |
| **Opus** | ⚠️ Needs OGG/WebM | ⚠️ Needs CAF/MP4 | Yes — platform-specific | Complicated |
| **Raw PCM/WAV** | ✅ | ✅ | WAV header, but no framing | Poor (buffer issues) |

**Decision: MP3 is the wire format.** Universally supported, zero container overhead, streaming-native.

#### Encoding: SDK-side, not cloud-side

The SDK app runs on the developer's server. MP3 encoding runs there — their CPU, not ours.

Why not cloud-side:
- Cloud transcoding at ~4% CPU per core per stream is fine at small scale
- But at 50+ concurrent streams it competes with WebSocket handling, transcription relay, session management
- If the transcoder has a bug or pegs CPU, the entire cloud goes down
- We don't want that failure mode

Why SDK-side works:
- Developer servers are typically under-utilized (handling webhooks, not streaming)
- MP3 encoding at 24kHz mono is trivial — lamejs does it in 2-5ms per frame in pure JS
- The SDK ships a helper so developers don't need to figure out MP3 encoding themselves
- If a developer's server is slow, only their app is affected, not our cloud

```
// SDK helper encodes PCM → MP3 internally
const stream = await session.audio.createOutputStream({
  sampleRate: 24000,  // PCM input sample rate
  encoding: 'pcm16',  // SDK encodes to MP3 before sending
})
stream.write(pcmBuffer)  // PCM goes in, MP3 comes out over the wire

// Developer already has MP3 (ElevenLabs, Cartesia, Azure)
const stream = await session.audio.createOutputStream({
  format: 'mp3',  // pass-through, no encoding
})
stream.write(mp3Bytes)  // MP3 goes straight to cloud relay
```

Most real-world use cases won't need encoding at all:

| Provider | Can output MP3 directly? |
|---|---|
| ElevenLabs | ✅ `output_format: "mp3_44100_128"` |
| Cartesia | ✅ MP3 output option |
| Azure Speech | ✅ `Audio48Khz96KBitRateMonoMp3` etc. |
| OpenAI TTS | ✅ MP3 is default format |
| Gemini Live | ❌ PCM or Opus only — needs SDK-side encoding |

Gemini Live is the main case that needs the SDK encoder helper.

#### Cloud relay implementation

The relay is a dumb pipe — no transcoding, no format awareness. It receives bytes and forwards them.

```
Cloud relay internals:

  Map<streamId, {
    buffer: Async queue of byte chunks (already-encoded MP3)
    httpResponse: HTTP Response object (held open, chunked transfer encoding)
    metadata: {contentType, createdAt, sessionId}
    lastActivity: timestamp (for inactivity timeout)
  }>

  SDK pushes chunks via existing WebSocket (binary frames tagged with streamId)
    → append to buffer
    → if httpResponse is connected, flush buffer to response

  GET /audio-relay/{streamId}        ← Phone connects here
    → set Content-Type: audio/mpeg  (or whatever SDK declared)
    → set Transfer-Encoding: chunked
    → pipe buffer to response as data arrives
    → close response when stream ends or inactivity timeout (10s)
```

Cloud CPU per stream: **~0%** (just copying bytes between a WebSocket and an HTTP response).

Memory budget: At 128kbps MP3, a 5-second jitter buffer = ~80KB per stream. 100 concurrent streams = 8MB. Negligible.

#### Latency breakdown

| Hop | Latency |
|---|---|
| AI generates audio chunk | 20-100ms (depends on provider) |
| SDK encodes PCM → MP3 (one frame, if needed) | ~2-5ms (lamejs) or 0ms (if MP3 from provider) |
| SDK → Cloud (HTTP POST or WS binary) | ~5-50ms |
| Cloud pipes to HTTP response | ~0ms (just write()) |
| Cloud → Phone (HTTP chunk) | ~5-50ms |
| ExoPlayer buffer before play | ~100-500ms (configurable, default can be high) |
| Phone → Glasses (BLE) | ~20-50ms |
| **Total first-byte** | **~130-650ms** |

The ExoPlayer buffer is the wildcard. Default `DefaultLoadControl` buffers 2.5s before starting. This can be tuned down to ~100ms with custom `LoadControl` — but requires a mobile code change.

---

### Option B: Chunked Playback (segmented files)

Instead of a continuous stream, break the audio into small segments (200-500ms each) and play them back-to-back using the existing `playAudio(url)` system. Each segment is a complete, downloadable file.

```
SDK App --chunk 1--> Cloud --save as file--> CDN/memory
        --chunk 2-->                     --> CDN/memory
        --chunk 3-->                     --> CDN/memory

Phone: playAudio(chunk1.mp3) → playAudio(chunk2.mp3) → playAudio(chunk3.mp3)
```

#### How it works

1. SDK accumulates PCM data until it has enough for one segment (200-500ms)
2. SDK (or cloud) encodes the segment to a complete MP3 file
3. Cloud stores it at a URL (in-memory, S3, or local file)
4. Cloud sends `audio_play_request` to phone with the segment URL
5. Phone plays segment. When done (`AUDIO_PLAY_RESPONSE`), next segment starts.
6. Repeat until stream ends.

#### Gapless playback sub-variant

Instead of waiting for each segment to finish, queue them:
- Phone receives segment URLs in advance and queues them
- ExoPlayer has playlist/queue support via `ConcatenatingMediaSource`
- Would need a new message type: `AUDIO_QUEUE_REQUEST` (add to playlist) vs `AUDIO_PLAY_REQUEST` (play immediately)

#### Latency analysis

| Parameter | Value |
|---|---|
| Segment duration | 200ms (minimum useful), 500ms (comfortable) |
| Encode time | ~5ms per segment |
| Upload/store time | ~10-50ms |
| Phone download time | ~10-50ms |
| **First-byte latency** | **~230-600ms** (for 200ms segments) |
| **Gap between segments** | **~20-80ms** (download + decode next segment) |

Gaps between segments are the main problem. Even with gapless playback via ExoPlayer playlists, there's usually a small gap at segment boundaries. For music or TTS this might be acceptable. For real-time conversation it's noticeable.

- **Pros**: Zero mobile changes — uses existing `playAudio(url)` exactly as-is. No new endpoints, no streaming HTTP, no custom players. Simple to implement and debug.
- **Cons**: Gaps between segments. Higher first-byte latency (must accumulate a full segment before first playback). More HTTP requests (one per segment). Storage/cleanup of segment files. Not truly real-time — it's "near real-time" with 200-500ms granularity.

---

### Option C: WebSocket Binary Frames to Phone ❌ RULED OUT

~~Add a new binary audio output path on the phone ↔ cloud WebSocket.~~

**Banned.** WS audio streaming to the phone had too many reliability issues historically. The phone ↔ cloud WebSocket carries JSON only. This option is documented for completeness but is not a viable path.

Would have been the lowest latency (~50-210ms first-byte) but requires a new React Native native module for streaming PCM playback on both platforms, plus binary frame handling on the phone WebSocket — all of which we've decided against.

---

## Comparison Matrix

| | Option A: HTTP Relay ✅ | Option B: Chunked Files (fallback) | Option C: WS Binary ❌ |
|---|---|---|---|
| **First-byte latency** | 130-650ms | 230-600ms | 50-210ms |
| **Gaps/stuttering** | Smooth (continuous stream) | Gaps at segment boundaries | Smooth (continuous) |
| **Mobile changes** | Maybe tune ExoPlayer buffer | None | New native module (both platforms) |
| **Cloud changes** | New relay endpoint (dumb pipe) | Segment storage endpoint | Binary frame relay |
| **SDK changes** | New output stream API | New segment accumulator | New output stream API |
| **Bandwidth** | Low (MP3 compressed) | Low (MP3 compressed) | High (raw PCM, ~384kbps) |
| **Complexity** | Medium | Low | High |
| **Interruption** | Close HTTP response | Stop playing, discard queue | Stop writing to AudioTrack |
| **WS audio to phone** | No (HTTP only) | No | Yes — **banned** |
| **Concurrent with playAudio()** | Yes (different URL) | Yes (same system) | Needs track management |
| **Status** | **Selected** | Fallback if A fails | Ruled out |

## Recommendation

**Option A with SDK-side encoding. Cloud is a zero-CPU dumb pipe. Option C ruled out (WS audio to phone banned).**

Rationale:

1. **Cloud safety.** No transcoding on the cloud means no CPU risk, no freezing, no failure mode that takes down the whole system. The relay is just `pipe()`.

2. **Minimal mobile changes.** ExoPlayer and AVPlayer already support MP3 streaming over HTTP. The only mobile change is likely tuning the buffer config to reduce initial buffering latency from ~2.5s default down to ~200ms. That's a one-line config change, not a new native module.

3. **Uses existing playback path.** From the phone's perspective, `playAudio(streamUrl)` looks identical to `playAudio(fileUrl)`. The `AudioPlaybackService` doesn't need to know or care that the URL is a stream.

4. **Most developers won't encode at all.** ElevenLabs, Cartesia, Azure, OpenAI all output MP3 natively. The SDK just passes MP3 bytes through. Only Gemini Live (PCM output) needs the SDK-side encoder helper.

5. **No WS audio to phone.** WS audio streaming had too many reliability issues historically. Option C is ruled out. If Option A's HTTP latency isn't good enough, Option B (chunked files) is the fallback — not WS.

6. **Option B is a fallback** if A turns out to be harder than expected. Chunked playback is dead simple but the gaps may be unacceptable for voice.

### Future: transcoding microservice

If we later want to support cloud-side encoding (so developers can send raw PCM without encoding):

```
SDK App ── PCM ──> Transcoding µservice ── MP3 ──> Cloud relay ──> Phone
                   (separate container/process)
                   (auto-scales independently of main cloud)
                   (if it crashes, main cloud is unaffected)
                   (only exists for devs who need it)
```

This would be a small stateless service: receives PCM via HTTP/WS, encodes with ffmpeg/lame, outputs MP3 frames. Horizontally scalable. But this is NOT needed for v1 — only build it if demand exists.

### Phased approach

**Phase 1: Prove it works (1-2 days)**
- Cloud: bare-minimum relay endpoint (receive MP3 bytes, serve HTTP stream)
- SDK: `createOutputStream()` → `write()` → `end()` with MP3 pass-through
- Mobile: test that `playAudio(streamUrl)` works with a chunked HTTP MP3 response
- Benchmark first-byte latency and find ExoPlayer's minimum viable buffer config

**Phase 2: Production implementation (3-5 days)**
- Cloud: proper relay with per-session stream management, cleanup, backpressure
- SDK: full `AudioOutputStream` class with MP3 pass-through + PCM encoder helper
- SDK: ship `lamejs` or similar as optional dep for PCM→MP3 encoding
- Mobile: ExoPlayer buffer tuning, handle stream interruption gracefully
- Message types: `AUDIO_STREAM_START`, `AUDIO_STREAM_STOP`, or reuse existing `AUDIO_PLAY_REQUEST` with stream URL

**Phase 3: Polish (2-3 days)**
- Backpressure (what happens when SDK pushes faster than phone plays)
- Concurrent streams (track IDs)
- Interruption (user starts talking → flush → silence immediately)
- Metrics (latency, buffer underruns, stream duration)

**If Phase 1 shows >700ms first-byte latency that can't be tuned down:**
- Fall back to Option B (chunked file segments) for a quick win
- Option C (WS binary to phone) is not on the table — WS audio to phone is banned

## Open Questions

1. **ExoPlayer minimum buffer config?**
   - Default `DefaultLoadControl`: minBufferMs=2500. Can we set it to 100ms for streaming sources without breaking file playback?
   - Need to test: does ExoPlayer start playback after receiving the first complete MP3 frame (~48ms of audio), or does it wait for a minimum buffer regardless?
   - **Need to benchmark on a real device.**

2. **AVPlayer (iOS) behavior with chunked HTTP MP3?**
   - AVPlayer is known to buffer more aggressively than ExoPlayer
   - May need `AVPlayerItem.preferredForwardBufferDuration` tuning
   - **Need to benchmark on a real device.**

3. **SDK-side MP3 encoder choice?**
   - `lamejs` (pure JS): ~2-5ms per frame at 24kHz mono. Zero native deps. ~50KB package size. Fine for real-time.
   - `@ffmpeg/ffmpeg` (WASM): more capable but adds ~10MB. Overkill for MP3 encoding.
   - Native `lame` bindings: fastest but requires native compilation on developer's machine.
   - **Leaning**: Ship `lamejs` as the built-in helper. It's pure JS, works everywhere Bun/Node runs, fast enough for real-time mono audio. Make it an optional dependency so developers who send MP3 directly don't pay the cost.

4. **How does the SDK push MP3 chunks to the cloud relay?**
   - **Option 4a**: Send MP3 as WS binary frames on the existing app↔cloud WebSocket (tag with streamId header). Cloud demuxes and routes to the relay. Note: WS binary is fine for SDK→cloud — the ban is only on WS audio to the phone.
   - **Option 4b**: SDK opens a separate HTTP POST with chunked transfer encoding to the relay endpoint. Keeps audio traffic off the main WebSocket.
   - **Leaning**: 4a (WS binary on existing connection) is simpler and avoids authentication complexity for a new HTTP endpoint. Audio input already uses WS binary frames in the other direction — symmetric.

5. **Stream lifecycle if SDK crashes mid-stream?**
   - Cloud needs a timeout: if no chunks arrive for N seconds, close the HTTP response and clean up.
   - Phone handles this naturally — ExoPlayer finishes playing buffered data, then reports completion.
   - **Decision**: 10-second inactivity timeout on the relay. Configurable.

6. **Max concurrent streams per session?**
   - One active output stream per track ID? Or allow multiple?
   - **Start with**: one stream at a time. Starting a new stream auto-ends the previous one (same as `playAudio` with `stopOtherAudio: true`).

7. **When to build the transcoding microservice?**
   - Not needed for v1. Only build it if:
     - Multiple developers request cloud-side PCM encoding
     - Gemini Live becomes a primary use case and devs don't want to run lamejs
   - Architecture: stateless HTTP service, receives PCM, outputs MP3 frames, horizontally scalable
   - Runs in a separate container so it can't affect the main cloud