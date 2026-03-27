# Issue 048: Transcription Pipeline — No Audio / Single-Fire Bug

**Date of investigation:** March 13, 2026
**Source:** User bug report (incident ID: bc73f811) + BetterStack log analysis
**Reporter environment:** App 2.6.0 · iOS 26.3.1 · Mentra Live glasses · iPhone

---

## Problem Statement

Multiple users report that the transcription pipeline fires once (or not at all) and then goes silent until:

- The Mentra app is restarted
- The glasses disconnect and reconnect
- The Preferred Microphone source is toggled to a different setting and back

Behavior by mic source:

- **Glasses / Automatic** → transcription never fires at all
- **Phone / Bluetooth** → fires once, then silently stops

Reported across Mentra AI, Mentra Notes, and third-party SDK apps — confirming this is a platform-level failure, not an individual app bug.

---

## Log Evidence

All timestamps UTC. Logs pulled from BetterStack source `AugmentOS` (source ID 1311181).

### Background condition: Phone WebSocket permanently CLOSED

From the earliest logs on the day of the report, the phone→cloud WebSocket was already in `CLOSED` state. The dashboard mini-app fires every 60s exposing this:

```
09:00:26  Message send error  [error]
          err: "WebSocket not connected (current state: CLOSED)"
          stack: send() → updateSystemSection() → updateDashboardSections()
... repeats every 60s for 6+ hours
```

This is the known ping/pong disconnect bug (see issues 034, 044). The phone WS had been dead since before 09:00 UTC with no reconnection attempted.

---

### Session 1 — Soniox 20s timeout loop begins (15:25–15:38 UTC)

New `UserSession` created at 15:25:58 (glasses reconnected or app restarted):

```
15:25:58  MicrophoneManager initialized
15:25:58  TranscriptionManager created - initializing providers...
15:25:58  Soniox provider initialized with 60 supported languages (SDK mode: true)
15:25:58  ✅ Soniox SDK client initialized
15:25:59  Audio stream started, listening for audio from bridge
```

First Soniox stream opens ~47s after session init (stream is lazy — only created once a subscriber exists):

```
15:26:45  ✅ Soniox SDK stream connected and ready
15:26:45  🚀 STREAM CREATED: [SONIOX] for "transcription:en-US" (146ms)
```

Exactly **20 seconds** later, the first timeout:

```
15:27:05  Soniox SDK stream error  [error]  "Request timeout."
15:27:05  Retrying Soniox for retryable error
15:27:10  ✅ Soniox SDK stream connected and ready       (+5s reconnect)
15:27:10  🚀 STREAM CREATED: [SONIOX] for "transcription:en-US" (143ms)
```

This pattern repeats uninterrupted for the entire session:

```
15:27:30  "Audio data decode timeout"   → retry → reconnect 15:27:35
15:27:55  "Audio data decode timeout"   → retry → reconnect 15:28:01
15:28:21  "Request timeout."            → retry → reconnect 15:28:26
15:28:46  "Audio data decode timeout"   → retry → reconnect 15:28:51
15:29:11  "No audio received."          → retry → reconnect 15:29:16
```

**Zero transcription tokens emitted.** No `text`, `isFinal`, or transcript event appears in the logs.

#### MicrophoneManager init delay — 6 minutes 51 seconds

```
15:26:45  Soniox stream created
...
15:32:36  Sending debounced microphone state change: true    ← 6m51s later
```

For nearly 7 minutes, the Soniox stream was open but the phone had never signaled `mic=true`. Every stream in that window was dead on arrival — Soniox received nothing and timed out immediately as expected.

Session torn down at 15:33:33 (app switch or mic source toggle).

---

### Session 2 — Mic briefly active, same result (15:33:43–15:38:03 UTC)

```
15:33:43  ✅ Soniox SDK stream connected and ready  (84ms)
15:33:45  Sending debounced microphone state change: true    ← only 2s this time
```

Looks more promising. But the 20s cycle resumes immediately:

```
15:34:03  "Audio data decode timeout"   → retry → reconnect 15:34:09
15:34:13  "No audio received."          → retry → reconnect 15:34:18
```

And then at **15:34:14**, mic goes back to false:

```
15:34:14  Sending debounced microphone state change: false
```

This is the glasses VAD cutting the audio stream after ~30s of silence. The phone stops sending audio chunks, Soniox idles, hits the ~20s timeout, retries — but VAD still has the mic off — immediate timeout again. The retry loop is spinning but can never succeed.

Session torn down 15:38:03.

---

### Session 3 — Zombie stream from prior session (15:40:13–15:51:30 UTC)

New session starts at 15:40:13 with full init. Audio bridge starts:

```
15:40:14  Audio stream started, listening for audio from bridge
```

Then **nothing from TranscriptionManager for 6+ minutes**. No stream created.

At **15:46:38**, a ghost fires:

```
15:46:38  Soniox SDK session disconnected  reason: "Connection ended"
15:46:38  Soniox SDK stream error  "WebSocket closed before finished response"
15:46:38  Cannot send microphone state change: WebSocket not open
15:46:41  Cannot send microphone state change: WebSocket not open
```

This is a **zombie Soniox stream from Session 2** that survived teardown. It held a Soniox connection open for 8 minutes into a new session, during which the new session's TranscriptionManager had no stream. When it finally died, the MicrophoneManager for the new session also found its WebSocket not open.

Session torn down 15:51:30.

---

### Session 4 — Mic toggle → transcription works (16:32:59 onward)

After another restart / mic source toggle, a new session begins at 16:32:59. This time it works:

