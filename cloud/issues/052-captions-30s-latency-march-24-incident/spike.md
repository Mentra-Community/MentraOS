# Spike: Captions 30-Second Latency — March 24, 2026 Incident

## Overview

**What this doc covers:** Investigation of a cloud-side incident on March 23–24, 2026 that caused captions latency to jump from ~1 second to ~30 seconds for G1 users, confirmed across multiple bug reports and a team member acknowledgment in Discord.
**Why this doc exists:** At least three users reported the same symptom in the same 24-hour window. A team member confirmed an active issue. BetterStack telemetry shows the exact moment transcription output flatlined while audio kept flowing — pointing to a cloud-side Soniox or transcription routing degradation, not a client bug.
**Who should read this:** Cloud engineers (transcription pipeline, Soniox integration), anyone triaging future captions latency regressions.

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

At every step, audio and transcription data move in near-real-time. Normal end-to-end latency is ~1 second. The `UDP audio stats in AudioManager` log fires every 10 seconds and is independent of transcription — it tracks packet counts, not transcript output. Display updates from `com.mentra.captions` are the observable proxy for "transcription is working."

There is also a separate path: if the phone has `enforce_local_transcription: true`, the phone runs Sherpa ONNX locally and sends transcript tokens to the cloud. The captions app may still subscribe to the Soniox-backed cloud stream regardless of this setting — this is unclear and worth confirming (see Next Steps).

---

## User Reports

Three independent reports in the same 24-hour window:

**User 1 (Discord):** Complete stop of both transcription and MentraOS 20 minutes into use of G1. Restarted 4 times with no recovery. Disconnected and used Even Realities native transcription — worked fine for 40 minutes. Filed bug report in-app. _(See also: issue 051 — BLE reconnect failure cascade compounded the experience.)_

**User 2 (Discord, "Connolly"):** 15–20 minute window of ~30-second latency under stable network conditions. Self-resolved after ~20 minutes. Latency returned to 5–6 seconds.

**User 3 (in-app bug report, incident `310702d2`):** Sudden jump to ~30-second latency after captions were functioning normally. Restarting app and captions mini-app did not help. On G1 with phone internal mic, cellular network, Stockholm timezone.

**Team acknowledgment (Discord):** A team member replied to User 1 at 10:15 PM on March 23: _"Sorry, we had some issues last 24 hours, we're fixing."_

All three reports cluster around March 23–24, 2026. The self-resolving behavior for User 2 and the team acknowledgment both point to a cloud-side degradation event, not a per-device bug.

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

UDP stats = 6 per minute throughout = audio flowing every 10 seconds, uninterrupted. The audio path never broke. Only transcription output stopped.

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

This is not 30-second latency in the traditional sense — the transcription pipeline is buffering ~30 seconds of transcript tokens and flushing them all at once. From the user's perspective, captions are silent for 30 seconds then catch up rapidly, then silent again. Impossible to follow in real-time.

### Degradation onset

The drop from 79 display updates/minute (07:04) to 15 (07:05) to 0 (07:06) happened over approximately 90 seconds, starting at **07:04:30–07:05:00 UTC**. In User 3's local time (Stockholm, UTC+1 in late March = CET), this is approximately **08:04–08:05 AM local**.

The user filed the report at **12:37 AM local time** (UTC 07:37). Given the degradation started at ~07:05 UTC and the report was filed at 07:37, they experienced approximately **32 minutes** of degraded captions before filing.

---

## Findings

### 1. Audio path was healthy throughout

UDP audio stats appear every 10 seconds without interruption from 07:00 to 07:39. The phone was encoding and sending audio correctly. The cloud was receiving it. The Soniox stream was receiving input.

### 2. Transcription output flatlined at ~07:04–07:05 UTC

Within 90 seconds, captions output dropped from ~75/minute to zero. This is abrupt — not a gradual degradation. It does not match any client-side state change (no WebSocket disconnect, no BLE event visible in the cloud logs at this time). The most likely cause is Soniox stream degradation: either Soniox stopped returning tokens, the stream disconnected silently, or the transcript routing between Soniox and the captions app stalled.

