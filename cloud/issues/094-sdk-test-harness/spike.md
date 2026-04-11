# Spike: SDK Test Harness Mini App

## Overview

**What this doc covers:** Investigation into expanding the `stream-test` example app into a full SDK test harness with a Gemini 3.1 Flash Live integration that can voice-control testing of every SDK manager.
**Why this doc exists:** We need to thoroughly test the v3 SDK (OS-1262) and we need a mini app that exercises every feature. Instead of building a boring form-based test UI, we can use Gemini Live as a voice-controlled test runner that also doubles as a killer demo app.
**Who should read this:** Cloud team, anyone working on SDK v3 testing.

## Background

The `stream-test` app (`examples/stream-test/`) is a full-stack v3 SDK mini app that currently handles camera streaming. It has:

- Bun fullstack architecture (MiniAppServer + Hono API + SSE state broadcasting + React webview)
- Per-user session management (UserSession, StreamManager, StateManager)
- Real-time state sync from backend to frontend via SSE
- WebRTC video player for managed streams
- Stream adoption on reconnect (orphaned stream handling)
- Webview auth via `useMentraAuth` / `getMentraAuth`

The `sdk-test` app (`cloud/packages/apps/sdk-test/`) has a working Gemini Live integration using the `@google/genai` SDK with `ai.live.connect()`. It uses the old model (`gemini-2.5-flash-native-audio-preview-12-2025`) and has tool calls stubbed but not wired up.

We want to combine these: take the stream-test architecture, add a Gemini 3.1 Flash Live provider with function calling, and create an app that can test every SDK manager via voice commands.

## Findings

### 1. Gemini 3.1 Flash Live API

The new model is `gemini-3.1-flash-live`. It uses the same `@google/genai` SDK and `ai.live.connect()` API as the old model. The protocol is unchanged: WebSocket, PCM16 16kHz audio in, PCM16 24kHz audio out.

Key improvements over the 2.5 model:

- **Function calling is a first-class feature.** Tools are declared in the `liveConfig` and the model can call them mid-conversation. The old sdk-test app had this stubbed out.
- **Audio transcriptions.** The API can return text transcripts of both user input and model output alongside the audio. We don't have to rely solely on Soniox for transcription of the user's speech.
- **Proactive audio.** Control when the model responds and in what contexts.
- **Affective dialog.** Adapts response style and tone to match the user's expression.
- **70 language support.**

The `@google/genai` SDK interface is the same:

```
const session = await ai.live.connect({
  model: "gemini-3.1-flash-live",
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: "...",
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
    tools: [{ functionDeclarations: [...] }],
  },
  callbacks: { onopen, onmessage, onerror, onclose },
});
```

Tool calls arrive via `message.toolCall` and responses are sent via `session.sendToolResponse()`.

### 2. stream-test architecture is ready for expansion

The app already has the right patterns for adding new features:

- `UserSession` owns managers. Adding a `RealtimeManager` (or `GeminiManager`) follows the same pattern as `StreamManager`.
- `StateManager` is generic. Adding new state slices (e.g., `gemini: { connected, speaking, lastTool, transcript }`) just means adding to the `AppState` type.
- SSE broadcasting works. The frontend gets updates automatically.
- The Hono API layer is composable. Adding `/api/gemini/start`, `/api/gemini/stop` follows the same pattern as `/api/stream/start`.

### 3. The webview UI needs two tabs

Current app is single-purpose (streaming). With the Gemini test harness, it becomes two-purpose:

- **Stream tab** - what exists today. Camera controls, WebRTC player, status.
- **Live Test tab** - Gemini conversation. Shows: connection status, live transcript (what the user said, what Gemini said), tool call log (which SDK methods Gemini called and what they returned), errors.

Both tabs share the same session. Gemini can control the camera (start/stop stream) and the stream tab can show the result.

### 4. Tools map to SDK managers

Every public method on `MentraSession` that makes sense to voice-control becomes a Gemini tool. The tool declarations go in the Gemini config, and the tool handlers call the actual SDK methods.

Grouped by manager:

**Display** (G1, Mach1 only)