```
16:33:50  🚀 STREAM CREATED: [SONIOX] for "transcription:en-US" (81ms)
...
16:34:13  Generating speech from text: "I see a person holding an object..."
16:38:14  Generating speech from text: "Your plants are in various stages of growth..."
16:39:56  Generating speech from text: "That is a box for Mentra Live glasses."
16:51:35  Generating speech from text: "That is a television screen displaying content..."
```

The transcription pipeline works when audio is actually flowing. This confirms the platform is functional — the failures above were all caused by no audio reaching Soniox, not a logic error in the transcription routing itself.

The 20s timeout cycle is **still** happening in the background even during this working session — there appear to be parallel streams, one receiving audio and one not. This is consistent with the dual-stream / dedup issue (see `transcription-stream-dedup`).

---

## Error Summary (15:00–17:00 UTC, single user)

| Error                                       | Count   |
| ------------------------------------------- | ------- |
| `Audio data decode timeout`                 | ~35     |
| `Request timeout.`                          | ~30     |
| `No audio received.`                        | ~10     |
| `WebSocket closed before finished response` | 1       |
| **Total Soniox stream failures**            | **~76** |

All followed immediately by `Retrying Soniox for retryable error` and a new stream (~5s later). The retry machinery works; the underlying audio absence does not get fixed by retry.

---

## Root Causes

### RC-1: Soniox SDK stream has no keepalive (primary)

The Soniox SDK stream idle timeout is ~20 seconds. When no audio arrives, the stream dies. The old WebSocket-based Soniox integration sent a `{"type":"keepalive"}` frame every 15s to prevent this; the new SDK integration has no equivalent.

When glasses VAD detects silence → phone stops sending audio → Soniox stream idles → 20s timeout → retry → VAD still silent → immediate re-timeout. The retry loop runs indefinitely and never produces tokens.

**Fix:** Add a keepalive heartbeat to `SonioxSdkStream` (every 15s when idle). See issue 044 Fix 3 and issue 041.

### RC-2: MicrophoneManager init delay / debounce race

On session init, `MicrophoneManager` does not immediately signal `mic=true` even when there are active subscribers. In Session 1 above, the delay was 6 minutes 51 seconds. During this window every Soniox stream fails instantly with `"No audio received."`.

The debounce logic that batches mic state changes is correct for rapid toggling but should not apply to the initial `true` signal on session creation when a subscriber is already registered.

**Fix:** Emit `mic=true` immediately (no debounce) on session init when at least one transcription subscriber exists. See issue 006-014.

### RC-3: Zombie Soniox stream outlives its session

`SonioxSdkStream.dispose()` is not synchronous or is not properly awaited during session teardown. The stream from Session 2 was still alive 8 minutes into Session 3, starving the new session of a usable Soniox connection.

**Fix:** Ensure stream teardown is synchronous and that the stream is removed from all registries before the session is marked destroyed. See issue 044 Fix 3.

### RC-4: Glasses mic / Automatic source produces zero audio at cloud

With Preferred Mic set to Glasses or Automatic, no audio arrives at the cloud audio bridge at all. The `TranscriptionManager` does not even create a Soniox stream — there are no subscribers receiving audio.

This is likely an iOS `AVAudioSession` routing issue: the MentraOS mobile app may not configure the audio session to use the glasses as the input device when that mic source is selected. Voice Memos works because iOS routes glasses mic through the system audio session by default; MentraOS has its own audio session that may override or not configure this.

**Fix:** Investigate iOS `AVAudioSession` input routing in the MentraOS mobile app when Glasses or Automatic mic source is selected. This is a mobile-side bug.

### RC-5: Phone WebSocket idle disconnect (background condition)

The phone→cloud WebSocket was CLOSED for the entire day before the user started testing transcription. This is the ping/pong bug from issues 034 and 044. While not the direct cause of the transcription failure, it means:

- The user's cloud session was in a degraded state throughout
- Any reconnect attempts by the SDK were failing silently
- The dashboard was spamming 3 error log lines per minute all day

**Fix:** Cherry-pick ping/pong handler from `cloud/sdk-hono` to `main`. Already documented in 044.

---

## User-Facing Workarounds (short-term)

1. **Preferred Mic = Phone or Bluetooth** (not Glasses or Automatic)
2. When transcription stops: toggle Preferred Mic to any other source → back. This forces a mic state resync without requiring a full app restart.
3. Full app restart also resets the pipeline.

---

## Fix Priority

| Fix                                       | Effort | Impact                                           | Issue ref      |
| ----------------------------------------- | ------ | ------------------------------------------------ | -------------- |
| Soniox keepalive in SDK stream            | Low    | High — eliminates 20s timeout loop for all users | 041, 044 Fix 3 |
| MicrophoneManager immediate init signal   | Low    | Medium — eliminates the init-delay dead window   | 006-014        |
| Zombie stream cleanup on session teardown | Medium | Medium — prevents stream starvation on reconnect | 044 Fix 3      |
| iOS glasses mic AVAudioSession routing    | Medium | High for glasses mic users                       | New — mobile   |
| Ping/pong cherry-pick to main             | Low    | High — fixes WS idle disconnects platform-wide   | 034, 044       |

---

## Related Issues

- `034-ws-liveness` — phone WebSocket keepalive / ping-pong
- `041-soniox-sdk` — Soniox SDK stream integration, keepalive
- `044-cloud-prod-error-storm` — Fix 3 (Soniox 408), Fix 0 (ping/pong cherry-pick)
- `006-captions-and-apps-stopping/014-mic-on-intermittent-failure` — MicrophoneManager init race
- `transcription-stream-dedup` — parallel/duplicate stream issue observed in Session 4
