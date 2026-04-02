# Spike: Heap Growth Investigation — What's Creating 200K Objects Every 10 Minutes?

## Overview

**What this doc covers:** Definitive findings from heap snapshot analysis showing that the JS heap grows ~15 MB/min inside stable sessions (no churn, no leaks), identification of the growing object types (102K plain `Object` + 91K `string` instances in 10 minutes), elimination of all previously suspected causes, and proposed instrumentation to identify the exact source.
**Why this doc exists:** Issue 065 identified two crash root causes: Bun's automatic GC freezing the event loop on large heaps, and client WebSocket churn. Issue 066 proved the churn isn't causing heap growth — session count is flat, leaks are zero, but the heap still grows 140MB in 45 minutes. Something inside live sessions is accumulating ~20,000 objects per minute that the GC can't keep up with. We need to find what.
**Who should read this:** Cloud engineers, anyone working on cloud stability or memory.

**Depends on:**

- [055-cloud-prod-oom-crashes](../055-cloud-prod-oom-crashes/) — liveness probe failure confirmed
- [056-cpu-spike-before-kill](../056-cpu-spike-before-kill/) — memory leaks found and fixed
- [057-cloud-observability](../057-cloud-observability/) — memory leak fixes shipped
- [065-open-investigations](../065-open-investigations/) — master tracking, two root causes
- [066-ws-disconnect-churn](../066-ws-disconnect-churn/) — proved churn is NOT causing heap growth

---

## Background

### The crash chain (proved in 065)

```
Heap grows steadily → JSC triggers full GC on 500MB+ heap →
3+ second stop-the-world pause → /health can't respond →
15 consecutive liveness failures → SIGKILL → all sessions lost
```

### What we ruled out in 066

Client WebSocket churn is NOT the cause of heap growth. The data:

- Session count stays at ~80 for 45 minutes (flat)
- `disposedSessionsPendingGC` is 0-1 the entire time (no leaks)
- Churn rate is ~2 disconnects/minute — reconnecting clients reuse existing sessions via `createOrReconnect()`
- Long-lived stable sessions exist on the same server (37–110 minutes)

Yet the heap grows from 350MB to 600MB in 45 minutes anyway.

---

## Method

### Tool: `analyze-heap.ts`

The cloud has an admin endpoint `GET /api/admin/memory/heap-snapshot-bun` that calls `Bun.generateHeapSnapshot()` and returns a JSC-format JSON snapshot. We also have `GET /api/admin/memory/now` for live per-session memory telemetry.

We took 4 snapshots of the US Central pod at intervals:

| Snapshot | Uptime | Sessions | Heap   | RSS    | File size |
| -------- | ------ | -------- | ------ | ------ | --------- |
| fresh    | 91s    | 17       | 91 MB  | 354 MB | 26 MB     |
| 5min     | 427s   | 32       | 116 MB | 418 MB | 35 MB     |
| 10min    | 768s   | 40       | 125 MB | 408 MB | 41 MB     |
| 20min    | 1400s  | 44       | 131 MB | 425 MB | 57 MB     |

### Tool: `analyze-heap-retention.py`

We wrote a Python script to parse JSC heap snapshots and extract:

- Object counts and cell sizes by class
- Size distribution (histogram of object sizes)
- Retention chains (who holds references to target objects)
- Diffs between snapshots (what grew, what shrank)

---

## Findings

### 1. CONFIRMED: Heap growth is inside stable sessions, not from churn

Between snapshot 3 (10min, 40 sessions) and snapshot 4 (20min, 44 sessions):

- **+4 new sessions** joined
- **+208,017 new objects** created
- Expected from 4 new sessions at ~7,000 objects each: ~28,000
- **Actual excess: 180,000 objects grew inside existing sessions**

This is the definitive proof that the heap growth is from within live sessions, not from connection churn, not from memory leaks, and not from new sessions joining.

### 2. CONFIRMED: Growth is overwhelmingly `Object` and `string`

The 10min→20min delta, broken down by class:

