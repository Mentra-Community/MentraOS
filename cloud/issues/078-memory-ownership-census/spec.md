# Spec: Memory Ownership Census

## Overview

**What this doc covers:** Exact specification for adding a production-safe memory ownership census to the cloud so we can attribute retained memory to specific managers, buffers, maps, arrays, and sessions.
**Why this doc exists:** Issue 077 tells us what heap types are growing. It does not tell us which code path owns them. This spec adds the missing ownership layer so the team can stop patching suspects one by one and start fixing proven owners.
**What you need to know first:** [078 spike](./spike.md), [077-heap-diagnostics](../077-heap-diagnostics/), and [067-heap-growth-investigation](../067-heap-growth-investigation/).
**Who should read this:** Anyone reviewing the implementation PR.

## The Problem in 30 Seconds

The cloud currently says:

```text
heapUsedMB = 612
heapTopTypes = { Object: 1005280, string: 1040017, Array: 152682 }
```

That is not enough to debug the issue. We need it to say:

```text
topOwners = {
  "transcription.history": 126_000_000,
  "translation.soniox.utterances": 38_000_000,
  "app-audio.pending-chunks": 9_000_000
}

topSessions = [
  { userId: "...", estimatedBytes: 42_000_000, topOwner: "transcription.history" },
  ...
]
```

This spec is diagnostics-only. It changes no runtime behavior.

## Spec

### A1. Add a shared ownership-census type

**New file:** `cloud/packages/cloud/src/services/metrics/memory-census.ts`

Add shared types used by all memory-stat providers:

```typescript
export interface MemoryOwnerStat {
  owner: string; // e.g. "transcription.history.en-US"
  scope: "session" | "app-session" | "stream" | "global";
  itemCount: number; // number of elements / entries / chunks
  estimatedBytes: number; // best-effort estimate, not exact heap size
  metadata?: Record<string, string | number | boolean | null>;
}

export interface MemoryStatsProvider {
  getMemoryStats(): MemoryOwnerStat[];
}
```

**Important:** `estimatedBytes` is intentionally approximate. This is a ranking tool, not a billing meter. The job is to identify the owners that are growing, not to perfectly model JSC internals.

### A2. Add lightweight estimator helpers

**New file:** `cloud/packages/cloud/src/services/metrics/memory-estimate.ts`

Add a tiny helper module with stable estimation functions:

- `estimateStringBytes(str)` → `Buffer.byteLength(str, "utf8")`
- `estimateJsonBytes(value)` → `Buffer.byteLength(JSON.stringify(value), "utf8")`, guarded with try/catch
- `sumEstimatedBytes(array, fn)`

**Rule:** estimate the payload size, not JSC overhead. Relative ranking matters more than exactness.

### A3. Add `getMemoryStats()` to high-value managers first

**Files:**

- `services/session/transcription/TranscriptionManager.ts`
- `services/session/translation/TranslationManager.ts`
- `services/session/translation/providers/SonioxTranslationProvider.ts`
- `services/session/AppAudioStreamManager.ts`
- `services/session/CalendarManager.ts`
- `services/session/dashboard/DashboardManager.ts`
- `services/session/AppSession.ts`

Each manager exposes its own owned structures as `MemoryOwnerStat[]`.

#### Required first-wave owners

**TranscriptionManager**

- `transcription.history.legacy`
- `transcription.history.{language}`
- `transcription.vad-audio-buffer`
- `transcription.streams`

Estimate transcript history using text length plus fixed per-segment overhead.

**TranslationManager**

- `translation.audio-buffer`
- `translation.streams`

**SonioxTranslationProvider**

- `translation.soniox.pending-audio`
- `translation.soniox.utterances.{language}`
- `translation.soniox.latency-measurements`

Estimate utterance size from token text and token count.

**AppAudioStreamManager**

- `app-audio.pending-chunks`
- `app-audio.streams`

**CalendarManager**

- `calendar.events`

**DashboardManager**

- `dashboard.main-content`
- `dashboard.expanded-content`
- `dashboard.always-on-content`
- `dashboard.system-content`

**AppSession**

- `app-session.subscription-history`
- `app-session.subscriptions`

### A4. Add session-level aggregation in `UserSession`

**File:** `cloud/packages/cloud/src/services/session/UserSession.ts`

Add:

```typescript
getMemoryCensus(): {
  estimatedBytes: number;
  owners: MemoryOwnerStat[];
}
```

This method:

1. asks each owned manager/provider for `getMemoryStats()`
2. flattens the results
3. prefixes metadata with session context as needed
4. returns total estimated bytes + per-owner breakdown

