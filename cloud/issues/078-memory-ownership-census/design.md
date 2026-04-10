# Design: Memory Ownership Census

## Overview

**What this doc covers:** Implementation plan for the production-safe memory ownership census described in the 078 spec: shared types, estimator helpers, first-wave manager instrumentation, session aggregation, vitals logging, admin endpoint exposure, and CLI support.
**Why this doc exists:** The spec defines the behavior. This doc maps it to concrete files and rollout order so the implementation stays focused and reviewable.
**What you need to know first:** [078 spike](./spike.md) and [078 spec](./spec.md).
**Who should read this:** Whoever implements the PR.

## Changes Summary

| Component | File | What changes |
| --------- | ---- | ------------ |
| Shared types | `cloud/packages/cloud/src/services/metrics/memory-census.ts` | New `MemoryOwnerStat` and `MemoryStatsProvider` interfaces |
| Shared helpers | `cloud/packages/cloud/src/services/metrics/memory-estimate.ts` | String/JSON/array size estimators |
| Session aggregation | `cloud/packages/cloud/src/services/session/UserSession.ts` | `getMemoryCensus()` and direct session-owned stats |
| Transcription | `cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts` | Expose transcript history, VAD buffer, stream counts |
| Translation | `cloud/packages/cloud/src/services/session/translation/TranslationManager.ts` | Expose translation audio buffer, stream counts |
| Soniox provider | `cloud/packages/cloud/src/services/session/translation/providers/SonioxTranslationProvider.ts` | Expose utterance/pending-audio/token state |
| App audio | `cloud/packages/cloud/src/services/session/AppAudioStreamManager.ts` | Expose pending chunks and stream counts |
| Calendar | `cloud/packages/cloud/src/services/session/CalendarManager.ts` | Expose cached event counts/bytes |
| Dashboard | `cloud/packages/cloud/src/services/session/dashboard/DashboardManager.ts` | Expose content-map counts/bytes |
| App session | `cloud/packages/cloud/src/services/session/AppSession.ts` | Expose subscription history / set size |
| Metrics | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts` | Aggregate owners, compute deltas, log top owners and sessions |
| Admin API | `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts` | Add `memoryCensus` block to `/api/admin/memory/now` |
| CLI | `cloud/tools/bstack/bstack.ts` | Add `memory-owners` command |

## Shared Types

### `memory-census.ts`

This file should be deliberately tiny. It is a common contract, not a framework.

```typescript
export interface MemoryOwnerStat {
  owner: string;
  scope: "session" | "app-session" | "stream" | "global";
  itemCount: number;
  estimatedBytes: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SessionMemoryCensus {
  estimatedBytes: number;
  owners: MemoryOwnerStat[];
}

export interface MemoryStatsProvider {
  getMemoryStats(): MemoryOwnerStat[];
}
```

## Estimation Helpers

### `memory-estimate.ts`

Keep the helpers dumb and predictable:

```typescript
estimateStringBytes(str?: string | null): number
estimateJsonBytes(value: unknown): number
sumEstimatedBytes<T>(items: T[], fn: (item: T) => number): number
```

Rules:

- always prefer cheap estimators
- never recurse deeply by hand
- never traverse object graphs trying to be “exact”
- use payload size as the proxy

If a structure stores 5,000 transcript segments, the estimate should be dominated by the text and obvious scalar fields. That is good enough.

## Manager-Level Instrumentation

### `TranscriptionManager.ts`

Add `getMemoryStats()`.

#### Owners to emit

- `transcription.history.legacy`
- `transcription.history.{language}`
- `transcription.vad-audio-buffer`
- `transcription.streams`

#### Estimation

For transcript segments:

```typescript
estimatedBytes =
  sum(segments, (s) =>
    estimateStringBytes(s.text) +
    estimateStringBytes(s.resultId) +
    estimateStringBytes(s.speakerId) +
    64 // fixed scalar/object overhead proxy
  )
```

For `languageSegments`, emit one owner row per language. This matters because a single language may dominate.

For `vadAudioBuffer`, estimate with total `byteLength`.

### `TranslationManager.ts`

Add `getMemoryStats()`.

#### Owners

- `translation.audio-buffer`
- `translation.streams`

Estimate `audioBuffer` by summing `byteLength`.

### `SonioxTranslationProvider.ts`

Add `getMemoryStats()`.

#### Owners

- `translation.soniox.pending-audio`
- `translation.soniox.utterances.{language}`
- `translation.soniox.latency-measurements`

Utterance estimation should include:

- original token text bytes
- translation token text bytes
- token counts
- small fixed overhead per token

Do not serialize the entire token objects into JSON on every tick. Walk the in-memory arrays directly and count text lengths.

### `AppAudioStreamManager.ts`

Add `getMemoryStats()`.

#### Owners

- `app-audio.pending-chunks`
- `app-audio.streams`

Estimate pending chunks from their `byteLength`.

### `CalendarManager.ts`

Add `getMemoryStats()`.

#### Owner

- `calendar.events`

This should almost always be bounded and small. That is useful: the census will make it trivially exonerable.

### `DashboardManager.ts`

Add `getMemoryStats()`.

#### Owners

- `dashboard.main-content`
- `dashboard.expanded-content`
- `dashboard.always-on-content`
- `dashboard.system-content`

Estimate string content via `estimateStringBytes()`. For `Layout`, use guarded `estimateJsonBytes()`.

### `AppSession.ts`

Add `getMemoryStats()`.

#### Owners

- `app-session.subscription-history`
- `app-session.subscriptions`

Again, likely not dominant, but useful for eliminating suspicion.

## Session Aggregation

### `UserSession.ts`

Add:

```typescript
public getMemoryCensus(): SessionMemoryCensus
```

The method should:

1. build rows for direct session-owned fields
2. call `getMemoryStats()` on managers/providers that implement it
3. flatten everything into one list
4. sum `estimatedBytes`

#### Direct session-owned owners

- `user-session.buffered-audio`
- `user-session.audio-play-request-mapping`
- `user-session.app-health-cache`
- `user-session.loading-apps`

#### Important implementation note

Use feature detection, not hard interfaces everywhere:

```typescript
if ("getMemoryStats" in this.calendarManager) { ... }
```

This keeps the change incremental and avoids needing to thread a formal interface through every class declaration in one PR.

## SystemVitals Aggregation

### `SystemVitalsLogger.ts`

This is the heart of the feature.

#### New internal state

Add a previous-owner snapshot map:

```typescript
private previousOwnerBytes = new Map<string, number>();
```

Per tick:

1. iterate sessions
2. collect `getMemoryCensus()` from each
3. aggregate owner totals:
   - `owner -> estimatedBytes`
   - `owner -> itemCount`
4. compute deltas from `previousOwnerBytes`
5. sort and keep top N
6. update `previousOwnerBytes`

#### Top session derivation

For each session:

- total estimated bytes
- top 3 owners in that session

Then sort sessions descending and keep top 10.

#### New log fields

```typescript
memoryEstimatedSessionBytes
memoryOwnerCount
memoryTopOwners
memoryTopOwnerDeltas
memoryTopSessions
```

All complex structures should be JSON strings, same pattern as other vitals fields.

#### Growth warning

Add a small rate-limited helper:

```typescript
private memoryOwnerWarnCooldown = new Map<string, number>();
```

If an owner is both large and still growing, emit `feature: "memory-owner-growth"` no more than once every 10 minutes per owner.

## Admin Endpoint

### `admin.routes.ts`

Extend `/api/admin/memory/now`.

The response already returns process and session information. Add:

- aggregate census
- top sessions
- per-session owner rows

This should be the canonical debugging endpoint for humans and scripts.

## CLI

### `bstack.ts`

Add:

```bash
bstack memory-owners --region us-central --duration 2h
```

Suggested output shape:

```text
🧠 Memory Owners — us-central (last 2 HOUR)

Top owners by size:
owner                               bytes     items
transcription.history.en-US         126 MB    18422
translation.soniox.utterances.es     38 MB     4412

Top owners by growth:
owner                               delta
transcription.history.en-US         +11 MB
translation.audio-buffer            +0 MB
```

This command is intentionally log-based. It does not hit admin endpoints.

## Rollout Order

### Phase 1: Shared plumbing

1. `memory-census.ts`
2. `memory-estimate.ts`
3. `UserSession.getMemoryCensus()`

### Phase 2: Highest-value owners

1. `TranscriptionManager`
2. `TranslationManager`
3. `SonioxTranslationProvider`
4. `AppAudioStreamManager`

### Phase 3: Control owners

1. `CalendarManager`
2. `DashboardManager`
3. `AppSession`

### Phase 4: Surfaces

1. `SystemVitalsLogger`
2. `/api/admin/memory/now`
3. `bstack memory-owners`

## Testing

### Unit-level checks

- each `getMemoryStats()` returns stable owner keys
- zero-data cases return empty or zero rows
- bounded structures report bounded counts
- deltas are correct across consecutive vitals ticks

### Integration checks

- start one session, produce transcripts, verify `transcription.history.*` grows
- stop transcript traffic, wait for prune window, verify growth flattens or shrinks
- create translation activity, verify `translation.soniox.utterances.*`
- confirm `/api/admin/memory/now` includes the same owners seen in logs

### Success criteria

The feature is successful if, after one prod deployment, the next heap-growth investigation can identify one or two concrete owner families without taking manual snapshots first.

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| Too much CPU from estimation | Keep estimators shallow and payload-based; only inspect first-wave owners |
| Log bloat | Log only top owners and top sessions, not the full census |
| Misleading “exact bytes” interpretation | Call the field `estimatedBytes` everywhere |
| Implementation spread across too many classes | First wave only; expand later if needed |

## Decision Log

| Decision | Alternatives considered | Why we chose this |
| -------- | ----------------------- | ----------------- |
| Use per-manager `getMemoryStats()` methods | One giant introspector in `SystemVitalsLogger` | Ownership belongs with the class that owns the structure. |
| Estimate payload bytes instead of exact heap bytes | Deep heap walking / exact accounting | Exactness is not feasible in prod. Ranking and deltas are enough. |
| Expose full detail only on admin endpoint | Put everything in logs | Full census would bloat logs; endpoint is better for drill-down. |