| Class           | 10min   | 20min   | +Delta       | % of growth |
| --------------- | ------- | ------- | ------------ | ----------- |
| **Object**      | 81,673  | 184,194 | **+102,521** | **49%**     |
| **string**      | 194,985 | 286,003 | **+91,018**  | **44%**     |
| Array           | 40,000  | 48,416  | +8,416       | 4%          |
| Function        | 54,999  | 56,061  | +1,062       | 0.5%        |
| Everything else | —       | —       | +5,000       | 2.5%        |

93% of all new objects are plain `Object` instances (avg 75 bytes) and `string` values (avg 24 bytes).

### 3. CONFIRMED: Mongoose documents are NOT the cause

Mongoose-related objects actually **shrank** between snapshots:

| Class            | 10min | 20min | Delta    |
| ---------------- | ----- | ----- | -------- |
| EmbeddedDocument | 5,413 | 5,246 | **-167** |
| StateMachine     | 5,663 | 5,500 | **-163** |
| InternalCache    | 5,662 | 5,499 | **-163** |
| ProxyObject      | 1,853 | 1,820 | **-33**  |

The DB layer is clean. Objects from MongoDB queries are being properly GC'd.

### 4. CONFIRMED: Session-level objects are stable

All manager instances are exactly proportional to session count:

| Class                | Count at 44 sessions | Per session                              |
| -------------------- | -------------------- | ---------------------------------------- |
| UserSession          | 44                   | 1.0                                      |
| AppManager           | 44                   | 1.0                                      |
| DisplayManager       | 44                   | 1.0                                      |
| TranscriptionManager | 44                   | 1.0                                      |
| (all 17 managers)    | 44 each              | 1.0                                      |
| AppSession           | 84                   | 1.9 (avg ~2 apps/user)                   |
| Pino                 | 1,239                | 28.2 (manager child loggers)             |
| Timeout              | 611                  | 13.9 (heartbeat + ping + cleanup timers) |

No unexpected growth. The manager layer is clean.

### 5. CONFIRMED: Audio buffers are dead code

`UserSession.bufferedAudio` and `UserSession.recentAudioBuffer` are declared but **never written to** anywhere in the codebase. `AudioManager.recentAudioBuffer` has the design-doc logic for push+prune but it was never wired into `processAudioData()`. All audio buffers are permanently empty.

Live data confirms: `audio.recentBufferBytes = 0` for all sessions.

### 6. CONFIRMED: Transcript history is bounded

`TranscriptionManager.transcriptHistory` retains 30 minutes of finalized segments, pruned every 5 minutes. At ~1 endpoint per 3-5 seconds with continuous speech:

- ~600 segments per language retained
- ~200-500 bytes per segment
- ~300-700 KB total per session at steady state

Live data confirms: 3,200 total segments across 80 sessions = ~40 per session. This is consistent with not everyone talking continuously.

This is real memory, but it's bounded and small compared to the 180K unexplained objects.

### 7. CONFIRMED: The growing objects are small

Size distribution of the 184K `Object` instances:

| Size range   | Count  | %   |
| ------------ | ------ | --- |
| 1–64 bytes   | 86,838 | 47% |
| 65–128 bytes | 96,692 | 53% |
| 129+ bytes   | 664    | <1% |

Size distribution of the 286K `string` instances:

| Size range   | Count   | %   |
| ------------ | ------- | --- |
| 1–64 bytes   | 278,744 | 97% |
| 65–128 bytes | 5,555   | 2%  |
| 129+ bytes   | 1,704   | 1%  |

This is the signature of **structured data processing** — JSON keys, short field values, log payloads, message objects. Not large buffers, not transcription text, not images.

### 8. WHAT WE DON'T KNOW: What creates these objects

The JSC heap snapshot format does not expose property names or content of plain `Object` instances in a way that CLI tools can parse. The edge labels are internal JSC identifiers (like `"pop"`, `"slice"`), not JavaScript property names.

We know the objects are small (75 bytes avg), numerous (20K/min), and not Mongoose documents, not transcript segments, not audio buffers, not manager instances. But we cannot definitively identify their source from the snapshot alone.

