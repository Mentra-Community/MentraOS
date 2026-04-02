# Spike: Captions 30-Second Latency — March 23–24, 2026

## Overview

**What this doc covers:** Investigation of a pattern of captions latency complaints and complete dropouts across multiple G1 users on March 23–24, 2026, including what the logs actually show vs what is still unknown.
**Why this doc exists:** At least three users reported the same symptom in the same 24-hour window. A team member responded in Discord saying "we had some issues last 24 hours, we're fixing" — but that's an unverified claim, not a confirmed incident. This spike is the investigation of whether there actually was a cloud-side issue, what the evidence shows, and what the root cause might be.
**Who should read this:** Cloud engineers (transcription pipeline), anyone triaging future captions latency regressions.

---

## Background

The captions transcription pipeline for a connected G1 session:

```
Phone mic → LC3 encode → UDP → Cloud AudioManager
                                     ↓
                              TranscriptionManager
                                     ↓ (Soniox SDK stream)
                              Soniox ASR
                                     ↓ transcript tokens
                              com.mentra.captions (cloud app)
                                     ↓ display request
                              Glasses display
```

Normal end-to-end latency is ~1 second. The `UDP audio stats in AudioManager` log fires every 10 seconds and is independent of transcription — it tracks packet counts, not transcript output. Display updates from `com.mentra.captions` are the observable proxy for "transcription is working."

There is also a separate path: if the phone has `enforce_local_transcription: true`, the phone runs Sherpa ONNX locally and sends transcript tokens to the cloud. Whether the captions app subscribes to that local stream or still goes through the cloud Soniox stream regardless is not confirmed — see Finding 5.

---

## User Reports

Three independent reports in the same 24-hour window:

**User 1 (Discord):** Complete stop of both transcription and MentraOS 20 minutes into use of G1. Restarted 4 times with no recovery. Disconnected and used Even Realities native transcription — worked fine for 40 minutes. Filed bug report in-app. _(See also: issue 051 — BLE reconnect failure cascade compounded this experience specifically.)_

**User 2 (Discord, "Connolly"):** 15–20 minute window of ~30-second latency under stable network conditions. Self-resolved after ~20 minutes. Latency returned to 5–6 seconds.

**User 3 (in-app bug report, incident `310702d2`):** Sudden jump to ~30-second latency after captions were functioning normally. Restarting the app and the captions mini-app did not help. G1, phone internal mic, cellular, Stockholm timezone.

**Team acknowledgment (Discord):** A team member replied at 10:15 PM on March 23: _"Sorry, we had some issues last 24 hours, we're fixing."_ This is Discord chat, not a confirmed incident report. It's context, not evidence.

The timing correlation across all three reports is real. Whether the cause was a single cloud-side event or multiple independent failures that happened to coincide is still open.

---

## BetterStack Analysis (User 3)

Queried per-minute display update counts and UDP audio stats for User 3's session on 2026-03-24 07:00–07:40 UTC.

### Display updates per minute (proxy for transcription throughput)

| UTC minute  | Display updates | UDP stats | Actual captions | State                               |
| ----------- | --------------- | --------- | --------------- | ----------------------------------- |
| 07:00       | 66              | 6         | ~60             | ✅ Normal                           |
| 07:01       | 73              | 6         | ~67             | ✅ Normal                           |
| 07:02       | 59              | 6         | ~53             | ✅ Normal                           |
| 07:03       | 54              | 6         | ~48             | ✅ Normal                           |
| 07:04       | 79              | 6         | ~73             | ✅ Normal                           |
| 07:05       | 15              | 6         | ~9              | ⚠️ Degrading                        |
| 07:06       | 6               | 6         | ~0              | ❌ Zero output                      |
| 07:07       | 6               | 6         | ~0              | ❌ Zero output                      |
| 07:08       | 6               | 6         | ~0              | ❌ Zero output                      |
| 07:09–07:27 | ~12–17          | ~10–13    | minimal         | ❌ Severely degraded                |
| 07:28–07:29 | 2–5             | 2–5       | ~0              | ❌ Near silence                     |
| 07:30–07:37 | 6–16            | 5–6       | occasional      | ⚠️ Partial recovery + burst pattern |

