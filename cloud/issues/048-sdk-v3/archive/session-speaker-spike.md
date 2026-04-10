# Spike: Speaker System (Audio Output) — SDK v3

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md), [041 audio output streaming](../041-sdk-audio-output-streaming), [010 audio manager consolidation](../010-audio-manager-consolidation), [session.camera spike](./session-camera-spike.md)
**Status:** Spike
**Date:** 2026-03-18

---

## Overview

**What this doc covers:** The full audio output system for SDK v3 — URL playback, TTS via ElevenLabs, audio output streaming (real-time audio from mini app to glasses), the track/mixing system, and the audio priority / conflict resolution problem. Covers current architecture audit, known issues, the unified v3 API, and open design questions.

**What this doc does NOT cover:** Audio _input_ (microphone, VAD, audio chunks) — that's `session.mic`. Also does not cover the broader SDK v3 migration plan (see [spike.md](./spike.md)), reconnection architecture (see [reconnection spike](./reconnection-architecture-spike.md)), or on-device local runtime concerns (see [client SDK spike](./client-sdk-spike.md)).

**Key naming change:** In v2, audio output lived on `session.audio`. In v3, output is `session.speaker` and input is `session.mic`. This spike covers `session.speaker` only.

---

## Current Architecture (v2)

### Audio URL Playback

**SDK:** `AudioManager` — 559 lines
**Cloud:** `AudioManager` — 464 lines

The playback flow:

```
SDK sends play(audioUrl, opts)
    → Cloud receives and processes
        → Cloud relays to phone
            → Phone plays audio on glasses speakers
                → Cloud sends back play response (success/error/duration)
```

Key details:

- **Track system:** 3 tracks for mixing — `speaker` (0), `app_audio` (1), `tts` (2). Tracks allow concurrent audio from different sources to be layered or independently controlled.
- **PlayOptions:** `audioUrl`, `volume` (0.0–1.0), `stopOtherAudio` (boolean), `trackId` (0, 1, or 2).
- Audio play responses flow back from the phone/glasses through the cloud to the SDK with success, error, or duration info.

### Text-to-Speech

**SDK:** `AudioManager.speak()` (same 559-line file)
**Cloud:** ElevenLabs API integration

The TTS flow:

```
SDK sends speak(text, opts)
    → Cloud receives text + voice config
        → Cloud calls ElevenLabs API
            → ElevenLabs returns audio URL
                → Cloud plays URL via the same playback path
```

Key details:

- `speak()` is a convenience method that wraps the ElevenLabs TTS API and feeds the result into the URL playback path.
- **SpeakOptions:** `voice_id`, `model_id`, `voice_settings` (`stability`, `similarity_boost`, `style`, `speed`), `volume` (0.0–1.0), `stopOtherAudio` (boolean), `trackId`.
- The SDK never sees the generated audio URL — the cloud handles the TTS→URL→play pipeline internally.

### Audio Output Streaming

**SDK:** `AudioOutputStream` — 376 lines
**Cloud:** `AppAudioStreamManager` — 575 lines

This is the experimental feature for streaming audio FROM a mini app TO the glasses in real time. The primary use case is real-time AI audio — ElevenLabs streaming TTS, Gemini Live, OpenAI Realtime API, etc.

The streaming flow:

```
SDK calls createOutputStream(opts)
    → Cloud provisions stream, returns streamId
        → Cloud opens HTTP chunked response to phone
            → SDK writes audio bytes (MP3 or PCM)
                → Cloud relays via binary WebSocket frames
                    → Phone receives via HTTP chunked response
                        → Phone plays via ExoPlayer (Android) / AVPlayer (iOS)
```

Key details:

- **Binary frame format:** `[36 bytes streamId UUID as ASCII] [N bytes audio data]` — the streamId is sent as a prefix on every binary frame so the cloud can route audio from multiple concurrent streams.
- **Codec support:** MP3 passthrough (SDK sends MP3 bytes, cloud relays as-is) or PCM→MP3 encoding (SDK sends raw PCM16 samples, cloud encodes to MP3 via lamejs before relaying).
- **Stream lifecycle states:** `created` → `streaming` → `ending` → `ended` → `error`
- **StreamOptions:** `format` (`mp3` | `pcm16`), `sampleRate`, `channels`, `bitrate`, `volume`, `trackId`, `stopOtherAudio`.
- **AudioOutputStream API:** `write(chunk)` — send audio bytes, `end()` — graceful close, `flush()` — interrupt (silence immediately).

