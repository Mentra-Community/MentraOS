# Giga Lag Spec

## Overview

Our transcription latency detection is broken. It reports false positives (19+ minute "lag" when Soniox is actually healthy) and may miss real issues. We need to fix the metric calculation and add proper backlog handling.

## Problem

### Bug 1: Wrong Lag Metric

Current calculation in `SonioxTranscriptionProvider.ts`:

```typescript
const now = Date.now()
const streamAge = now - this.startTime
const transcriptLag = streamAge - latestEndMs // ❌ WRONG
```

This compares:

- `streamAge`: Wall-clock time since stream started
- `latestEndMs`: Timestamp from Soniox of where transcript is (relative to audio sent)

**The bug**: Wall clock keeps ticking during VAD gaps (silence), but no audio is sent. This creates phantom "lag" that doesn't exist.

Example:
| Event | Wall Clock | Audio Sent | Soniox Transcribed | Calculated "Lag" | Actual Lag |
|-------|------------|------------|-------------------|------------------|------------|
| Stream starts | 0s | 0s | 0s | 0s | 0s |
| User speaks | 10s | 10s | 10s | 0s | 0s |
| Silence (VAD off) | 30s | 10s | 10s | **20s** ❌ | 0s |

### Evidence From Logs

User report: "30+ second caption delay" at 4:00 PM PST Dec 4, 2025

Initial log analysis showed:

```
transcriptLagMs: 553,252 (~9 minutes)
```

But the REAL metric showed:

```
processingDeficitMs: 600-800ms  ✅ (healthy!)
```

For most of the session, Soniox was processing within 1 second. The "9 minute lag" was just accumulated VAD gaps.

### Bug 2: Real Lag Did Occur (But Different From Reported)

Deeper analysis revealed this user DID have real lag, but only for ~20 minutes:

| Time (PST) | `processingDeficitMs` (Real Lag) | `transcriptLagMs` (Reported) |
| ---------- | -------------------------------- | ---------------------------- |
| 3:03 PM    | 700ms ✅                         | 19s (false alarm)            |
| 3:27 PM    | 650ms ✅                         | 19 min (false alarm)         |
| 3:57 PM    | 5.3s ⚠️                          | 9.5 min                      |
| 3:58 PM    | **37s** 🔴                       | 9.4 min                      |
| 4:00 PM    | **123s** 🔴                      | 9.2 min                      |
| 4:18 PM    | 2.6s ✅                          | 7.4 min (recovered)          |

**Key finding**: At 4:00 PM, real lag was ~2 minutes - but the reported metric was LOWER (9 min vs the earlier 19 min false alarms).

### Bug 3: Per-Stream Issue, Not Global Soniox

At exactly 4:00 PM UTC (when user reported issues):

| User              | Real Lag (avg)   | Real Lag (max) |
| ----------------- | ---------------- | -------------- |
| **Affected user** | **123,316ms** 🔴 | **140,360ms**  |
| Other user A      | 593ms ✅         | 780ms          |
| Other user B      | 575ms ✅         | 1,980ms        |
| Other user C      | 561ms ✅         | 700ms          |
| Other user D      | 550ms ✅         | 700ms          |

Only ONE user had real lag. Others were sub-second. This suggests per-stream backlog issue, not global Soniox degradation.

## Root Cause Analysis

### Why Real Lag Built Up For One User

Looking at the audio flow:

```
23:57:37 → audioSent: 395,700ms, transcriptEnd: 389,400ms, deficit: 6,300ms
23:58:07 → audioSent: 455,300ms, transcriptEnd: 422,700ms, deficit: 32,600ms
```

In 30 seconds of wall time, 60 seconds of audio was sent but only 33 seconds was transcribed. A burst of audio after silence overwhelmed Soniox's processing for this specific stream.

### Audio Density Comparison