UDP stats = 6 per minute throughout = audio flowing every 10 seconds, uninterrupted. The audio transport path never broke. Only transcription output stopped.

### The burst pattern (07:30–07:37)

This is the window visible in the incident-provided cloud logs. Display updates arrive in tight clusters separated by ~30-second silence:

```
07:36:07  ✅ Display sent (captions)
[~13 second gap]
07:36:20  ✅ Display sent
07:36:21  ✅ Display sent  ←─┐
07:36:21  ✅ Display sent    │ burst: 10 updates in ~1 second
07:36:21  ✅ Display sent    │
...                        ←─┘
[~30 second gap]
07:36:52  ✅ Display sent
07:36:52  ✅ Display sent  ← another burst
```

This is not latency in the normal sense. The pipeline is buffering ~30 seconds of transcript tokens and flushing them at once. From the user's perspective: silence for 30 seconds, rapid catch-up, silence again. Impossible to follow in real-time.

### Degradation onset

The drop from 79 display updates/minute (07:04) to 0 (07:06) happened over approximately 90 seconds, starting at roughly **07:04:30–07:05:00 UTC** (08:04–08:05 AM Stockholm local time).

The user filed the report at 12:37 AM local (07:37 UTC) — approximately 32 minutes after degradation began.

---

## Client-Side Log Analysis (User 3)

User 3's phone logs from incident `310702d2` were reviewed for client-side behavior during the session. The phone timestamps are in local time (Stockholm, UTC+1); the session overlaps with the 07:30–07:37 UTC window visible in the cloud logs. Six patterns are worth noting — none are confirmed as causal, but all represent areas where the client is doing more work than expected during initialization and steady-state operation.

### Observation 1: `handleDeviceReady()` fires 8+ times in under 2 seconds

Between 12:30:38.834 and 12:30:39.441 local time, `handleDeviceReady(): Even Realities G1` fires at least 8 times. Each invocation triggers: `save_setting default_wearable`, `save_setting device_name`, `checkCurrentAudioDevice`, `AudioMonitor` checks (which fail — see Observation 5), and a `Device '4' disconnected` status change. This is a substantial amount of churn for what should be a single initialization event. Every call writes settings, checks audio routes, and updates core status.

### Observation 2: `mic_state_change` flood correlating with handleDeviceReady churn

Between 12:30:39.207 and 12:30:39.697 (~490ms), approximately 15+ `mic_state_change` messages arrive from the cloud. Each triggers `setMicState(true,false,true)` and `updateMicState()`. The timing correlates directly with the `handleDeviceReady` churn — the cloud appears to be re-sending mic state for each subscription update triggered by the rapid reconnection cycle. Whether this flood has downstream effects on the transcription pipeline is not confirmed, but it means the cloud is processing ~15 redundant state changes in under 500ms per reconnecting client.

### Observation 3: `PROC_QUEUE - descriptor not found` during BLE connection

The iOS BLE logs show `CORE: PROC_QUEUE - descriptor not found` appearing at least 6 times during the G1 connection phase (12:30:35.524, 12:30:36.037, 12:30:37.037, 12:30:37.542, 12:30:38.047, 12:30:38.553). This is a Core Bluetooth GATT descriptor lookup failure — the client is attempting to discover a BLE descriptor that isn't present or isn't ready yet. It eventually resolves and connection succeeds, but the repeated failures over ~3 seconds suggest either a timing issue in service discovery or a descriptor that doesn't exist on the G1's GATT profile. Worth checking whether this regressed recently.

### Observation 4: Sherpa ONNX processing loop started but no transcript output visible

`CORE: 🔄 Sherpa-ONNX processing loop started` appears at 12:30:34.355. However, the entire remainder of the logs (through 12:37:07, when the bug report was filed) contain zero evidence of Sherpa ONNX producing any transcript output — no "SHERPA" result entries, no local transcription tokens, nothing. User 3 has `enforce_local_transcription: true`. There are two possible explanations: either local transcription results are not logged at the level captured in bug reports, or the Sherpa ONNX model is running its processing loop but not producing output. This ties directly to Finding 5 — if local transcription isn't actually working, the user is silently falling back to (or depending on) the cloud Soniox path.