---

## Issues

| #   | Issue                                           | Impact                                                                                                                         | Root Cause                                                                                                                       |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No audio priority system across apps**        | If two apps both call `play()` with `stopOtherAudio: false`, they overlap with no arbitration. No way to know who should win.  | There's no concept of priority — apps are peers, and the system has no way to rank their audio importance.                       |
| 2   | **`stopOtherAudio` is a blunt instrument**      | It's a per-request boolean, not per-app or per-priority-level. An app can only say "stop everything" or "don't stop anything." | Designed for single-app use cases. Multi-app audio was never properly designed.                                                  |
| 3   | **No system vs app sound distinction**          | Notification sounds, connection status chimes, and app audio all go through the same path with no priority hierarchy.          | System sounds are treated identically to app sounds — there's no reserved priority level for the OS.                             |
| 4   | **Audio streaming conflicts with URL playback** | If an app is streaming TTS via `AudioOutputStream` and another app calls `play()`, the behavior is undefined. Who wins?        | Streaming and URL playback were built as separate subsystems that don't know about each other.                                   |
| 5   | **Track IDs allow mixing but not preemption**   | Tracks let you play on different channels, but there's no way to say "my audio is more important than what's on track 1."      | Tracks are a mixing feature, not a priority feature. They share the same physical speakers with no volume ducking or preemption. |
| 6   | **Internal methods exposed publicly**           | `hasPendingRequest()`, `getPendingRequestCount()`, `cancelAudioRequest()`, etc. are public on `AudioManager`.                  | No public/private boundary in the v2 SDK — everything on the manager class is accessible.                                        |
| 7   | **No way to query current playback state**      | The SDK has no API to ask "is something currently playing?" or "what's on each track?"                                         | Playback state lives on the phone. The cloud and SDK only know about requests, not about actual playback status.                 |

---

## Proposed v3 API

### `session.speaker`

```typescript
// ─── URL Playback ───────────────────────────────
session.speaker.play(opts: PlayOptions)                // → Promise<PlayResult>
session.speaker.stop(trackId?: TrackId)                // → Promise<void>

// ─── Text-to-Speech ─────────────────────────────
session.speaker.speak(text: string, opts?: SpeakOptions)  // → Promise<PlayResult>

// ─── Audio Output Streaming ─────────────────────
session.speaker.createStream(opts?: StreamOptions)     // → Promise<AudioOutputStream>

// ─── Permissions ────────────────────────────────
session.speaker.hasPermission                          // → boolean
```

### Type Definitions

```typescript
// ─── Track System ───────────────────────────────

type TrackId = 0 | 1 | 2;
// 0 = speaker (default), 1 = app_audio, 2 = tts

// ─── URL Playback ───────────────────────────────

interface PlayOptions {
  url: string;
  volume?: number; // 0.0–1.0, default: 1.0
  trackId?: TrackId; // default: 0
  stopOtherAudio?: boolean; // default: false
}

interface PlayResult {
  duration: number; // ms — total audio duration
}

// ─── Text-to-Speech ─────────────────────────────

interface SpeakOptions {
  voiceId?: string; // ElevenLabs voice ID
  modelId?: string; // ElevenLabs model ID
  voiceSettings?: VoiceSettings;
  volume?: number; // 0.0–1.0, default: 1.0
  trackId?: TrackId; // default: 2
  stopOtherAudio?: boolean; // default: false
}

interface VoiceSettings {
  stability?: number; // 0.0–1.0
  similarityBoost?: number; // 0.0–1.0
  style?: number; // 0.0–1.0
  speed?: number; // 0.5–2.0
}

// ─── Audio Output Streaming ─────────────────────

interface StreamOptions {
  format?: "mp3" | "pcm16"; // default: 'mp3'
  sampleRate?: number; // Hz, default: 44100
  channels?: 1 | 2; // default: 1
  bitrate?: number; // kbps, default: 128
  volume?: number; // 0.0–1.0, default: 1.0
  trackId?: TrackId; // default: 1
  stopOtherAudio?: boolean; // default: false
}

interface AudioOutputStream {
  readonly id: string; // stream UUID
  readonly state: StreamState;

  write(chunk: Uint8Array): void; // send audio bytes
  end(): Promise<void>; // graceful close — flush remaining audio, then stop
  flush(): void; // interrupt — silence immediately, discard buffered data

  onStateChange(handler: (state: StreamState) => void): void;
}

type StreamState = "created" | "streaming" | "ending" | "ended" | "error";

// ─── Errors ─────────────────────────────────────

interface SpeakerError {
  code: SpeakerErrorCode;
  message: string;
}

type SpeakerErrorCode =
  | "PLAYBACK_FAILED" // URL couldn't be played (bad URL, network, codec)
  | "TTS_FAILED" // ElevenLabs API error
  | "STREAM_FAILED" // output stream error (encoding, relay, phone disconnected)
  | "PERMISSION_DENIED" // app doesn't have speaker permission
  | "INVALID_OPTIONS"; // bad options (e.g., volume out of range)
```