### 3. Soniox stream disconnect is not surfaced as an error in these logs

The cloud logs for this incident do not contain `Soniox stream error`, `STREAM CLOSED`, or `Disposing Soniox provider` events in the 07:04–07:08 window (unlike issue 051, where `Soniox translation provider disposed` is visible). This suggests the stream stayed "open" from the cloud's perspective but stopped producing output — a silent failure mode. Either Soniox's upstream was degraded but the SDK stream object remained alive, or the token-forwarding path between Soniox and the captions app subscription had an internal queue that backed up.

### 4. The burst flush pattern confirms transcript backlog, not network gap

If the 30-second gap were a network issue (phone → cloud), UDP audio would also be interrupted. It wasn't. If it were a cloud → glasses display issue, we'd see the display delivery fail. We don't — every `Display sent successfully` completes cleanly once it arrives. The burst pattern (silence → flood → silence) is characteristic of a transcript buffer filling up and being flushed at once, likely when the Soniox stream briefly recovered or when the captions app's internal queue was flushed.

### 5. `enforce_local_transcription: true` may be masking the real source

User 3 has `enforce_local_transcription: true` on their phone. If local Sherpa ONNX transcription were actually being used by the captions app, the Soniox degradation would have no effect. The fact that captions output still dropped (as confirmed by BetterStack) means either:

- The captions app is subscribed to Soniox regardless of `enforce_local_transcription` on the phone, and the phone setting only affects the phone's own local transcript stream
- OR local transcription results are routed through the same cloud pipeline that stalled

This is not currently clear from the code and needs to be traced. If `enforce_local_transcription` is supposed to bypass Soniox for the captions app and it isn't, that's a separate bug.

### 6. Self-resolving behavior indicates temporary upstream degradation

User 2 reported the issue self-resolved after ~20 minutes. This is consistent with a Soniox service degradation that recovered, not a permanent configuration issue. The team confirmed they were "fixing" something in the same window.

### 7. No cloud error logs surfaced for this event

The cloud logs in the incident report (89 total) show no errors related to transcription, Soniox, or stream health during the degradation window. Whatever happened either failed silently at the Soniox SDK level or was not instrumented with error logging.

---

## Conclusions

| Finding                                                                             | Severity | Confidence                                                          |
| ----------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| Cloud-side transcription pipeline degraded on March 23–24                           | High     | High — multi-user, team confirmed                                   |
| Soniox stream produced no output for ~3–30 minutes while staying "open"             | High     | High — BetterStack confirms zero captions output while audio flowed |
| Silent failure mode: no error logged when stream stops producing                    | High     | High — 89 cloud logs, zero transcription errors                     |
| `enforce_local_transcription: true` may not actually bypass Soniox for captions app | Medium   | Medium — needs code trace                                           |
| Burst flush pattern = transcript buffer backlog, not network gap                    | Medium   | High — UDP stats uninterrupted throughout                           |

---

## What We Don't Know

1. What specifically failed on the Soniox side or in the cloud's Soniox SDK integration during this window.
2. Whether any other users were affected and at what scale (no aggregate query run yet).
3. Whether the captions app uses Soniox regardless of `enforce_local_transcription`, and what that setting actually controls end-to-end.
4. Whether there is any Soniox-side monitoring or webhook that would have surfaced this.

---

## Next Steps

1. **Add silent stream detection**: If a Soniox stream has been open for >60s with 0 tokens returned while audio is actively flowing (`hasMedia=true`, UDP packets arriving), log a warning and consider stream restart. This is the watchdog discussed in issue 051 and applies here too.
2. **Trace `enforce_local_transcription` end-to-end**: Does it affect what the captions app subscribes to? Does it bypass the Soniox stream? If not, the setting is misleading.
3. **Check Soniox status history for March 23–24**: If Soniox has a status page or internal alerting, correlate their incident timeline with our degradation window (07:04–07:27 UTC on March 24).
4. **Aggregate impact query**: Query BetterStack for all users with zero display updates + active UDP audio in the 07:00–07:30 window to understand how many sessions were affected.
5. **Add error logging to Soniox token pipeline**: If the stream stops producing tokens, it should surface as a warn/error, not silence.