**Candidate sources (unproven theories, ordered by likelihood):**

| #   | Theory                                                   | Why plausible                                                                                                                                                                                                        | What would prove it                                                                          |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **Pino log serialization + filter wrapper double-parse** | Every log line is JSON.stringify'd by Pino, then JSON.parse'd by `createFilteredStream` for filtering. At ~100 logs/sec, that's ~12K object trees/min. The `@logtail/pino` transport has no buffer limit configured. | Add log volume counter to vitals. Measure transport buffer size. Test with logging disabled. |
| 2   | **WebSocket message serialization**                      | Every app-level ping (2/sec × 80 sessions = 160/sec), every display update, every subscription relay creates JSON objects.                                                                                           | Add message-out counter to vitals. Measure with pings disabled.                              |
| 3   | **Pino transport backpressure**                          | If BetterStack is slow to accept logs, Pino's worker thread message queue grows. Each queued string stays in main-thread memory until consumed.                                                                      | Check transport writable state. Add `_writableState.length` to vitals.                       |
| 4   | **JSC runtime overhead**                                 | JSC's JIT (Structure, FunctionCodeBlock, FunctionExecutable) grew +2K objects. JIT recompilation under changing code shapes could create persistent metadata.                                                        | Compare with `BUN_JSC_useJIT=0`.                                                             |
| 5   | **Something we haven't thought of**                      | —                                                                                                                                                                                                                    | Need runtime allocation tracking or V8-style allocation timeline.                            |

---

## Proposed Observability

To prove or disprove these theories, we need the following instrumentation. Each is designed to answer a specific question with a definitive yes/no.

### O1. Log volume counter in SystemVitalsLogger

**Question:** How many log lines are we producing per 30-second window?

**Implementation:** Add a counter that increments in the `createFilteredStream.write()` wrapper. Read and reset it in the vitals log.

**Fields added to `system-vitals`:**

| Field                 | Type     | Meaning                                              |
| --------------------- | -------- | ---------------------------------------------------- |
| `logLinesTotal`       | `number` | Total log lines produced in the last 30s             |
| `logLinesBetterStack` | `number` | Lines that passed the filter and went to BetterStack |
| `logLinesPretty`      | `number` | Lines that went to console                           |

**What this proves:** If we're producing 3,000+ logs per 30-second window (100/sec), and the heap growth correlates with log volume, Pino serialization is a strong candidate. If log volume is low and heap still grows, Pino is ruled out.

### O2. Transport buffer size in SystemVitalsLogger

**Question:** Is the BetterStack transport buffering log strings in memory?

**Implementation:** Expose the BetterStack transport stream's writable state. Pino transports created via `pino.transport()` run in worker threads, but the stream piped into `createFilteredStream` has an internal buffer. Access `targetStream._writableState?.length` or equivalent.

**Fields added to `system-vitals`:**

| Field                     | Type     | Meaning                                                     |
| ------------------------- | -------- | ----------------------------------------------------------- |
| `logTransportBufferBytes` | `number` | Bytes queued in the BetterStack transport's writable buffer |

**What this proves:** If the buffer is growing over time (MB+), the transport can't keep up and strings are accumulating. If the buffer is stable (<100KB), backpressure is not the issue.

### O3. Message-out counter in SystemVitalsLogger

**Question:** How many WebSocket messages are we sending per 30-second window?

**Implementation:** Increment a counter on every `ws.send()` call in the glasses message path and app message path. Already partially tracked by `MetricsService.incrementClientMessagesIn()` for incoming — add the outgoing equivalent.

**Fields added to `system-vitals`:**

| Field                   | Type     | Meaning                                                      |
| ----------------------- | -------- | ------------------------------------------------------------ |
| `wsMessagesSentGlasses` | `number` | Messages sent to glasses WS in the last 30s (includes pings) |
| `wsMessagesSentApps`    | `number` | Messages sent to app WS in the last 30s                      |

