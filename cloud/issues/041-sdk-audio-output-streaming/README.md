# SDK Audio Output Streaming

Enable SDK apps to stream real-time audio back to the mobile client/glasses for playback — unlocking conversational AI (Gemini Live, OpenAI Realtime), streaming TTS, and live audio processing.

## Documents

- **audio-streaming-spec.md** - Problem, goals, constraints, use cases
- **audio-streaming-architecture.md** - Implementation options, tradeoffs, recommended approach

## Quick Context

**Current**: SDK apps can only play audio via `playAudio(url)` (complete file URL) or `speak(text)` (server-side TTS). No way to stream real-time audio chunks back to the user.

**Proposed**: New SDK API to push audio chunks (MP3 frames) that play on the mobile client/glasses in real-time via an HTTP streaming relay on the cloud.

## Key Decisions

- **Option A selected**: HTTP streaming relay on cloud. Phone plays a chunked HTTP MP3 stream URL via the existing `playAudio()` path. No new native modules needed on mobile.
- **No WebSocket for audio output**: WS audio had too many issues historically — banned for this direction. Audio goes SDK → cloud relay (HTTP/WS push) → phone (HTTP GET stream).
- **SDK-side encoding**: Cloud does zero transcoding (just `pipe()` bytes). If the developer has raw PCM (e.g., Gemini Live), the SDK encodes to MP3 on the developer's server. Most providers (ElevenLabs, OpenAI, Cartesia, Azure) output MP3 natively — no encoding needed.
- **MP3 wire format**: Universal cross-platform support (ExoPlayer + AVPlayer), self-framing (no container needed), streaming-native. Opus ruled out due to iOS container incompatibility.
- **Auto-reconnect relay**: The cloud relay transparently handles phone disconnects during conversational gaps. Developer just writes chunks — never thinks about phone connectivity. See "Auto-Reconnect Design" below.

## Architecture

```
SDK developer writes audio:
  stream.write(chunk)  — gaps of any duration are fine

SDK → Cloud (always works — persistent app WS):
  [36-byte streamId] [N bytes MP3] as WS binary frame

Cloud relay → Phone (reconnectable):
  Phone GETs /api/audio/stream/:userId/:streamId
  ExoPlayer plays chunked HTTP audio/mpeg response
  If phone disconnects during gap → cloud buffers → re-sends AUDIO_PLAY_REQUEST → phone reconnects to same URL
```

### Auto-Reconnect Design

The developer's mental model is simple — create a stream, write whenever you have audio, call end() when done. The cloud handles everything else.

**Problem**: Between AI responses (5–15s conversational gaps), no MP3 bytes flow. ExoPlayer's buffer empties and it closes the HTTP connection. Previous audio chunks were silently dropped.

**Solution**: The cloud relay (`AppAudioStreamManager`) supports transparent reconnection:

```
SDK writes → Cloud relay → Phone HTTP (streaming)
                              ↓ phone disconnects (gap between AI responses)
                           Stream stays alive, buffers incoming audio
                              ↓ SDK writes new audio
                           Cloud sends AUDIO_PLAY_REQUEST to phone
                              ↓ phone reconnects (HTTP GET, same URL)
                           Flush buffer → resume piping
```

State machine:

| SDK writing? | Phone connected? | What happens |
|---|---|---|
| ✅ | ✅ | Pipe directly — normal streaming |
| ❌ | ✅ | Idle — connection stays open |
| ❌ | ❌ | Dormant — stream exists, waiting |
| ✅ | ❌ | **Buffer + reconnect** — cloud sends AUDIO_PLAY_REQUEST, phone GETs same URL, buffer flushed |

