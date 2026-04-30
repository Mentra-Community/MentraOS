# Design: Cloud Pod Event-Loop Stall Cascade — Phase 1 Implementation (Revised)

## Overview

**What this doc covers:** File-by-file implementation plan for the observability changes in [spec.md](./spec.md). All code-level changes (S1-S6) land in one PR; the K8s liveness widening (S8) is applied separately via Porter dashboard.

**What you need to know first:** [spike.md](./spike.md), [spike-independent-2026-04-23.md](./spike-independent-2026-04-23.md), [implementation-review-2026-04-23.md](./implementation-review-2026-04-23.md), [spec.md](./spec.md).

**What changed from the v1 design:** Per Codex's review:

- S2 expanded from "fan-out only" to per-substage timing inside `processAudioData`
- `userIdHash` correlation key added to `slow-audio-fanout`
- `gapStartedAtMs` added to heartbeat-gap payload
- Vitals self-timing reuses captured session count instead of re-scanning
- Natural-GC observer gated behind a runtime support check (Bun does not support `gc` PerformanceObserver entries today)
- New: pod-level UDP counter deltas in vitals
- S6 (was: probe widening) renamed to S8 with documented tradeoffs; readiness widening dropped

**Who should read this:** PR reviewers; the engineer on call after the next us-central crash who will read these logs.

---

## Branch Plan

One PR for code (S1-S6). Liveness widening (S8) is platform config, applied through Porter UI separately to keep blast radius bounded.

Branch: `cloud/pod-loop-stall-cascade` off `origin/dev`. Already created.

---

## Changes Summary

| Component                                      | File                                                                                    | Change                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| S1: Slow audio handler/batch log               | `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts`                               | Per-invocation timer + `slow-audio-call` warning (already implemented in v1)                                                 |
| S2: Audio substage timings                     | `cloud/packages/cloud/src/services/session/AudioManager.ts`                             | Per-substage timers in `processAudioData` + `op_audio_*_ms` cumulative + `slow-audio-stage` outlier warnings                 |
| S3: Fan-out instrumentation w/ correlation key | `cloud/packages/cloud/src/services/session/AudioManager.ts`                             | Wrap `relayAudioToApps` + `slow-audio-fanout` warning, payload includes `userIdHash`                                         |
| S4: Heartbeat tick + gap-start timestamp       | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`                       | 500ms `setInterval`, log gaps > 1s, payload includes `gapStartedAtMs`                                                        |
| S5: logVitals self-timing (clean)              | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`                       | Wrap body in `performance.now()` brackets, reuse already-captured session count                                              |
| S6: Pod-level UDP counter deltas               | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts` + `UdpAudioServer.ts` | UdpAudioServer exposes `getStatsSnapshot()`, vitals computes deltas                                                          |
| S7: Natural-GC observer (gated)                | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`                       | Check `PerformanceObserver.supportedEntryTypes`; install only if `gc` supported, otherwise log `natural-gc-unsupported` once |

Estimated diff: ~200 lines added, ~10 lines modified, 3 files. No deletions.

---

## S1: Slow UDP Audio Handler / Batch Log

### File: `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts`

Already implemented in v1. No code changes needed in the revised design — the implementation correctly times one handler invocation (which processes a reorder-buffer batch). Codex flagged a docs-vs-code mismatch (docs said "per iteration"); fixed in spec.md by clarifying this is "per handler invocation / batch."

The `packetsToProcess` field already in the log payload distinguishes "one expensive packet" from "large flushed batch."

No changes required to the v1 implementation of S1. Spec wording corrected.

---

## S2 + S3: AudioManager Substage Timings + Fan-out Correlation Key

### File: `cloud/packages/cloud/src/services/session/AudioManager.ts`

This is the largest change. Two parts:

#### Part A: Add substage timing constants and helper