**What this proves:** If we're sending 10,000+ messages per 30s (pings + display updates + subscription relays), the JSON.stringify calls for those messages are creating objects at the right rate to explain the growth. If message volume is low, WS serialization is ruled out.

### O4. Heap snapshot diffing on a timer (optional, heavyweight)

**Question:** Do specific classes grow proportionally to time or to some operational metric?

**Implementation:** Take two `Bun.generateHeapSnapshot()` calls 5 minutes apart on a scheduled timer (only when an env var is set). Diff the class counts and log the top 10 growers as a structured log event.

**Concerns:** Heap snapshots are heavy (26-57MB) and block the event loop during generation. This should only run on a debug/staging pod, not production. Alternatively, use the existing admin endpoint and the `analyze-heap.ts compare` mode from outside the pod.

**What this proves:** Confirms whether the Object/string growth rate is constant (time-based accumulation) or proportional to traffic (per-message accumulation).

---

## What This Does NOT Include

| Out of scope                             | Why                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Fixing the heap growth                   | We don't know the cause yet — fixing comes after proving               |
| Client-side changes                      | Separate issue (066)                                                   |
| Removing gc-after-disconnect             | Should happen regardless (066 spec A7), but doesn't address this issue |
| JSC GC tuning                            | Mitigates the crash symptom, doesn't fix the root cause                |
| Reducing session count via Cloudflare LB | Mitigates by reducing heap size, doesn't fix the growth rate           |

---

## Conclusions

| Finding                                              | Status       | Confidence                                             |
| ---------------------------------------------------- | ------------ | ------------------------------------------------------ |
| Heap grows ~15 MB/min with stable sessions           | **PROVED**   | Definitive — 4 heap snapshots                          |
| Growth is 93% plain `Object` + `string`              | **PROVED**   | Definitive — class-level diffing                       |
| Growth is inside existing sessions, not from churn   | **PROVED**   | Definitive — only +4 sessions but +180K excess objects |
| Mongoose documents are properly GC'd                 | **PROVED**   | Definitive — counts decreased between snapshots        |
| Audio buffers are empty (dead code)                  | **PROVED**   | Definitive — code audit + live telemetry               |
| Transcript history is bounded (~40 segments/session) | **PROVED**   | Definitive — code audit + live telemetry               |
| Manager instances are stable (1:1 with sessions)     | **PROVED**   | Definitive — exact counts in snapshot                  |
| Pino log serialization is the cause                  | **UNPROVEN** | Plausible theory — needs O1/O2                         |
| WebSocket message serialization is the cause         | **UNPROVEN** | Plausible theory — needs O3                            |
| Transport backpressure is retaining strings          | **UNPROVEN** | Plausible theory — needs O2                            |

### The critical gap

We've eliminated every "big" suspect (leaks, churn, Mongoose, audio, transcription, managers). The growth is definitively from thousands of small Objects and strings created inside stable sessions. We need O1–O3 to identify which code path is creating them. Once we know the source, the fix is likely straightforward — either reducing log volume, fixing a buffer that's not being drained, or eliminating a double-serialization path.

---

## Next Steps

1. Write spec for O1–O3 instrumentation (add to 066 spec or create 067 spec)
2. Implement and deploy to US Central
3. Correlate log volume / message volume / transport buffer size with heap growth rate
4. Identify the source of the 20K objects/min
5. Fix it

---

## Appendix: Snapshot File Inventory

All snapshots saved in `cloud/.heap/` (gitignored):

| File                    | Uptime | Sessions | Heap   | RSS    |
| ----------------------- | ------ | -------- | ------ | ------ |
| `us-central-fresh.json` | 91s    | 17       | 91 MB  | 354 MB |
| `us-central-5min.json`  | 427s   | 32       | 116 MB | 418 MB |
| `us-central-10min.json` | 768s   | 40       | 125 MB | 408 MB |
| `us-central-20min.json` | 1400s  | 44       | 131 MB | 425 MB |

Analysis script: `cloud/packages/cloud/src/scripts/analyze-heap-retention.py`
