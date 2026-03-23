# Audio Output Streaming — Spec

## Overview

SDK apps need to stream real-time audio back to the mobile client and glasses for playback. Currently, the only way to play audio is `playAudio(url)` (send a complete file URL) or `speak(text)` (server-side TTS that generates a file URL). There is no way to push a continuous stream of audio chunks — which is required for conversational AI (Gemini Live, OpenAI Realtime), streaming TTS (ElevenLabs, Cartesia), and live audio processing pipelines.

## Problem

1. **Conversational AI requires streaming audio output.** Gemini Live, OpenAI Realtime API, and similar systems produce audio token-by-token (PCM chunks every 20-100ms). Waiting for the full response to finish before playing introduces seconds of latency — breaking the conversational feel.

2. **The audio path is asymmetric.** Input streaming works: glasses mic → cloud → SDK app sends PCM chunks over WebSocket binary frames in real-time. But the reverse path (SDK app → glasses speaker) is one-shot only: send a URL, phone downloads the whole file, then plays it.

3. **Current `playAudio(url)` requires a complete file.** The mobile client calls `AudioPlayer.replace({uri: audioUrl})` via expo-audio, which expects a downloadable URL. No mechanism exists to feed it a live stream of bytes.

### Current audio output flow

```
SDK App                     Cloud                        Phone                    Glasses
   |                          |                            |                        |
   |--AUDIO_PLAY_REQUEST----->|                            |                        |
   |  {audioUrl, volume}      |--audio_play_request------->|                        |
   |                          |  {audioUrl, volume}        |--HTTP GET audioUrl---->CDN
   |                          |                            |<----complete file------|
   |                          |                            |--play via expo-audio-->|
   |                          |                            |------BLE audio-------->|
   |                          |<--AUDIO_PLAY_RESPONSE------|                        |
   |<--AUDIO_PLAY_RESPONSE----|  {success, duration}       |                        |
```

Key code paths:
- SDK sends request: `packages/sdk/src/app/session/modules/audio.ts` → `playAudio()` (L144)
- Cloud relays to phone: `packages/cloud/src/services/session/handlers/app-message-handler.ts` → `handleAudioPlayRequest()` (L405)
- Phone plays URL: `mobile/src/services/AudioPlaybackService.ts` → `play()` → `player.replace({uri: audioUrl})` (L109)

### What needs to change

The phone's audio player (`expo-audio` `AudioPlayer`) only accepts URIs. Any streaming solution must either:
- **A)** Provide a URI that happens to stream (HTTP chunked response) — no mobile changes needed
- **B)** Feed raw PCM to a custom native audio player — requires mobile native module
- **C)** Buffer chunks into playable segments and use the existing player — hybrid approach

## Constraints

- **No LiveKit.** LiveKit was removed from the mobile app. Not an option for transport.
- **No WebSocket for audio output.** WS audio streaming had too many issues historically — banned for this direction. The phone ↔ cloud WebSocket carries JSON messages only. Audio output goes through HTTP (cloud relay serves a streaming URL that the phone plays).
- **WS is OK for SDK → cloud push.** The SDK ↔ cloud WebSocket already carries binary audio frames (mic input direction). We can reuse this for pushing MP3 frames from SDK to cloud relay. The ban is on WS audio to the phone, not on the SDK→cloud leg.
- **expo-audio is the mobile audio player.** The phone uses `expo-audio`'s `AudioPlayer` (ExoPlayer on Android, AVPlayer on iOS). ExoPlayer supports HTTP progressive streaming (MP3, AAC, OGG) natively — it can start playing before the full file downloads. AVPlayer also supports progressive HTTP streaming.
- **BLE bandwidth to glasses is limited.** Audio sent from phone to glasses over BLE is already bandwidth-constrained. The glasses speaker is mono, low sample rate.
- **SDK apps run on developer's servers.** They're not directly reachable from the phone — all communication goes through the cloud.

## Use Cases

### 1. Conversational AI (primary)
Developer connects to Gemini Live API. Mic audio from glasses flows to Gemini as input. Gemini generates voice responses as PCM chunks (24kHz, 16-bit mono). Those chunks need to play on the glasses speaker in real-time with <500ms first-byte latency.