Also include direct session-owned structures:

- `user-session.buffered-audio`
- `user-session.audio-play-request-mapping`
- `user-session.loading-apps`
- `user-session.app-health-cache`

### A5. Add owner-growth tracking in `SystemVitalsLogger`

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Every vitals tick:

1. call `getMemoryCensus()` on every live `UserSession`
2. aggregate by owner name across sessions
3. compute per-owner delta from previous vitals tick
4. compute top sessions by estimated bytes

Add these new fields to `system-vitals`:

```typescript
memoryEstimatedSessionBytes;
memoryTopOwners; // JSON string: top 10 owners by estimatedBytes
memoryTopOwnerDeltas; // JSON string: top 10 owners by +deltaBytes since last tick
memoryTopSessions; // JSON string: top 10 sessions by estimatedBytes
memoryOwnerCount; // number of owner rows aggregated
```

**Shape examples**

```json
memoryTopOwners: {
  "transcription.history.en-US": 126349102,
  "translation.soniox.utterances.es": 38118220
}

memoryTopOwnerDeltas: {
  "transcription.history.en-US": 1142208,
  "translation.audio-buffer": 0
}
```

### A6. Add full census to `/api/admin/memory/now`

**File:** `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts`

Extend the response with:

```typescript
memoryCensus: {
  aggregate: {
    estimatedBytes: number,
    topOwners: Array<{ owner: string; estimatedBytes: number; itemCount: number }>,
    topOwnerDeltas: Array<{ owner: string; deltaBytes: number }>,
  },
  topSessions: Array<{
    userId: string,
    estimatedBytes: number,
    topOwners: Array<{ owner: string; estimatedBytes: number }>
  }>
}
```

And for each session object already returned by the endpoint, add:

```typescript
memory: {
  estimatedBytes: number,
  owners: MemoryOwnerStat[]
}
```

This is the main human-debugging surface. The log entry is for trends; the admin endpoint is for inspection.

### A7. Add growth thresholds and high-water marks

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Track high-water marks in-process:

- largest owner ever seen
- largest per-session estimate ever seen
- largest owner delta in one tick

If an owner crosses a threshold, emit a one-off warn log:

```json
{
  "feature": "memory-owner-growth",
  "owner": "transcription.history.en-US",
  "estimatedBytes": 73400320,
  "deltaBytes": 5242880,
  "userId": "..."
}
```

**Threshold rules**

- owner `estimatedBytes > 25MB`
- or owner `deltaBytes > 2MB` in one 30s tick

Rate-limit to once per owner per 10 minutes. This is a forensic breadcrumb, not spam.

### A8. Add `bstack memory-owners`

**File:** `cloud/tools/bstack/bstack.ts`

New command:

```bash
bstack memory-owners --region us-central --duration 2h
```

It queries `memoryTopOwners` and `memoryTopOwnerDeltas` from `system-vitals` and shows:

- top owners by size
- top owners by growth
- timestamps when growth accelerated

### A9. Non-goals

This issue does NOT include:

- automatic heap snapshots
- automatic process restarts
- behavior changes to managers or retention windows
- exact heap accounting

This issue is observability only.

## Decision Log

| Decision                                                     | Alternatives considered                  | Why we chose this                                                                             |
| ------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Add owner census as a new issue instead of expanding 077     | Fold ownership into 077                  | Heap shape and code ownership are different layers. Keeping them separate preserves clarity.  |
| Use best-effort byte estimates                               | Try to model exact JSC heap bytes        | Exact accounting is unrealistic and unnecessary. We need ranking and growth attribution.      |
| Instrument a high-value first wave of managers               | Try to census the whole codebase at once | Faster path to signal. The likely owners are already concentrated in session-scoped managers. |
| Put full detail on `/api/admin/memory/now`, not only in logs | Logs only                                | Logs are good for trends. Investigations need drill-down by session and owner.                |
| Add deltas, not just absolute sizes                          | Absolute sizes only                      | Root cause is about what is still growing, not only what is already large.                    |

## Testing

### Local verification

1. Start cloud locally with one or two sessions.
2. Hit `/api/admin/memory/now`.
3. Verify each session returns `memory.estimatedBytes` and owner rows.
4. Trigger transcript traffic, translation traffic, calendar events, and dashboard updates.
5. Verify the expected owners increase.
6. Dispose the session and verify the owner census drops to zero on the next tick.

### Production verification

After deploy:

1. Query `system-vitals` for `memoryTopOwners` and `memoryTopOwnerDeltas`.
2. Confirm the top owners are stable, interpretable names.
3. Compare owner growth against heap growth over 2–6 hours.
4. Use `/api/admin/memory/now` on a hot region to inspect the top sessions.

## Rollout

1. Ship 077 first if not already deployed.
2. Deploy 078 to one lower-traffic region or debug environment.
3. Verify log volume is acceptable.
4. Promote to prod.
5. Use `memory-owners` for the next live incident before making more behavioral fixes.

## Implementation Status

### Current branch status

As of April 1, 2026, the first implementation pass for 078 exists locally on branch `cloud/issues-078-memory-ownership-census`.

Relevant local commits:

- `5f79e9ed0` — `Implement issue 78 memory ownership census`
- `a7dee4042` — `Fix Hono route param type narrowing`

The cloud package currently builds successfully after the route type-cleanup pass.

### What is implemented

- Shared contracts in `memory-census.ts`
- Estimator helpers in `memory-estimate.ts`
- `getMemoryStats()` on:
  - `TranscriptionManager`
  - `TranslationManager`
  - `SonioxTranslationProvider`
  - `AppAudioStreamManager`
  - `CalendarManager`
  - `DashboardManager`
  - `AppSession`
- `UserSession.getMemoryCensus()`
- `SystemVitalsLogger` aggregation and `memoryTopOwners` / `memoryTopOwnerDeltas` / `memoryTopSessions`
- `/api/admin/memory/now` exposure via `MemoryTelemetryService`
- `bstack memory-owners`

### What differs from the original spec

- The admin endpoint now exposes aggregate census and per-session owner rows through `MemoryTelemetryService`'s snapshot shape. That preserved the existing endpoint pattern instead of wiring a second parallel aggregation path directly inside `admin.routes.ts`.
- The first implementation pass did not add top-owner deltas to `/api/admin/memory/now`; deltas currently exist in `system-vitals` logs, not in the admin endpoint response.
- The warning log for owner growth was implemented, but the exact threshold semantics need tightening before deploy.

## Audit Findings

### Findings from the first post-implementation audit

1. `memory-owner-growth` can attribute a growth event to the wrong session.
   - Current code logs the largest current holder for an owner, not necessarily the session that caused the recent delta.
2. `memory-owner-growth` is too eager for already-large owners.
   - An owner above the size threshold can still emit a growth-style warning on cooldown even if recent growth is negligible.
3. English transcription ownership is undercounted.
   - `TranscriptionManager` still retains English history in both `languageSegments` and the legacy `segments` array for compatibility, but the census only reports the legacy array when `en-US` is absent.
4. Dashboard estimation may add observable churn.
   - `DashboardManager` uses `JSON.stringify`-based estimation for layout content on each census tick. This is acceptable as a first pass but deserves scrutiny before prod deploy.

### What these findings mean

The implementation is directionally correct and useful, but the observability is not yet trustworthy enough to treat as final root-cause evidence. The next pass should improve signal quality before first deployment.

## Updated Decision Log

| Decision                                                                                | Alternatives considered                                    | Why we chose this                                                                                         |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Preserve the original 078 spec and append implementation status instead of rewriting it | Replace the spec with a post-hoc description of the branch | We want a record of both the intended design and the actual branch state.                                 |
| Route `/api/admin/memory/now` through `MemoryTelemetryService` for census exposure      | Duplicate aggregation logic in `admin.routes.ts`           | Reusing the existing snapshot path kept the implementation smaller and easier to verify.                  |
| Fix the pre-existing Hono route typing errors during the 078 branch work                | Leave unrelated build failures in place                    | A non-building branch makes regression review and deployment validation much harder.                      |
| Hold deployment until signal-quality findings are addressed                             | Deploy immediately and refine after observing prod         | The point of 078 is trusted ownership attribution. Shipping misleading alerts would undermine confidence. |

## Pre-Deploy Checklist

- `memory-owner-growth` only fires on meaningful positive growth.
- Owner growth logs identify the session that actually grew, not just the largest current holder.
- English transcription ownership is fully represented in the census.
- Dashboard estimation cost is reviewed and considered acceptable for `system-vitals`.
- `/api/admin/memory/now` and `bstack memory-owners` tell a consistent story for the same hot pod / time window.
- Log volume from new fields is acceptable in a staging or lower-traffic environment.

## Open Follow-Ups

- Add a stronger notion of per-session owner delta, not just aggregate owner delta.
- Decide whether `/api/admin/memory/now` should also expose owner deltas in addition to absolute estimated bytes.
- Decide whether some high-cost estimators should be cached or simplified before prod.