### Usage Examples

```typescript
// Simple playback
await session.speaker.play({ url: "https://example.com/alert.mp3" });

// TTS with custom voice
await session.speaker.speak("Hello world", {
  voiceId: "pNInz6obpgDQGcFmaJgB",
  volume: 0.8,
});

// Real-time AI audio streaming
const stream = await session.speaker.createStream({ format: "mp3" });
// ... pipe ElevenLabs streaming TTS chunks into the stream ...
stream.write(mp3Chunk);
stream.write(mp3Chunk);
stream.write(mp3Chunk);
stream.end();

// Interrupt — immediately silence and discard buffered audio
stream.flush();

// Stop all audio on a specific track
await session.speaker.stop(1);

// Stop all audio on all tracks
await session.speaker.stop();
```

---

## Design: Audio Output Streaming

### Binary Frame Protocol

The binary frame format stays the same as v2 — it works and there's no reason to change it:

```
[36 bytes — streamId UUID as ASCII] [N bytes — audio data]
```

Every binary WebSocket frame the SDK sends is prefixed with the 36-byte ASCII stream UUID. This lets the cloud demux frames from multiple concurrent streams without any additional framing or length headers.

### Codec Pipeline

Two paths depending on the `format` option:

| Format  | SDK                  | Cloud                                 | Phone                          |
| ------- | -------------------- | ------------------------------------- | ------------------------------ |
| `mp3`   | SDK writes MP3 bytes | Passthrough — relay as-is             | ExoPlayer / AVPlayer plays MP3 |
| `pcm16` | SDK writes raw PCM16 | Encode PCM→MP3 via lamejs, then relay | ExoPlayer / AVPlayer plays MP3 |

The phone always receives MP3. The `pcm16` option exists for convenience when the source produces raw samples (e.g., OpenAI Realtime API) — the cloud handles the encoding so the app developer doesn't need to bundle an MP3 encoder.

### Stream Lifecycle

```
createStream() called
    → SDK sends CREATE_AUDIO_STREAM message
        → Cloud provisions stream, opens HTTP chunked response to phone
            → Stream enters 'created' state

write(chunk) called
    → SDK sends binary frame: [streamId][audioData]
        → Cloud relays to phone via chunked response
            → Stream enters 'streaming' state (on first write)

end() called
    → SDK sends END_AUDIO_STREAM message
        → Cloud flushes remaining audio, closes chunked response
            → Stream enters 'ending' → 'ended'

flush() called
    → SDK sends FLUSH_AUDIO_STREAM message
        → Cloud discards buffered audio, signals phone to stop playback immediately
            → Stream enters 'ended'

Error at any point
    → Stream enters 'error' state
        → Subsequent write() calls are no-ops
```

### Changes from v2

- `createOutputStream()` → `createStream()` — shorter name, lives on `session.speaker` instead of `session.audio`.
- `AudioOutputStream` type definitions get proper exports (in v2 these were loosely typed).
- `flush()` semantics are clarified: it means "silence immediately and discard buffered audio," not "flush the buffer to the output."
- The stream is `readonly` for `id` and `state` — no more reaching into internals.