### 2. Streaming TTS
Developer uses ElevenLabs or Cartesia streaming TTS. Text is sent token-by-token as an LLM generates it. TTS service returns audio chunks. Developer wants to play audio as it arrives rather than waiting for the full sentence to finish.

### 3. Live audio processing
Developer processes incoming mic audio (noise reduction, effects, translation) and wants to play the result back. Continuous input → continuous output pipeline.

### 4. Custom audio synthesis
Developer generates audio programmatically (sonification, alerts, generative music) and wants to stream it to the glasses.

## Goals

1. SDK API that lets developers push PCM audio chunks for real-time playback
2. First-byte latency under 500ms (time from first chunk pushed to audio playing on device)
3. Works with the existing mobile audio infrastructure (ideally zero or minimal mobile changes)
4. Clean interruption support (user starts talking → flush audio buffer immediately)
5. Supports concurrent use with existing `playAudio(url)` and `speak(text)`

## Non-Goals

- Echo cancellation between output audio and mic input (future work, hard problem)
- Multi-channel / stereo output (glasses speaker is mono)
- Video streaming (separate concern)
- Replacing the existing `playAudio(url)` system (this is additive)
- Client-to-server direct connections (all traffic goes through cloud)

## SDK API Surface (draft)

```typescript
// Option 1: Developer already has MP3 (ElevenLabs, OpenAI, Cartesia, Azure)
// Most common case — no encoding needed, just pass MP3 bytes through
const stream = await session.audio.createOutputStream({ format: 'mp3' })
elevenlabs.onChunk((mp3Bytes) => stream.write(mp3Bytes))
stream.end()

// Option 2: Developer has raw PCM (Gemini Live)
// SDK encodes PCM → MP3 on the developer's server before sending
const stream = await session.audio.createOutputStream({
  sampleRate: 24000,       // PCM input sample rate
  encoding: 'pcm16',       // SDK auto-encodes to MP3 before sending
  channels: 1,             // mono
})
stream.write(pcmBuffer)    // PCM goes in, MP3 comes out over the wire
stream.end()

// Flush/interrupt (user started talking, discard buffered audio)
stream.flush()

// Events
stream.on('error', (err) => { ... })
stream.on('drain', () => { ... })  // backpressure signal
```

## Decisions Made

1. **Transport: Option A — HTTP streaming relay on cloud.**
   SDK pushes MP3 frames to cloud (via existing WS binary frames). Cloud holds an HTTP response open. Phone plays the stream URL via ExoPlayer/AVPlayer. No WS audio to the phone.

2. **Encoding: SDK-side.** Cloud does zero transcoding (just `pipe()` bytes). SDK encodes PCM → MP3 on the developer's server if needed. Most providers output MP3 natively — no encoding needed. SDK ships `lamejs` as optional helper for Gemini Live (PCM-only) use case.

3. **Wire format: MP3.** Universal cross-platform support. Self-framing (no container needed). Opus ruled out due to iOS container incompatibility (no single container works on both Android and iOS).

4. **No cloud CPU risk.** If cloud-side encoding is needed in the future, it runs as a separate microservice that scales independently and can't freeze the main cloud.

## Open Questions

1. **Does ExoPlayer/AVPlayer reliably start playing HTTP progressive MP3 streams with <500ms buffering?**
   - ExoPlayer default `DefaultLoadControl`: minBufferMs=2500. Can we tune to ~100ms for streaming sources?
   - AVPlayer may need `preferredForwardBufferDuration` tuning
   - **Need to benchmark on a real device — this is the Phase 1 gate.**

2. **How does interruption work end-to-end?**
   - SDK calls `stream.flush()` → cloud closes the HTTP response → ExoPlayer stops playback
   - Is closing the HTTP response enough? Or need an explicit stop signal via WS?
   - **Need to test.**

3. **Multiple concurrent streams?**
   - Can a developer stream audio while another app uses `playAudio(url)`?
   - Track ID system already exists (0=speaker, 1=app_audio, 2=tts) — extend it?
   - **Start with**: one stream at a time, auto-ends previous.

4. **What happens on bad network?**
   - Phone buffers run dry → audio stutters
   - SDK sends faster than phone can play → cloud buffer grows unbounded
   - Need backpressure or max buffer policy (cap relay buffer at ~5s of audio)