| User              | Audio Sent | Stream Age | Density   |
| ----------------- | ---------- | ---------- | --------- |
| Healthy user A    | 2,610s     | 2,630s     | 99.3%     |
| Healthy user B    | 2,071s     | 2,075s     | 99.8%     |
| **Affected user** | 722s       | 1,132s     | **63.8%** |

Lower audio density = more VAD gaps = higher chance of audio bursts when speech resumes.

## Constraints

- Can't change Soniox behavior (third-party service)
- Must maintain real-time transcription (<1s target latency)
- Solution must work for all stream patterns (continuous speech, intermittent, etc.)

## Goals

1. **Fix lag detection** - Use `processingDeficitMs` as primary metric
2. **Accurate alerting** - Only alert on REAL lag (audio sent vs transcribed)
3. **Keep wall-clock metric** - Useful for debugging end-to-end latency
4. **Add backlog recovery** - Detect and handle stream backlog (future work)

## Non-Goals

- Fixing Soniox's processing speed (not in our control)
- Changing VAD behavior
- Real-time dashboard (just fix logging for now)

## Proposed Fix

### Change 1: Fix Primary Lag Metric

In `SonioxTranscriptionProvider.ts`, change:

```typescript
// BEFORE (wrong)
const transcriptLag = streamAge - latestEndMs
this.metrics.lastTranscriptLagMs = transcriptLag

// AFTER (correct)
const audioSentDurationMs = (this.metrics.totalAudioBytesSent || 0) / 32
const processingDeficit = audioSentDurationMs - latestEndMs
this.metrics.lastTranscriptLagMs = processingDeficit // This is the REAL lag
```

### Change 2: Update Warning Threshold

```typescript
// Alert on REAL lag, not phantom lag
if (processingDeficit > 5000) {
  this.logger.warn(
    {
      streamId: this.id,
      processingDeficitMs: Math.round(processingDeficit),
      audioSentDurationMs: Math.round(audioSentDurationMs),
      transcriptEndMs: Math.round(latestEndMs),
      wallClockLagMs: Math.round(streamAge - latestEndMs), // Keep for debugging
      provider: "soniox",
    },
    "⚠️ HIGH TRANSCRIPTION LATENCY - Soniox processing behind audio sent",
  )
}
```

### Change 3: Add Wall-Clock Metric Separately

Keep the old metric but rename it for clarity:

```typescript
this.metrics.wallClockLagMs = streamAge - latestEndMs // For debugging only
this.metrics.processingDeficitMs = processingDeficit // Real lag metric
this.metrics.lastTranscriptLagMs = processingDeficit // Used for health checks
```

## Future Work (Out of Scope)

### Backlog Recovery Mechanism

When `processingDeficitMs` exceeds threshold (e.g., 30s):

1. Log warning with stream details
2. Consider restarting stream to clear backlog
3. Investigate audio burst patterns that cause backlog

### Rate Limiting

When backlog detected:

1. Temporarily buffer audio instead of overwhelming Soniox
2. Gradually drain buffer when backlog clears

## Open Questions

1. **Threshold for "real lag" warning?**
   - Current: 5000ms (5 seconds)
   - Proposal: Keep 5000ms for processingDeficit
   - **Decision**: Start with 5s, adjust based on data

2. **Should we restart streams with high backlog?**
   - Pro: Clears backlog, gets fresh start
   - Con: Loses in-flight transcription
   - **Decision**: Defer to future work, just fix detection first

3. **What caused the audio burst for this user?**
   - Hypothesis: Long silence → sudden speech → burst
   - **Need more investigation** if it recurs

## Files to Change

- `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`
  - `processTranscriptionTokens()` - Fix lag calculation
  - `metrics` interface - Add `processingDeficitMs`, `wallClockLagMs`
- `packages/cloud/src/services/session/transcription/types.ts`
  - Update `StreamMetrics` interface
- `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`
  - Update `logLatencyMetrics()` to use correct metric