```typescript
// Issue 102: per-substage outlier threshold for processAudioData stages.
// Each substage is sub-millisecond in steady state; 10ms = ~10× normal.
const SLOW_AUDIO_STAGE_MS = 10

type AudioStage = "lc3Decode" | "appFanout" | "transcriptionFeed" | "translationFeed" | "microphoneUpdate"
```

Also add a helper method on the class to record substage timings (cuts repetition):

```typescript
/**
 * Issue 102: record one substage's wall-time inside processAudioData.
 * Adds to cumulative operationTimers (op_audio_<stage>_ms appears in vitals)
 * and warns on outliers.
 */
private recordAudioStage(stage: AudioStage, durationMs: number, bytes: number): void {
  operationTimers.addTiming(`audio_${stage}`, durationMs);
  if (durationMs > SLOW_AUDIO_STAGE_MS) {
    this.logger.warn(
      {
        feature: "slow-audio-stage",
        stage,
        durationMs: Math.round(durationMs * 10) / 10,
        userIdHash: this.userIdHash(),
        bytes,
      },
      `Slow audio substage ${stage}: ${Math.round(durationMs)}ms`,
    );
  }
}

/**
 * Issue 102: privacy-preserving session correlation key matching the
 * userIdHash already used by UdpAudioServer (FNV-1a 32-bit hash of userId).
 * Cached so we don't recompute per audio packet.
 */
private cachedUserIdHash: number | null = null;
private userIdHash(): number {
  if (this.cachedUserIdHash !== null) return this.cachedUserIdHash;
  this.cachedUserIdHash = fnv1a32(this.userSession.userId);
  return this.cachedUserIdHash;
}
```

`fnv1a32` should reuse whatever helper UdpAudioServer uses. If none is exported, add a local copy or extract it. Implementation notes below.

#### Part B: Instrument substages in `processAudioData`

Wrap each substage call (LC3 decode, fan-out, transcription feed, translation feed, microphone update) in a `performance.now()` bracket and call `recordAudioStage`.

```typescript
async processAudioData(audioData: ArrayBuffer | any, source: "udp" | "legacy" = "udp") {
  if (this.disposed) return undefined;

  // ... existing packet counter logic ...

  try {
    this.userSession.lastAudioTimestamp = Date.now();
    if (audioData) {
      // ... existing buffer normalization ...
      if (!incomingBuf) return undefined;

      let buf: Buffer;
      if (this.audioFormat === "lc3" && this.lc3Service) {
        // S2: time LC3 decode
        const tLc3 = performance.now();
        try {
          const lc3ArrayBuffer = incomingBuf.buffer.slice(
            incomingBuf.byteOffset,
            incomingBuf.byteOffset + incomingBuf.byteLength,
          );
          const pcmArrayBuffer = await this.lc3Service.decodeAudioChunk(lc3ArrayBuffer);
          if (!pcmArrayBuffer || pcmArrayBuffer.byteLength === 0) {
            return undefined;
          }
          buf = Buffer.from(pcmArrayBuffer);
        } catch (decodeError) {
          this.logger.error(decodeError, "LC3 decode error");
          return undefined;
        } finally {
          this.recordAudioStage("lc3Decode", performance.now() - tLc3, incomingBuf.byteLength);
        }
      } else {
        buf = incomingBuf;
      }

      // ... existing PCM remainder logic ...
      if (buf.length === 0) return undefined;

      // S2: time app fan-out (relayAudioToApps internally has its own
      // slow-fanout warning via S3; the wrapper here is for cumulative bucket)
      const tFanout = performance.now();
      this.relayAudioToApps(buf);
      this.recordAudioStage("appFanout", performance.now() - tFanout, buf.length);

      // S2: time transcription feed
      const tTranscription = performance.now();
      this.userSession.transcriptionManager.feedAudio(buf);
      this.recordAudioStage("transcriptionFeed", performance.now() - tTranscription, buf.length);

      // S2: time translation feed
      const tTranslation = performance.now();
      this.userSession.translationManager.feedAudio(buf);
      this.recordAudioStage("translationFeed", performance.now() - tTranslation, buf.length);

      // S2: time microphone update
      const tMic = performance.now();
      this.userSession.microphoneManager.onAudioReceived();
      this.recordAudioStage("microphoneUpdate", performance.now() - tMic, buf.length);
    }
    return audioData;
  } catch (error) {
    this.logger.error(error, `Error processing audio data`);
    return undefined;
  }
}
```