---

## Design: Audio Priority & Conflict Resolution

> **This is an open design discussion, not a decided spec.** The priority system is the hardest part of the speaker redesign and needs further input before we commit to an approach.

### The Problem

Today there is no arbitration when multiple audio sources compete:

1. **App A** is streaming real-time TTS via `createStream()`.
2. **App B** calls `play()` with a notification sound.
3. **The OS** needs to play a "glasses disconnected" chime.

What happens? In v2: undefined behavior. If `stopOtherAudio` is `false`, everything overlaps into a mess. If `stopOtherAudio` is `true`, the most recent call kills everything else — including potentially important system sounds.

### Option A: Priority Levels

Define explicit priority tiers. Higher priority audio preempts or ducks lower priority audio.

```
Priority 3 (highest): System sounds — connection status, critical alerts
Priority 2:           Foreground app audio
Priority 1:           Background app audio
Priority 0 (lowest):  Ambient / low-priority audio
```

**How it would work:**

- Each `play()` / `speak()` / `createStream()` call has an implicit priority based on who's calling (system, foreground app, background app).
- When higher-priority audio starts, lower-priority audio is ducked (volume reduced) or paused.
- When higher-priority audio ends, lower-priority audio resumes or un-ducks.
- `stopOtherAudio` is removed or deprecated — priority handles it.

**Pros:** Predictable behavior. System sounds always win. Foreground app always beats background apps.
**Cons:** More complexity in the cloud/phone audio mixer. The app developer loses explicit control. Edge cases around "what if two foreground apps both play?" — you still need a tiebreaker.

### Option B: OS-Managed Mixer

The OS (cloud + phone) acts as an audio mixer. Apps just play, and the OS decides routing.

- Apps declare audio "categories" (notification, media, voice, ambient) similar to iOS `AVAudioSession` categories.
- The OS has hardcoded rules: voice ducks media, notification ducks everything briefly, ambient is always lowest.
- The phone-side audio system handles the actual mixing/ducking in hardware.

**Pros:** Familiar model (mirrors iOS/Android). Developers don't think about priority — they think about what _kind_ of audio they're playing.
**Cons:** Significant phone-side work. Category system needs to be designed carefully. Glasses speakers may not support sophisticated mixing.

### Option C: Last-Writer-Wins (Simple Rule)

The most recent `play()` / `speak()` / `createStream()` call wins. Previous audio on the same track is stopped. Different tracks can coexist.

- No priority system at all.
- Track IDs are the only isolation mechanism — if you want two audio sources to coexist, put them on different tracks.
- `stopOtherAudio: true` stops all tracks. `stopOtherAudio: false` (default) only affects the target track.
- System sounds get a reserved track (e.g., track 0) that apps can't write to.

**Pros:** Dead simple. Easy to implement. Developers understand it immediately.
**Cons:** No ducking. No graceful transitions. System sounds can still be stepped on if an app uses track 0 (unless we enforce the reservation). Doesn't scale well beyond 3 tracks.

### Current Leaning

Option C (last-writer-wins) for v3.0, with the system-sound track reservation. It's the simplest thing that works and doesn't require phone-side mixer changes. Option A or B could be layered on in v3.1+ if multi-app audio becomes a real problem in practice.

The key insight: most apps today don't play concurrent audio. The common case is one app playing TTS or one app streaming AI audio. The priority problem is real but may not need a complex solution in v3.0.

---

## What Changes Where

### SDK