### Observation 5: Audio route detection repeatedly fails for G1

`CORE: AudioMonitor: No active audio device matching '4'` appears many times throughout the logs. The client is checking whether the G1 glasses (internally identified as device "4") appear as an iOS audio route via `AVAudioSession`. The G1 connects over BLE, not as a standard iOS audio device — it will never appear in the iOS audio route table. This check fires every time `handleDeviceReady()` is called (see Observation 1), which means it fails at least 8 times during initialization alone. The check itself is harmless, but it indicates a mismatch between the audio monitoring code's assumptions and the G1's actual audio architecture.

### Observation 6: App backgrounding during active session

At 12:31:16.629 the app transitions to `inactive`, then `background` at 12:31:17.609. It returns to `active` at 12:32:18.547 — approximately 1 minute in the background. UDP audio packets continued flowing during this window (packets #400 through #1000+). iOS imposes restrictions on background execution: network operations may be throttled, CPU time is limited, and audio processing callbacks may be delayed or suspended. If this backgrounding pattern occurred during the earlier degraded window (07:05+ UTC), it could have affected the phone's ability to process audio or deliver transcription results. This is speculative — we don't have phone logs from the 07:05 UTC onset — but it's a known iOS behavior worth considering.

---

## Pipeline Failure Point Analysis

Systematic analysis of every stage in the transcription pipeline, with evidence for or against each being the cause of the 30-second latency.

```
Phone mic → LC3 encode → UDP transport → Cloud AudioManager → Soniox feed → Soniox ASR → Transcript routing → Captions app → Display delivery → Phone WebSocket → Glasses BLE
```

### ✅ Ruled out by evidence

**Phone mic capture** — Phone logs confirm `CORE: MIC: Started recording from: iPhone Microphone` at 48kHz Float32. Audio flowing throughout session.

**Audio encoding (LC3)** — Phone logs show `UDP: Sending audio #N` at consistent 10-second intervals for every 100 packets. Encoding keeping up with real-time.

**UDP transport (not WebSocket)** — Phone logs explicitly show `UDP: Sending audio ... to 4.178.21.21:8000`. Audio goes via UDP, not WebSocket. The reason we added UDP as the main transport was exactly to avoid the latency WebSocket causes on bad cellular — and UDP IS being used here. No fallback to WebSocket visible in the logs.

**Phone sending slower than real-time** — BetterStack `msSinceLast100` (time between every 100th UDP packet arriving at the cloud) = `~10,000ms ± 50ms` consistently during BOTH the healthy period (07:00–07:04) AND the degraded period (07:05–07:08). The packet arrival rate is identical before and after the failure. If the phone were sending slower than real-time, latency would grow linearly from session start, not spike abruptly at 07:05.

```
Healthy:   07:04:04  msSinceLast100 = 10025
           07:04:14  msSinceLast100 = 9998
           07:04:24  msSinceLast100 = 10005
Degraded:  07:05:04  msSinceLast100 = 9990
           07:05:14  msSinceLast100 = 10115
           07:05:24  msSinceLast100 = 9900
           07:06:04  msSinceLast100 = 9998
           07:06:14  msSinceLast100 = 10003
```

No change whatsoever in audio arrival rate when transcription output stops.

**Cloud audio ingestion** — Same `msSinceLast100` evidence. The AudioManager is receiving packets at a steady rate throughout. No ingestion delay.

**Cloud transcript routing (to captions app)** — When display updates DO arrive during the burst period, they come in rapid clusters (10+ in under 1 second). If the routing layer between Soniox results and the captions app were slow, the bursts would be smoothed. They're sharp — routing is instant once transcripts arrive.

**Captions app processing** — Same evidence. Display requests are generated rapidly within each burst. The captions app is not the bottleneck.

**Display delivery (cloud → phone → glasses)** — Every single `Display sent successfully` in the cloud logs completes cleanly. No delivery failures.

**WebSocket transport delay** — `mic_state_change` messages arrive at the phone at steady 10-second intervals throughout the entire session. If the WebSocket had 30-second latency, those control messages would be delayed too. They're not. Also, a WebSocket transport delay would produce a uniform 30-second shift on all messages, not the burst/silence pattern we see.

### ❓ Cannot determine from current logs

**Cloud feeding audio to Soniox stream** — There is no log between "audio arrived at AudioManager" and "audio fed to Soniox SDK stream." If there is a buffer or queue between those two stages that backed up, it would be invisible with current instrumentation.

**Soniox ASR processing time** — There is no log showing when Soniox returns transcript tokens. The `📝 TRANSCRIPTION` debug-level logs are not captured in BetterStack for this user (log level issue — only info+ captured). We cannot see whether Soniox was returning results slowly, returning them in batches, or not returning them at all.

### Where the 30-second latency lives

Everything outside these two stages is confirmed healthy. The failure narrows to exactly the uninstrumented gap:

```
AudioManager receives UDP packet → [??? no logs ???] → Soniox SDK stream → [??? no logs ???] → transcript token → relayDataToApps
```

Both "cloud's internal feed to Soniox" and "Soniox's own processing" are invisible with current logging. The burst pattern (silence → flood → silence) is consistent with either hypothesis.

---

## `enforce_local_transcription` Code Audit

Traced the full path of `enforce_local_transcription` through mobile client and cloud to determine whether it has any effect on the transcription pipeline.

### How it's supposed to work

1. `enforce_local_transcription` is in `CORE_SETTINGS_KEYS` — sent to the native layer on session start
2. The native layer initializes the Sherpa ONNX model when the setting is true
3. When `shouldSendTranscript` or `offlineCaptionsRunning` is true, audio PCM is fed to Sherpa ONNX
4. Sherpa ONNX produces transcript → `Bridge.sendLocalTranscription()` → emits `local_transcription` event to JS
5. `MantleManager.handle_local_transcription()` routes the transcript:
   - If `offline_captions_running: true` → display directly on glasses (fully offline, no cloud)
   - If `offline_captions_running: false` → `socketComms.sendLocalTranscription(data)` → send to cloud via WebSocket

### What actually happens for User 3

User 3 has `enforce_local_transcription: true` + `offline_captions_running: false`.

The critical gate is `shouldSendTranscript`. This flag is set by the cloud's `mic_state_change` message. Looking at `SocketComms.handle_microphone_state_change()`:

- `requiredData` includes `"pcm"` → sets `shouldSendPcmData = true`
- `requiredData` includes `"transcription"` → sets `shouldSendTranscript = true`

But the cloud's `MicrophoneManager.calculateRequiredData()` **always sends `"pcm"`, never `"transcription"`**:

```
// cloud/packages/cloud/src/services/session/MicrophoneManager.ts
calculateRequiredData(hasPCM, hasTranscription) {
    const requiredData = [];
    // NOTE: For now online apps always need PCM data
    if (hasPCM || hasTranscription) {
      requiredData.push("pcm");
    }
    return requiredData;
}
```

The comment says it all: "For now online apps always need PCM data." The `"transcription"` option exists in the type system but is dead code.

Since the cloud sends `requiredData = ["pcm"]`, the phone sets `should_send_lc3 = true` (audio via UDP) but `should_send_transcript` stays `false`. In the native layer:

```
// mobile/modules/core/ios/Source/CoreManager.swift
if shouldSendTranscript || offlineCaptionsRunning {
    transcriber?.acceptAudio(pcm16le: pcmData)
}
```

Neither flag is true. **Sherpa ONNX is initialized but literally never receives audio.** The "processing loop started" log was a red herring.

### The three actual modes

| Setting combo                                                           | What actually happens                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `enforce_local_transcription: false`                                    | Soniox cloud path. Normal.                                                                             |
| `enforce_local_transcription: true` + `offline_captions_running: false` | **Same as above.** Sherpa ONNX loads but is starved of input. Soniox does all ASR. Setting is a no-op. |
| `enforce_local_transcription: true` + `offline_captions_running: true`  | Fully offline. Sherpa ONNX receives audio, displays directly to glasses, no cloud involvement.         |

### Impact on investigation

- User 3's captions were 100% dependent on the cloud Soniox path despite `enforce_local_transcription: true`
- `enforce_local_transcription` is NOT a fallback for Soniox failures — it does nothing unless `offline_captions_running` is also true
- The setting has zero effect on the cloud — the cloud doesn't read it and doesn't change its behavior based on it
- The setting name is misleading — it doesn't "enforce" anything on its own

---

## Findings

### 1. The audio transport path was healthy throughout — confirmed by packet timing

UDP audio stats every 10 seconds without interruption from 07:00 to 07:39. `msSinceLast100` = ~10,000ms ± 50ms during both healthy and degraded periods — no change in arrival rate. Audio is transported via UDP (not WebSocket), confirmed by phone logs. The phone is sending at real-time rate, the cloud is receiving at real-time rate.

### 2. Transcription output flatlined abruptly at ~07:05 UTC

The drop was not gradual — it went from 79 display updates/minute to zero within two minutes. No client-side state change is visible in the cloud logs at this time (no WebSocket disconnect, no BLE event). The failure is somewhere between audio arriving at the cloud AudioManager and transcripts being dispatched to the captions app — the only uninstrumented segment of the pipeline.

### 3. The stream stayed "open" — no error was logged

The cloud logs (89 total) contain no `Soniox stream error`, `STREAM CLOSED`, `Disposing Soniox provider`, or any transcription-related error in the 07:04–07:08 window. Unlike issue 051, where `Soniox translation provider disposed` is clearly visible, this session shows nothing. From the cloud's perspective, everything appeared healthy while producing no output.

This is either:

- A silent failure at the Soniox SDK level (stream object alive, upstream stopped returning tokens)
- A stall in the routing layer between transcript tokens and the captions app subscription
- Something else in the pipeline we haven't identified yet

We did not find any public Soniox status page or incident report for this date to confirm or rule out an upstream issue on their side.

### 4. The burst flush pattern rules out network issues

If the 30-second silence were a phone→cloud network issue, UDP audio would also drop (it didn't — `msSinceLast100` unchanged). If it were a WebSocket transport delay, `mic_state_change` messages would also be delayed (they weren't — steady 10-second intervals). If it were a display delivery failure, display sends would fail (they don't — every `Display sent successfully` completes cleanly). The burst pattern points to transcripts backing up somewhere between AudioManager and Soniox output, then flushing when the blockage clears.

### 5. `enforce_local_transcription: true` is confirmed as a no-op

Code audit confirms: the cloud always sends `requiredData = ["pcm"]`, never `"transcription"`. The phone's `shouldSendTranscript` flag stays false. Sherpa ONNX is initialized but never fed audio. User 3's captions were entirely dependent on Soniox cloud. The setting had zero effect on the pipeline or the cloud's behavior. See the code audit section above for the full trace.

### 6. Self-resolving behavior is consistent with a temporary upstream issue

User 2's latency resolved on its own after ~20 minutes without any app restart or intervention. This pattern fits a transient upstream degradation (Soniox, an internal queue, or something else) that recovered, not a permanent misconfiguration or client bug. But it's consistent with — not proof of — an upstream issue.

### 7. Client-side initialization is significantly noisier than expected

The `handleDeviceReady()` → settings save → audio check → mic state change cascade fires at least 8 times in under 2 seconds during a single connection event. Each cycle triggers cloud-side subscription updates, which in turn generate ~15 `mic_state_change` messages back to the client in ~490ms. This is not confirmed as a cause of the transcription stall, but it means every G1 connection event creates a burst of redundant work on both the client and the cloud. Under load (multiple users reconnecting simultaneously), this amplification could contribute to pipeline congestion.

### 8. Local transcription is not producing output — confirmed by code, not a logging gap

The absence of local transcript logs is not a logging gap — it's expected behavior. The code audit confirms Sherpa ONNX never receives audio when `offline_captions_running: false`, regardless of `enforce_local_transcription`. The model loads, the processing loop starts, but `acceptAudio()` is never called because `shouldSendTranscript` is false (cloud sends `["pcm"]` not `["transcription"]`).

---

## Conclusions

What we know for certain:

- Transcription output stopped while audio kept flowing, for at least one user, starting around 07:05 UTC on March 24
- Multiple users reported the same symptom in the same 24-hour window
- No errors were logged in the cloud when transcription stopped — it failed silently
- The burst pattern means transcripts were buffering somewhere, not disappearing entirely
- Audio arrival rate at the cloud was identical during healthy and degraded periods (`msSinceLast100` unchanged)
- Every pipeline stage except the Soniox feed / Soniox ASR segment has been ruled out by evidence
- `enforce_local_transcription: true` is a confirmed no-op when `offline_captions_running: false` — code audit traced the full path

What we do not know:

- The root cause — the failure lives in the uninstrumented gap between AudioManager and transcript token dispatch, which includes both the cloud's internal Soniox feed and Soniox's own ASR processing
- Whether the three user reports share the same root cause or are independent failures that coincided
- How many other sessions were affected (no aggregate query run yet)
- Whether the `handleDeviceReady` churn and mic_state_change flood contribute to pipeline congestion under load
- What the team member was "fixing" when they posted in Discord

| Finding                                                   | Confidence                                      |
| --------------------------------------------------------- | ----------------------------------------------- |
| Audio path healthy throughout (UDP, not WS)               | High — `msSinceLast100` unchanged               |
| Phone sending at real-time rate                           | High — identical packet timing pre/post failure |
| Transcription output stopped abruptly at ~07:05 UTC       | High                                            |
| Silent failure — no error logged                          | High                                            |
| Burst pattern = buffered backlog, not network drop        | High — UDP/WS/display all healthy               |
| Failure is between AudioManager and transcript dispatch   | High — all other stages ruled out               |
| `enforce_local_transcription` is a no-op (code confirmed) | High — dead code path, Sherpa ONNX starved      |
| `handleDeviceReady` fires 8+ times per connection         | High (observed in logs)                         |
| `mic_state_change` flood correlates with reconnect churn  | High (observed in logs)                         |
| Root cause is upstream Soniox degradation                 | Unknown — hypothesis only                       |
| Root cause is internal cloud pipeline stall               | Unknown — hypothesis only                       |
| Root cause is client-side initialization amplification    | Unknown — hypothesis only                       |

---

## Next Steps

1. **Instrument the blind spot**: Add logging at the exact point audio is fed to the Soniox SDK stream, and at the point transcript tokens are returned. This is the only uninstrumented segment in the entire pipeline. Without it, we cannot distinguish between "cloud not feeding Soniox" and "Soniox not returning results."
2. **Add silent stream detection**: If a stream has been open >60s with 0 tokens returned while audio is actively flowing, log a warning and consider stream restart. Right now this failure mode is completely invisible.
3. **Fix `enforce_local_transcription`**: The setting is a confirmed no-op unless `offline_captions_running` is also true. Either make it actually work (have the cloud send `requiredData = ["transcription"]` when the setting is active, so the phone feeds audio to Sherpa ONNX and sends transcripts to cloud) or remove / rename the setting so users aren't misled.
4. **Aggregate BetterStack query**: How many sessions had zero display updates + active UDP audio in the 07:00–07:30 UTC window on March 24? If it was widespread, it points more strongly to a shared upstream cause.
5. **Reach out to Soniox**: Ask if they had any degradation or incidents on their end around March 23–24. Their SDK doesn't surface errors unless the stream closes — a slowdown or internal queue backup on their side would look exactly like what we observed.
6. **Debounce or deduplicate `handleDeviceReady()`**: Investigate why `handleDeviceReady()` fires 8+ times for a single G1 connection event. Each invocation triggers settings writes, audio route checks, and cloud subscription updates that generate `mic_state_change` responses. This is unnecessary load on both the client and the cloud regardless of the latency investigation.
7. **Remove or fix the G1 audio route check**: The `AudioMonitor` check for device name in iOS audio routes will never succeed for a BLE-connected device like the G1. Either remove the check for BLE devices or replace it with the correct mechanism. This eliminates noise in the logs.
8. **Investigate iOS backgrounding impact**: Determine whether app backgrounding during an active captions session could interrupt UDP audio handling or delay processing.
