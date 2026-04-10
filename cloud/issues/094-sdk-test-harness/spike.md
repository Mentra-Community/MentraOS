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

### 5. PCM16 audio output regression blocks this

The sdk-test app uses `createOutputStream({ format: "pcm16" })` to pipe Gemini's audio response to the glasses speaker. This is broken (issue 092, finding #1, ship-blocking). Gemini outputs PCM16 24kHz, the SDK is supposed to encode it to MP3 before sending to the cloud relay, but v3 passes raw PCM through without encoding.

This must be fixed before the Gemini integration works end to end. Options:

1. Fix the PCM16 encoding in `SpeakerManager` / `AudioOutputStreamImpl.write()` (the correct fix)
2. Transcode server-side in the mini app before calling `write()` (workaround)
3. Use MP3-only output from Gemini (not supported, Gemini Live only outputs PCM)

Option 1 is the right fix and is already tracked in issue 092.

### 6. Audio input path

Gemini needs raw audio from the glasses microphone. Two options:

- **Use `session.mic.onChunk()`** - the v3 SDK manager. Gets PCM16 chunks from the cloud. This is the clean path.
- **Use the old `session.events.onAudioChunk()`** via the v2 compat shim. This is what sdk-test uses today.

The v3 path (`session.mic.onChunk()`) is the right one. Need to verify it works and delivers PCM16 at 16kHz, which is what Gemini expects.

### 7. Capability-gated tools

Not all tools should be available on all glasses. The tool declarations should be filtered based on `session.capabilities`:

- Camera tools: only if `capabilities.hasCamera` (Mentra Live)
- Display tools: only if `capabilities.hasDisplay` (G1, Mach1)
- Speaker tools: only if `capabilities.hasSpeaker` (Mentra Live)
- LED tools: only if `capabilities.hasLight` (Mentra Live)
- Device, transcription, location, storage, phone: always available

This means the Gemini session config is dynamic, built at connection time based on what glasses are connected. If glasses change mid-session (disconnect/reconnect with different model), the Gemini session would need to reconnect with updated tools.

## Conclusions

| Item                      | Status             | Notes                                                                      |
| ------------------------- | ------------------ | -------------------------------------------------------------------------- |
| Gemini 3.1 Flash Live API | Ready              | Same SDK, same protocol, new model string, function calling is first-class |
| stream-test architecture  | Ready              | Clean patterns for adding managers, state, API routes, UI tabs             |
| Tool declarations         | Designed           | ~20 tools across all managers, capability-gated                            |
| PCM16 audio output        | Blocked            | Issue 092 regression must be fixed first                                   |
| Audio input (mic)         | Needs verification | `session.mic.onChunk()` should work but needs testing                      |
| Webview UI                | Needs design       | Two-tab layout, transcript view, tool call log                             |
| Automated test runner     | Future             | `run_test(manager)` tool that executes checklist items programmatically    |

## Next Steps

1. **Fix PCM16 regression (issue 092)** - prerequisite for any audio output
2. **Verify `session.mic.onChunk()` delivers PCM16 16kHz** - prerequisite for audio input
3. **Write spec** - define the exact tool declarations, state shape, API routes, and UI layout
4. **Implement** - add GeminiManager to stream-test, wire up tools, build the Live Test tab

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