| File / Module                   | Change                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AudioManager` (559 lines)      | Replace with `SpeakerManager` — unified surface for `session.speaker`                                                                                    |
| `AudioOutputStream` (376 lines) | Keep as `AudioOutputStream` type, but created via `session.speaker.createStream()` instead of `session.audio.createOutputStream()`                       |
| New: `SpeakerManager`           | Owns `play()`, `stop()`, `speak()`, `createStream()`, `hasPermission`                                                                                    |
| Internal cleanup                | Remove public exposure of `hasPendingRequest()`, `getPendingRequestCount()`, `cancelAudioRequest()` — these become private internals of `SpeakerManager` |

### Cloud

| File / Module                       | Change                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `AudioManager` (464 lines)          | Rename to `SpeakerManager` — same playback relay + TTS logic, cleaner API |
| `AppAudioStreamManager` (575 lines) | Fold into `SpeakerManager` as internal `StreamRelay` service              |
| ElevenLabs TTS integration          | No changes — stays as the cloud-side TTS provider                         |
| Wire message handlers               | Update to accept v3 message names alongside v2 for backward compat        |

### Wire Protocol

| Message               | Change                                           |
| --------------------- | ------------------------------------------------ |
| `PLAY_AUDIO`          | No change — same payload, same flow              |
| `STOP_AUDIO`          | No change                                        |
| `SPEAK`               | No change — same TTS request format              |
| `AUDIO_PLAY_RESPONSE` | No change — same success/error/duration response |
| `CREATE_AUDIO_STREAM` | No change — same provisioning flow               |
| `END_AUDIO_STREAM`    | No change                                        |
| `FLUSH_AUDIO_STREAM`  | No change                                        |
| Binary audio frames   | No change — same `[streamId][data]` format       |

The wire protocol doesn't change. All the v3 work is in the SDK surface (renaming, cleaning up public API) and cloud-side code organization (merging managers). The phone sees the same messages it always did.

---

## Open Questions

| #   | Question                                                                  | Notes                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Should the track system expand beyond 3 tracks?**                       | 3 tracks is arbitrary. If we go with the priority model later, tracks might map to priority levels (need more than 3). If we keep last-writer-wins, 3 is probably fine. Expanding later is not breaking.                                                                             |
| 2   | **Should `speak()` accept a streaming mode?**                             | Today `speak()` generates a full audio URL via ElevenLabs and then plays it. A streaming mode would use ElevenLabs streaming API + `AudioOutputStream` for lower latency. More complex but much faster TTFB.                                                                         |
| 3   | **Should system sounds be enforced at the SDK level or the cloud level?** | If we reserve track 0 for system sounds, should the SDK reject `play({ trackId: 0 })` from apps, or should the cloud reject it? Cloud-side enforcement is more secure. SDK-side is faster feedback.                                                                                  |
| 4   | **What happens to an `AudioOutputStream` on reconnection?**               | If the WebSocket drops and reconnects, the HTTP chunked response to the phone is dead. Does the stream enter `error` state? Can it resume? Probably needs to be `error` — the phone-side player has lost its source. See [reconnection spike](./reconnection-architecture-spike.md). |
| 5   | **Should `flush()` be renamed to something clearer?**                     | `flush()` in most I/O contexts means "push buffered data out." Here it means the opposite — "discard everything and silence." `silence()`, `interrupt()`, or `abort()` might be less confusing.                                                                                      |
| 6   | **PCM→MP3 encoding on the cloud — should this move to the SDK?**          | Cloud-side encoding via lamejs adds CPU load to the cloud and latency to the stream. If the SDK did the encoding, the cloud would always be passthrough. But then every app bundles an MP3 encoder.                                                                                  |
| 7   | **Do we need a `speaker.onPlaybackEnd` event?**                           | Today the SDK gets a `PlayResult` with duration when `play()` resolves. But there's no event for "audio actually finished playing on the glasses." The promise resolves when the phone _starts_ playback, not when it ends.                                                          |
| 8   | **Should `stop()` with no arguments stop streaming audio too?**           | `stop()` today stops URL playback. If an `AudioOutputStream` is active, should `stop()` also `flush()` it? Or should streams only be stopped via `stream.end()` / `stream.flush()`?                                                                                                  |
| 9   | **Audio priority — do we need it for v3.0 or can we ship without?**       | See the priority discussion above. If we defer priority to v3.1, we ship with the same overlap behavior as v2 (but with the cleaner API). Is that acceptable?                                                                                                                        |
| 10  | **Should `volume` be settable per-track after playback starts?**          | Today volume is set per-request at play time. There's no `session.speaker.setVolume(trackId, volume)` to adjust a playing track. This would be useful for ducking but requires phone-side support.                                                                                   |
