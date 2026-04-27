# Spike: Kill Cloud-Side Transcript History (and Bring Translation Manager To Parity)

## Overview

**What this doc covers:** Why the cloud's per-session transcript history was a design mistake, what it costs us in memory and complexity, who actually consumes it, and what we replace it with (nothing — apps keep their own). Also covers the adjacent problem: the translation manager was not migrated to the Soniox Node SDK like transcription was, and it still has an append-only `utterancesByLanguage` map that leaks tokens between stream `end` events.

**Why this doc exists:** Production investigation on April 17, 2026 showed the France pod retaining ~19.7 MB of heap per session (vs ~6.2 MB/session on us-central), with V8's `heapTotal` pinned at ~1 GB and 52% fragmented. The 078 memory ownership census cannot explain most of the retained bytes, but it surfaced two real, fixable issues: (1) cloud-stored transcript history with no external consumer other than one REST endpoint, and (2) a Soniox translation stream with a language-keyed map of tokens that never gets cleared between `end` tokens. Both problems point the same direction: the cloud should stop storing transcript/translation state that apps can manage themselves.

**Who should read this:** Cloud engineers touching transcription, translation, memory, or the SDK. Anyone who was going to "shorten retention" to fix OOMs and ship it.

## Background

The cloud runs a per-`UserSession` `TranscriptionManager` that, in addition to relaying live transcription data to subscribed apps, also stores every final (and latest interim) segment it has seen in the last 30 minutes. This is kept in two parallel structures for historical reasons:

```
cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts

private transcriptHistory: {
  segments: TranscriptSegment[];                     // Legacy compatibility (en-US)
  languageSegments: Map<string, TranscriptSegment[]>; // Multi-language
}

private readonly HISTORY_RETENTION_MS = 30 * 60 * 1000;  // 30 minutes
private readonly HISTORY_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
```

Segments are appended in `addToTranscriptHistory()` from inside `relayDataToApps()` on every incoming transcription event, and pruned every 5 minutes by a timer. English is written to **both** `languageSegments.get("en-US")` and `segments[]` for legacy compatibility.

There is exactly one read path: `GET /api/transcripts/:appSessionId`, defined in `cloud/packages/cloud/src/api/hono/routes/transcripts.routes.ts`. No SDK helper wraps it. No mobile or glasses code calls it. First-party apps (`captions`, `line-width`, `mira`, etc.) do not call it — they keep their own history in-process.

Meanwhile, `TranscriptionManager` itself was migrated to the official Soniox Node SDK in issue 041 (`@soniox/node` via `SonioxSdkTranscriptionStream`), which handles rolling-window token dedup, utterance boundaries, and speaker diarization correctly. The **translation** side was not. `SonioxTranslationStream` in `cloud/packages/cloud/src/services/session/translation/providers/SonioxTranslationProvider.ts` still talks to Soniox over a raw WebSocket and hand-rolls utterance assembly via a `utterancesByLanguage: Map<sourceLang, { originalTokens[], translationTokens[], ... }>`.

## Findings

### 1. Cloud-side transcript history has exactly one REST endpoint, and only a small set of external apps call it

Repository audit of `getTranscriptHistory` / `/api/transcripts/` usage:

| Location                                                                          | Role                                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud/packages/cloud/src/api/hono/routes/transcripts.routes.ts`                  | The only producer of `GET /api/transcripts/:appSessionId`. Calls `userSession.transcriptionManager.getTranscriptHistory(language, timeRange)`. |
| `cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts` | Defines and manages `transcriptHistory`. Only internal caller is the route above.                                                              |
| `cloud/docs/api-reference/rest/transcripts.mdx`                                   | Docs page that already flags a path mismatch warning. No SDK example.                                                                          |

What does **not** use it (searched across `mobile/`, `android_core/`, `asg_client/`, `sdk_ios/`, `android_library/`, `cloud/packages/sdk/`, and the apps that live in this monorepo):

- **SDK**: no `getTranscripts()` or equivalent helper. The only related types are `TranscriptSegment` and `TranscriptI` in `cloud/packages/sdk/src/types/models.ts`. `TranscriptI` is never imported anywhere in the repo.
- **Mobile**: no `/api/transcripts/` fetches.
- **Glasses clients**: no REST reads of transcripts.
- **In-repo apps**: `captions` and `line-width` expose their own `GET /api/transcripts` and `GET /api/transcripts/stream` **inside their own app processes**, backed by their own in-app `TranscriptsManager`. These routes live at the app origin (not `api.mentra.glass`) and do not call into the cloud's history. They subscribe to the live transcription stream and keep their own buffer.

What **does** use it (from production BetterStack logs, last 24 hours):

| Package                       | Requests / 24h | Distinct users | Hosted in     |
| ----------------------------- | -------------- | -------------- | ------------- |
| `com.mentra.link` (LinkLingo) | 36             | 1              | external repo |
| `cloud.augmentos.mira` (Mira) | 8              | 1              | external repo |

Both are Mentra-published apps hosted outside this monorepo, so they were not caught by the repo-level grep. A 48-hour BetterStack sweep caught 2,751 requests to `/api/transcripts/*` from a `Bun/1.3.10` user-agent, dominated by LinkLingo. Volume is low, user counts are in the single digits, but the endpoint is not dead.

So: the cloud's `transcriptHistory` exists to feed one REST endpoint with two known callers, neither of which lives in this repo, both Mentra-owned. Killing the endpoint will break both apps unless they are refactored first to keep their own in-memory transcription history, the same way `captions` and `line-width` already do.

### 2. It is session-lifetime state pretending to be durable

Retention is 30 minutes, but the moment the WebSocket breaks and the `UserSession` is disposed (see issue 079), the history is gone. Consumers that treat `GET /api/transcripts/:appSessionId` as a lookup get:

- empty array when they hit a freshly-reconnected session
- stale-looking 30-min window otherwise
- no guarantee of continuity across reconnects

It is strictly worse than "apps keep their own," because it implies durability we do not provide. An app that wants history after a reconnect already has to buffer the live stream locally to cover the gap, at which point the cloud copy is redundant.

### 3. English is stored twice per session

`addToTranscriptHistory()` writes every English segment into both `languageSegments.get("en-US")` and the legacy `segments[]` array. This is the same double-counting flagged in the 078 audit ("English transcription ownership is incompletely modeled"). On every final segment the code pushes to two arrays, and on every interim replacement it pops/pushes both. This doubles the hot-path allocation for English, which is the dominant language.

### 4. Production: the memory cost is visible, even if the census underestimates it

Production snapshot on April 17, 2026 at ~17:30 UTC, comparing two pods:

|                    | us-central | france  |
| ------------------ | ---------- | ------- |
| active sessions    | 63         | 25      |
| process RSS        | 744 MB     | 1363 MB |
| V8 `heapTotal`     | 394 MB     | 1022 MB |
| V8 `heapUsed`      | 389 MB     | 493 MB  |
| heap fragmentation | 1%         | 52%     |
| heap per session   | 6.2 MB     | 19.7 MB |
| census attributed  | 684 KB     | 244 KB  |

France's V8 heap ceiling climbed to ~1 GB during a 12:00–13:30 UTC peak and did not come back down; this is what drives the crashes. The 078 ownership census attributes less than 0.1% of `heapUsed` to any owner it knows about, so transcript history is not "the" leak. But it is real: a single active user like `user-A` held 91 segments (~38 KB by census estimate) between two snapshots 5m37s apart, with every English segment duplicated in the legacy array.

The census estimator counts payload bytes. It undercounts real V8 retention because each `TranscriptSegment` object carries headers, `speakerId` / `resultId` strings, a `Date` instance per segment, and interim-vs-final transitions keep old references live during rope/substring reshaping. On a busy pod with heavy talkers the true retention is higher than the estimate, and it all gets kept for 30 minutes after the user stops speaking. Killing this path removes a known growth vector and narrows the hunt for whatever else is holding France's heap.

### 5. The translation manager did not get the Soniox SDK migration

The transcription side moved to `@soniox/node` in issue 041, which fixed the rolling-window-token bug and gave us correct utterance boundaries + speaker diarization. `SonioxSdkTranscriptionStream` is the production path.

`SonioxTranslationStream` (separate file, separate provider) was not migrated. It still:

- opens a raw WebSocket to Soniox directly
- collects tokens tagged by `sourceLang` into `utterancesByLanguage.set(sourceLang, { originalTokens: [], translationTokens: [], ... })`
- appends with `originalTokens.push(...)` / `translationTokens.push(...)` with **no size cap, no time-based eviction**
- only clears a language's utterance when that language produces a Soniox `end_token` (`clearLanguageUtterance(sourceLang)`) or when the whole stream is `close()`d

Production evidence this matters: a user's de→en translation stream reported `translation.soniox.utterances.en` at **3,868 items / 145,532 bytes, byte-for-byte identical across 43 vitals ticks (21+ minutes)** plus two on-demand `/api/admin/memory/now` snapshots ~6 minutes apart. Same stream ID, same tokens, no change, no clear. Meanwhile `utterances.de` (the actual source language) came and went correctly as end tokens arrived.

Reading the code, the mechanism is: Soniox tags translated output tokens with `translation_status: "original"` under a different sourceLang key than the one that emits end tokens. Any language key that receives tokens but never receives an `end_token` accumulates forever until the stream itself is closed. This is a real leak, ~150 KB per stream per orphaned language, and it also means our utterance boundary detection is hand-rolled and fragile in ways the Soniox SDK already solves.

### 6. Cost of keeping it is high; cost of removing it is low

Keeping `transcriptHistory`:

- retained heap on every active session for 30 minutes post-speech
- per-segment allocations on the hot path, doubled for English
- interim-vs-final pop/push on every token update
- a 5-minute prune timer that survives session disposal if not cleaned up
- one more "owner" the 078 census has to model, currently incorrectly
- ongoing code-maintenance cost

Removing it:

- 1 function to stop calling (`addToTranscriptHistory`)
- eventually 1 route file and 1 mount line
- a set of dead types and fields in `TranscriptionManager`
- ~1 docs page
- 0 SDK surface changes (the SDK never exposed this)
- 0 first-party app changes

## Conclusions

| Finding                                                                                                                                                                                              | Confidence                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Cloud-stored transcript history has exactly one consumer endpoint (`GET /api/transcripts/:appSessionId`)                                                                                             | **High** — full monorepo + mobile/glasses audit                      |
| The only callers measured in production are two Mentra-owned apps hosted outside this repo: LinkLingo (`com.mentra.link`) and Mira (`cloud.augmentos.mira`). Low volume, single-digit distinct users | **Confirmed from 24–48h BetterStack logs**                           |
| In-repo apps that need history already keep their own in-memory buffer (`captions`, `line-width`)                                                                                                    | **Confirmed**                                                        |
| English is double-stored per session, consistent with the 078 audit finding                                                                                                                          | **Confirmed from code**                                              |
| Transcript history is not the dominant France leak but is a real, removable growth source                                                                                                            | **High**                                                             |
| The translation manager missed the Soniox Node SDK migration that transcription got                                                                                                                  | **Confirmed from code (issue 041 scope)**                            |
| `SonioxTranslationStream.utterancesByLanguage` leaks tokens for any language that never emits an `end_token`                                                                                         | **Confirmed in production** (user-A, 21+ minutes of unchanged bytes) |

Recommendation: kill the cloud-side transcript history in three phases (spec will detail), and open a separate implementation issue to migrate `SonioxTranslationStream` to `@soniox/node` the same way transcription was migrated. The two are related (same kind of "cloud is caching speech state that belongs to the app or the provider SDK") but should ship on independent branches.

## Next Steps

1. Refactor LinkLingo (`com.mentra.link`) and Mira (`cloud.augmentos.mira`) out-of-repo to keep their own in-memory transcription history by subscribing to the live transcription stream, matching the pattern used by `captions` and `line-width`. This unblocks the endpoint removal without breaking either app.
2. `spec.md` — exact behavior changes, deprecation path for `GET /api/transcripts/:appSessionId`, phased rollout (stop writing → deprecate endpoint → delete), coordination with the two app refactors, and the split between the history kill and the translation migration.
3. `design.md` — file-by-file diff, test plan, rollout order.
4. New sibling issue (next number) for the Soniox translation SDK migration, referencing this spike and issue 041.