**Note about LC3 timing semantics:** `lc3Service.decodeAudioChunk` is `await`ed, so the timer captures wall-clock not pure CPU. If the underlying implementation is sync (native binding, common case), the time IS event-loop blocking. If genuinely async, the duration includes time the loop spent on other handlers. Either reading is informative — large LC3 numbers correlated with `heartbeat-gap` events is the signal we want.

#### Part C: Add `userIdHash` to fan-out warning

Update `relayAudioToApps`'s finally block (already added in v1) to include the correlation key:

```typescript
} finally {
  const durationMs = performance.now() - t0;
  if (durationMs > SLOW_RELAY_MS || subCount > FANOUT_WARN) {
    this.logger.warn(
      {
        feature: "slow-audio-fanout",
        durationMs: Math.round(durationMs * 10) / 10,
        subscribers: subCount,
        bytes,
        userIdHash: this.userIdHash(),    // NEW: correlation key
      },
      `Slow audio fan-out: ${Math.round(durationMs)}ms across ${subCount} subscribers`,
    );
  }
}
```

#### Imports / new additions to AudioManager.ts

```typescript
import {operationTimers} from "../metrics/SystemVitalsLogger"
```

`operationTimers` is already exported from SystemVitalsLogger. New import.

For `fnv1a32`: check if `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts` already exports a hashing helper. If not, add a small inline implementation:

```typescript
/** FNV-1a 32-bit hash, matches the userIdHash used in UdpAudioServer. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash
}
```

**Verify** during implementation that this matches whatever produces `userIdHash` in UdpAudioServer (look at how the mobile client computes it for the UDP handshake — must match exactly). If the existing helper is in a shared module, prefer importing that.

---

## S4: Heartbeat Tick with `gapStartedAtMs`

### File: `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

The v1 implementation is correct except for the missing `gapStartedAtMs`. One-line addition to the payload:

```typescript
private startHeartbeat(): void {
  this.lastHeartbeatTick = Date.now();
  this.heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - this.lastHeartbeatTick;
    this.lastHeartbeatTick = now;

    if (elapsed > HEARTBEAT_GAP_THRESHOLD_MS) {
      const gapMs = elapsed - HEARTBEAT_INTERVAL_MS;
      logger.warn(
        {
          feature: "heartbeat-gap",
          gapMs,
          expectedMs: HEARTBEAT_INTERVAL_MS,
          actualMs: elapsed,
          gapStartedAtMs: now - elapsed,    // NEW: approximate trigger time
          rssMB: Math.round(process.memoryUsage().rss / 1048576),
          activeSessions: UserSession.getAllSessions().length,
        },
        `Heartbeat gap: ${gapMs}ms (expected ${HEARTBEAT_INTERVAL_MS}ms, actual ${elapsed}ms, started ~${new Date(now - elapsed).toISOString()})`,
      );
    }
  }, HEARTBEAT_INTERVAL_MS);
}
```

The log message also includes the human-readable trigger time so investigators reading raw logs (not just structured queries) see it without having to compute.

---

## S5: logVitals Self-Timing (Without Polluting the Measurement)

### File: `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

The v1 implementation calls `UserSession.getAllSessions()` a second time in the finally block. Per Codex: this adds noise to the measurement we're trying to take.