- `show_text(text)` - show text on glasses
- `show_text_wall(text)` - show text wall
- `clear_display()` - clear glasses display

**Camera** (Mentra Live only)

- `take_photo(size?)` - capture a photo, return URL and dimensions
- `start_stream()` - start managed video stream, return viewer URLs
- `stop_stream()` - stop active stream
- `get_stream_status()` - check if streaming

**Speaker** (Mentra Live only)

- `play_audio(url)` - play audio file on glasses
- `speak_tts(text)` - text-to-speech on glasses
- `stop_audio()` - stop audio playback

**LED** (Mentra Live only)

- `set_led(color, duration?)` - turn on LED
- `led_off()` - turn off LED

**Device**

- `get_device_info()` - battery, model, connection state, WiFi
- `get_capabilities()` - what the glasses can do

**Transcription**

- `start_transcription()` - subscribe to speech-to-text
- `stop_transcription()` - unsubscribe

**Location**

- `get_location()` - current GPS coordinates

**Storage**

- `storage_get(key)` - read a value
- `storage_set(key, value)` - write a value
- `storage_list_keys()` - list all keys

**Phone**

- `get_phone_info()` - notifications permission, calendar permission

**Testing**

- `run_test(manager)` - run the checklist items for a specific manager, return pass/fail results
- `get_test_results()` - get summary of all tests run this session

The `run_test` tool is the interesting one. It would run through the relevant items from the SDK v3 test checklist (`drafts/testing/sdk-v3-checklist.md`) programmatically and report results. Gemini could then summarize: "I tested the display manager. 7 of 8 tests passed. showBitmap failed because the glasses don't support bitmaps."

### 5. PCM16 audio output path is WORKING

**Verified April 10, 2026.** The PCM16 encoding path is not broken. The issue 092 regression report was either based on older code or a different scenario.

We built a mic feedback loop test in the stream-test app (`MicTestManager`) that pipes `session.mic.onChunk()` directly to `session.speaker.createStream({ format: "pcm16", sampleRate: 16000 })`. Result: 283 chunks piped successfully, audio plays back through the glasses speaker. The full pipeline works:

- `session.mic.onChunk()` delivers `AudioChunk` with `.data: ArrayBuffer` (1600 bytes per chunk = 50ms at 16kHz mono)
- `session.speaker.createStream({ format: "pcm16" })` opens correctly, transitions to "streaming"
- PCM16 to MP3 encoding via lamejs works (the `toInt16Array` -> `encoder.encodeBuffer` path)
- Cloud relay receives and forwards the encoded MP3
- Phone plays it back through the glasses speaker

**One gotcha found:** The v3 `AudioChunk` interface uses `chunk.data` (ArrayBuffer), not `chunk.arrayBuffer`. The old v2 API used `chunk.arrayBuffer`. Code that passes mic chunks to `write()` must use `new Uint8Array(chunk.data)`. This is not a bug in the SDK, just an API change that needs to be documented clearly in the migration guide.

This means Gemini Live integration is **unblocked**. No SDK fix needed.

### 6. Audio input path is WORKING

**Verified April 10, 2026.** `session.mic.onChunk()` delivers PCM16 16kHz mono audio chunks. Each chunk is an `AudioChunk` object:

```
{
  data: ArrayBuffer (1600 bytes),   // 50ms of 16kHz mono PCM16
  sampleRate: 16000,
  channels: 1,
  timestamp: number
}
```

For Gemini Live, we need to base64-encode `chunk.data` and send it as `audio/pcm;rate=16000`. This is exactly what the sdk-test reference app does (via `bufferToBase64(new Uint8Array(chunk.arrayBuffer))` in the old API, updated to `chunk.data` for v3).

Decision: use `session.mic.onChunk()` (v3 API), not the old `session.events.onAudioChunk()`.

### 7. Capability-gated tools

Not all tools should be available on all glasses. The tool declarations should be filtered based on `session.capabilities`:

- Camera tools: only if `capabilities.hasCamera` (Mentra Live)
- Display tools: only if `capabilities.hasDisplay` (G1, Mach1)
- Speaker tools: only if `capabilities.hasSpeaker` (Mentra Live)
- LED tools: only if `capabilities.hasLight` (Mentra Live)
- Device, transcription, location, storage, phone: always available