Key numbers:
- Phone reconnect latency: ~150–350ms (WS message + ExoPlayer HTTP GET)
- Buffer limit: 2MB (~125s of 128kbps MP3)
- Reconnect timeout: 10s (gives up if phone can't reconnect)
- Abandon timeout: 60s (safety net for crashed/forgotten streams)

### Key Code Paths

**SDK** (developer-facing API):
- `cloud/packages/sdk/src/app/session/modules/audio-output-stream.ts` — `AudioOutputStream` class (write/end/flush)
- `cloud/packages/sdk/src/app/session/modules/audio.ts` — `createOutputStream()` factory

**Cloud** (relay + reconnect logic):
- `cloud/packages/cloud/src/services/session/AppAudioStreamManager.ts` — per-user stream manager with buffering and auto-reconnect
- `cloud/packages/cloud/src/api/hono/routes/audio.routes.ts` — `GET /api/audio/stream/:userId/:streamId` HTTP relay endpoint
- `cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts` — handles `AUDIO_STREAM_START`, `AUDIO_STREAM_END`, binary frames
- `cloud/packages/cloud/src/services/websocket/bun-websocket.ts` — binary frame routing to `AppAudioStreamManager.writeToStream()`

**Test app** (Gemini Live + OpenAI Realtime):
- `cloud/packages/apps/sdk-test/src/backend/managers/realtime.manager.ts` — orchestrates provider + output stream
- `cloud/packages/apps/sdk-test/src/backend/managers/gemini-realtime.provider.ts` — Gemini Live API via `@google/genai`
- `cloud/packages/apps/sdk-test/src/backend/managers/openai-realtime.provider.ts` — OpenAI Realtime API via raw WS

## Progress

### Phase 1: POC ✅

- [x] Spec written
- [x] Architecture options documented, Option A selected
- [x] SDK `AudioOutputStream` — PCM→MP3 encoding (lamejs), binary WS framing, write/end/flush lifecycle
- [x] SDK `AudioManager.createOutputStream()` factory
- [x] Cloud `AppAudioStreamManager` — stream creation, claiming, writing, ending, destruction
- [x] Cloud HTTP relay endpoint (`GET /api/audio/stream/:userId/:streamId`)
- [x] Cloud WS binary frame routing (streamId + audio data)
- [x] Cloud message handlers for `AUDIO_STREAM_START` / `AUDIO_STREAM_END`
- [x] Test app: Gemini Live provider (model: `gemini-2.5-flash-native-audio-preview-12-2025`)
- [x] Test app: OpenAI Realtime provider (model: `gpt-realtime-1.5`)
- [x] Test app: RealtimeManager with provider-first connection ordering
- [x] First successful end-to-end audio: user speaks → Gemini → PCM → MP3 → relay → phone → heard response
- [x] Auto-reconnect design finalized (cloud buffers + re-sends AUDIO_PLAY_REQUEST)
- [x] Wire up `SendPlayRequestFn` injection — UserSession constructor passes a lambda that sends `AUDIO_PLAY_REQUEST` through the glasses WS
- [x] `claimStream()` multi-call support — closes old writer, creates fresh TransformStream, flushes pending buffer
- [x] `triggerReconnect()` — detects phone disconnect on failed write, buffers chunks, sends reconnect play request
- [x] Audio route returns `{ readable, contentType }` from `claimStream()` signature
- [x] Fix data loss bug: `createStream()` no longer creates a throwaway TransformStream — writer/readable start as null, early SDK writes buffer into `pendingChunks`, flushed on first `claimStream()` call
- [x] Test app: `OutputStreamManager` for shared stream ownership (realtime + tone generators)
- [x] Test app: Sine wave tone generator for latency measurement (`POST /tone/start`, `/tone/stop`)

### Phase 1: Validation (in progress)

- [ ] Test multi-turn conversation (speak → AI responds → speak again → AI responds again)
- [ ] Benchmark ExoPlayer first-byte latency on reconnect

### Phase 2: Production

- [ ] Handle stream interruption (user starts speaking mid-AI-response → flush + cancel)
- [ ] Backpressure: detect slow phone reader, drop frames gracefully
- [ ] Metrics: stream creation count, reconnect count, buffer high-water mark, first-byte latency

### Phase 3: Polish

- [ ] SDK docs and examples for `createOutputStream()`
- [ ] Support multiple simultaneous streams (currently 1 per user)
- [ ] Consider transcoding µservice for providers that only output raw PCM at unusual sample rates

## Known Issues

1. **Gemini model churn** — `gemini-2.5-flash-preview-native-audio-dialog` was deprecated mid-development. Updated to `gemini-2.5-flash-native-audio-preview-12-2025`. Google may rename again. The model name is a constant in `gemini-realtime.provider.ts`.

2. **Glasses WS disconnect cycle (042)** — Was disrupting realtime sessions. Root cause: feature branch was missing 034/035 WS liveness fixes. Resolved by merging dev. See [042-glasses-ws-disconnect-cycle](../042-glasses-ws-disconnect-cycle/).

3. **~~"Received audio play response for unknown request ID"~~** ✅ **Resolved.** The SDK's `AudioOutputStream.open()` sends `AUDIO_PLAY_REQUEST` with `requestId: stream_{streamId}`. This flows through `handleAudioPlayRequest` which stores the mapping in `audioPlayRequestMapping`. The cloud's reconnect path (`SendPlayRequestFn` in UserSession constructor) also stores the same mapping. Both paths are now consistent — the phone's response is routed back correctly.

## Related Issues

- [034-ws-liveness](../034-ws-liveness/) — App-level ping/pong for glasses WS stability
- [035-nginx-ws-timeout](../035-nginx-ws-timeout/) — Extended nginx timeouts for WS paths
- [042-glasses-ws-disconnect-cycle](../042-glasses-ws-disconnect-cycle/) — Discovered during this work