Fix: capture session count once at the top of `logVitals` (it's already captured for the body) and reference it in the finally block. Need to hoist `sessions.length` to a variable that's accessible from the finally block.

```typescript
private logVitals(): void {
  const vitalsT0 = performance.now();
  let sessionCountForLog = 0;    // NEW: captured for self-timing payload
  try {
    const memUsage = process.memoryUsage();
    const sessions = UserSession.getAllSessions();
    sessionCountForLog = sessions.length;    // NEW: capture once
    const mongoStats = mongoQueryStats.getAndReset();

    // ... rest of body unchanged ...

  } catch (error) {
    logger.error(error, "Failed to log system vitals");
  } finally {
    const vitalsDurationMs = performance.now() - vitalsT0;
    const baseLog = {
      feature: "vitals-self-timing",
      durationMs: Math.round(vitalsDurationMs * 10) / 10,
      activeSessions: sessionCountForLog,    // NEW: reuse captured value, no second scan
    };
    if (vitalsDurationMs > VITALS_SELF_SLOW_MS) {
      logger.warn(baseLog, `⚠️ logVitals slow: ${Math.round(vitalsDurationMs)}ms`);
    } else {
      logger.info(baseLog, `logVitals: ${Math.round(vitalsDurationMs)}ms`);
    }
  }
}
```

If the body throws before the session scan happens, `sessionCountForLog` remains 0, which is fine — vitals threw, we know nothing.

---

## S6: Pod-Level UDP Counter Deltas

### File: `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts`

Expose a snapshot reader:

```typescript
/**
 * Issue 102: snapshot of all cumulative counters, for SystemVitalsLogger
 * to compute deltas per vitals window.
 */
public getStatsSnapshot(): {
  packetsReceived: number;
  packetsDropped: number;
  pingsReceived: number;
  packetsDecrypted: number;
  decryptionFailures: number;
  registeredSessions: number;
} {
  return {
    packetsReceived: this.packetsReceived,
    packetsDropped: this.packetsDropped,
    pingsReceived: this.pingsReceived,
    packetsDecrypted: this.packetsDecrypted,
    decryptionFailures: this.decryptionFailures,
    registeredSessions: this.sessionMap.size,
  };
}
```

Add this as a public method on the `UdpAudioServer` class, near `start()` / `stop()`.

### File: `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Import the singleton:

```typescript
import {udpAudioServer} from "../udp/UdpAudioServer"
```

Add a private field to hold the previous snapshot:

```typescript
// Issue 102: previous UDP stats snapshot for delta calculation per vitals window.
private prevUdpStats: {
  packetsReceived: number;
  packetsDropped: number;
  pingsReceived: number;
  packetsDecrypted: number;
  decryptionFailures: number;
} | null = null;
```

Inside `logVitals` (near where mongoStats is read), compute the UDP delta:

```typescript
// Issue 102: pod-level UDP counter deltas per 30s window
const udpStats = udpAudioServer.getStatsSnapshot()
const udpDelta = this.prevUdpStats
  ? {
      udpPacketsReceivedDelta: udpStats.packetsReceived - this.prevUdpStats.packetsReceived,
      udpPacketsDroppedDelta: udpStats.packetsDropped - this.prevUdpStats.packetsDropped,
      udpPacketsDecryptedDelta: udpStats.packetsDecrypted - this.prevUdpStats.packetsDecrypted,
      udpDecryptionFailuresDelta: udpStats.decryptionFailures - this.prevUdpStats.decryptionFailures,
    }
  : {
      udpPacketsReceivedDelta: 0,
      udpPacketsDroppedDelta: 0,
      udpPacketsDecryptedDelta: 0,
      udpDecryptionFailuresDelta: 0,
    }
this.prevUdpStats = {
  packetsReceived: udpStats.packetsReceived,
  packetsDropped: udpStats.packetsDropped,
  pingsReceived: udpStats.pingsReceived,
  packetsDecrypted: udpStats.packetsDecrypted,
  decryptionFailures: udpStats.decryptionFailures,
}
```

Then merge `udpDelta` and `udpRegisteredSessions: udpStats.registeredSessions` into the final `logger.info(...)` payload that emits the system-vitals row. (Find the existing `logger.info({...}, "system-vitals")` call near the bottom of `logVitals` and spread the new fields into the object.)

First-window edge case: `prevUdpStats === null` returns deltas of 0. That's correct — we have no baseline yet.

---

## S7: Natural-GC Observer — Gated Behind Runtime Support Check

### File: `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Replace v1's `startGcObserver()` with a runtime-checked variant:

```typescript
/**
 * Issue 102: install a natural V8 GC observer ONLY if Bun's PerformanceObserver
 * supports the 'gc' entryType. As of investigation 2026-04-23, Bun's
 * supportedEntryTypes is ["mark","measure","resource"] — no 'gc'. Installing
 * blindly would silently emit nothing, which would look like "no GC pauses"
 * post-deploy. Explicitly logging the unsupported state once at startup
 * preserves the signal that this instrumentation source is broken in this
 * runtime, so investigators don't misread the silence.
 */
private startGcObserver(): void {
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supported.includes("gc")) {
    logger.warn(
      {
        feature: "natural-gc-unsupported",
        supportedEntryTypes: supported,
      },
      `Natural GC observer NOT installed: 'gc' entryType not supported by this runtime`,
    );
    return;
  }
  try {
    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > NATURAL_GC_THRESHOLD_MS) {
          const memUsage = process.memoryUsage();
          logger.warn(
            {
              feature: "natural-gc",
              durationMs: Math.round(entry.duration * 10) / 10,
              kind: (entry as any).detail?.kind ?? "unknown",
              rssMB: Math.round(memUsage.rss / 1048576),
              heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
            },
            `Natural GC: ${Math.round(entry.duration)}ms`,
          );
        }
      }
    });
    this.gcObserver.observe({ entryTypes: ["gc"] });
    logger.info(
      { thresholdMs: NATURAL_GC_THRESHOLD_MS },
      `Natural GC observer started (logging GCs > ${NATURAL_GC_THRESHOLD_MS}ms)`,
    );
  } catch (err) {
    logger.warn({ err }, "Could not install natural GC observer");
  }
}
```

The `supportedEntryTypes` check is the new line: if `gc` isn't in the array, log the unsupported event and return without installing.

---

## S8: K8s Liveness Widening (Out of Code PR, Liveness Only)

Applied through Porter dashboard, NOT in this PR's code. Per spec.md, **only widen liveness, not readiness**:

- **Liveness:** `failureThreshold: 15 → 30`, `timeoutSeconds: 3 → 10`
- **Readiness:** unchanged (`failureThreshold: 5`, `timeoutSeconds: 5`)

Rationale repeated here for the operator: widening readiness keeps a stalled pod in the LB rotation, which on single-pod us-central means user-visible hangs instead of brief 503 bursts. We accept the 503 burst as the more recoverable failure mode until multi-pod lands.

Apply this AFTER S1-S6 have been deployed to one quiet region and validated.

---

## Constants and Imports Summary

### Added to `UdpAudioServer.ts`

```typescript
const SLOW_AUDIO_CALL_MS = 50 // (already present from v1)
```

Plus the new public method `getStatsSnapshot()`.

### Added to `AudioManager.ts`

```typescript
import {operationTimers} from "../metrics/SystemVitalsLogger"

const SLOW_RELAY_MS = 20 // (already present from v1)
const FANOUT_WARN = 10 // (already present from v1)
const SLOW_AUDIO_STAGE_MS = 10 // NEW

type AudioStage = "lc3Decode" | "appFanout" | "transcriptionFeed" | "translationFeed" | "microphoneUpdate"

// fnv1a32 helper if not already imported from elsewhere
```

### Added / changed in `SystemVitalsLogger.ts`

```typescript
import {PerformanceObserver} from "node:perf_hooks" // (already from v1)
import {udpAudioServer} from "../udp/UdpAudioServer" // NEW

const HEARTBEAT_INTERVAL_MS = 500 // (already from v1)
const HEARTBEAT_GAP_THRESHOLD_MS = 1_000 // (already from v1)
const VITALS_SELF_SLOW_MS = 500 // (already from v1)
const NATURAL_GC_THRESHOLD_MS = 100 // (already from v1)
```

No new external dependencies.

---

## Testing

### Local

1. `bun run lint` passes
2. `bun run typecheck` passes
3. `bun run test` passes
4. `bun run dev` boots cleanly. After ~30 seconds:
   - `feature="vitals-self-timing"` info log appears
   - Either `feature="natural-gc-unsupported"` (one entry at startup, expected on current Bun) OR `feature="natural-gc"` entries occasionally
   - No `heartbeat-gap` under idle dev
   - No `slow-audio-call` / `slow-audio-stage` / `slow-audio-fanout` under idle dev
5. Locally simulate a slow substage: temporarily inject a 100ms `setTimeout` await in one of the substages → confirm `slow-audio-stage` log fires with the right `stage` value

### Smoke (one quiet region first)

Deploy to us-east. After 30 minutes, run the smoke query from spec.md. Expect zero outlier warnings; confirm `vitals-self-timing` and `natural-gc-unsupported` (or `natural-gc`) appear at expected cadence.

### Acceptance (after one us-central crash)

Per spec.md acceptance section. Pull the trigger time from `gapStartedAtMs` in the heartbeat-gap log, then query the 90s window before that time across all Phase 1 features. Each hypothesis should be confirmable or ruleable.

---

## Risks and Open Questions

**Risk: `fnv1a32` reimplementation drift.** If we add a local `fnv1a32` in AudioManager.ts and UdpAudioServer.ts has its own, they could diverge. **Mitigation**: during implementation, check if UdpAudioServer exports a hashing helper. If yes, import. If no, extract to a shared util and import from both. Verify identical outputs against a known input before merge.

**Risk: substage timers add per-packet overhead.** ~5 `performance.now()` calls per audio packet. Each is ~50ns in Bun. At 100 pkt/s that's 25μs/sec total — negligible.

**Risk: outlier warnings flood logs during a cascade.** During an 80s blockage we might log thousands of `slow-audio-stage` entries. Acceptable: the post-incident query is filterable, the volume itself is information ("cascade of N entries" vs "1 pathological entry"). If volume is genuinely problematic, add a per-substage rate limiter in a follow-up.

**Risk: Bun adds `gc` PerformanceObserver support in a future version.** Then the gated install activates automatically. That's fine — that's the intended behavior. The gate just protects us from silent failure today.

**Risk: `getStatsSnapshot()` reads counters that aren't atomic.** Bun is single-threaded JS so number reads are atomic in JS semantics. No concern.

**Risk: probe widening encourages investigators to ignore the underlying cascade.** Mitigation: spec.md explicitly documents that S8 is a band-aid, not a fix; the K8s probe widening is paired with the explicit "resolve permanently via Phase 2 + multi-pod" in the operator-facing language.

---

## Summary

Six instrumentation additions across three files (~200 lines added, no behavior change). Probe widening (S8) handled separately via Porter UI, liveness-only for now. After one us-central crash cycle, the resulting logs answer:

1. **What time did the cascade start?** → `gapStartedAtMs` in heartbeat-gap (S4)
2. **What audio substage burned the time?** → op*audio*\*\_ms in vitals + `slow-audio-stage` warnings (S2)
3. **Cascade vs pathological vs fan-out?** → `slow-audio-call` shape + `slow-audio-fanout` count (S1, S3)
4. **What pod-level UDP load corresponded?** → udpPacketsReceivedDelta etc. in vitals (S6)
5. **Was vitals itself the trigger?** → `vitals-self-timing` (S5)
6. **Did natural GC contribute?** → `natural-gc` if Bun supports it; otherwise we know it's unmeasurable today (S7)

With those answers, Phase 2 designs the actual fix instead of guessing.