This means the Gemini session config is dynamic, built at connection time based on what glasses are connected. If glasses change mid-session (disconnect/reconnect with different model), the Gemini session would need to reconnect with updated tools.

## Progress (April 10, 2026)

### What's been built in stream-test so far

- Video config dropped to 480p / 2Mbps / 15fps (from 720p / 4Mbps) to reduce glasses thermal load
- `MicTestManager` added: mic-to-speaker feedback loop, togglable from webview button
- Mic feedback test verified the full audio pipeline works end to end (283 chunks, no errors)
- Discovered `AudioChunk.data` vs `AudioChunk.arrayBuffer` API difference between v3 and v2
- SSE state broadcasting extended with `micTest` state slice
- REST API route `/api/mic-test/toggle` for webview control

### Decisions made

- **Two-tab UI:** Stream tab (existing camera streaming) + Live Test tab (Gemini conversation + manager explorer)
- **Manager Explorer:** starts as a list of managers/categories, tap to open controls and live state for that manager, back button to return to list. Quick way to test through entire SDK.
- **Gemini model:** `gemini-3.1-flash-live` (not the old 2.5 preview model). Non-negotiable: always use latest models.
- **Audio path:** v3 `session.mic.onChunk()` for input, `session.speaker.createStream({ format: "pcm16" })` for output. Both verified working.
- **Reference code:** Use sdk-test app's `GeminiRealtimeProvider` as a starting point for the provider pattern, but build fresh in stream-test with new model and actual function calling.
- **Tools:** ~20 tools across all managers, capability-gated based on `session.capabilities`. The `run_test(manager)` meta-tool runs checklist items programmatically.

## Conclusions

| Item                      | Status      | Notes                                                                                   |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| Gemini 3.1 Flash Live API | Ready       | Same SDK, same protocol, new model string, function calling is first-class              |
| stream-test architecture  | Ready       | Clean patterns for adding managers, state, API routes, UI tabs                          |
| Tool declarations         | Designed    | ~20 tools across all managers, capability-gated                                         |
| PCM16 audio output        | **Working** | Verified via mic feedback test. lamejs encoding works. Not a regression.                |
| Audio input (mic)         | **Working** | `session.mic.onChunk()` delivers PCM16 16kHz. Use `chunk.data` not `chunk.arrayBuffer`. |
| Webview UI                | Designed    | Two tabs: Stream + Live Test. Manager explorer with list -> detail navigation.          |
| Automated test runner     | Future      | `run_test(manager)` tool that executes checklist items programmatically                 |

## Next Steps

1. **Build the Manager Explorer tab** - list of managers, tap to open, controls + live state per manager
2. **Add Gemini 3.1 Flash Live provider** - `GeminiManager` on `UserSession`, tool declarations, `sendToolResponse` wiring
3. **Build the Live Test tab** - Gemini conversation UI, transcript, tool call log
4. **Wire up all tools** - map each tool to the corresponding SDK manager method
5. **Add TTS and audio file playback tests** - `session.speaker.speak()` and `session.speaker.play()` alongside the mic feedback test

## Related Documents

| Document                                                            | Purpose                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `examples/stream-test/STATUS.md`                                    | Current stream-test app status and architecture                  |
| `cloud/packages/apps/sdk-test/`                                     | Reference implementation for Gemini Live integration (old model) |
| `cloud/issues/092-sdk-v3-alpha1-regressions-and-doc-gaps/`          | PCM16 regression details                                         |
| `cloud/issues/999-cloud-plan/drafts/testing/sdk-v3-checklist.md`    | Full SDK v3 test checklist (what the harness should cover)       |
| `cloud/issues/048-sdk-v3/implementation-status.md`                  | SDK v3 build status and known bugs                               |
| `https://ai.google.dev/gemini-api/docs/live`                        | Gemini Live API docs                                             |
| `https://deepmind.google/models/model-cards/gemini-3-1-flash-live/` | Gemini 3.1 Flash Live model card                                 |
