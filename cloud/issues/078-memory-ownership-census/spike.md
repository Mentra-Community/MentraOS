# Spike: Memory Ownership Census — Which Code Paths Own Heap Growth?

## Overview

**What this doc covers:** The missing observability layer between heap-shape data and root-cause fixes: a production-safe memory ownership census that attributes retained memory to specific managers, buffers, maps, arrays, and sessions.
**Why this doc exists:** Issue 077 tells us what heap object types are growing (`Object`, `string`, `Array`). It still does not tell us which code path owns those objects. That is the question the team actually needs answered to stop chasing one suspect at a time.
**What you need to know first:** [077-heap-diagnostics](../077-heap-diagnostics/) for heap-shape observability, [067-heap-growth-investigation](../067-heap-growth-investigation/) for the saved snapshots proving growth inside live sessions, and [075-heap-fragmentation-hot-path](../075-heap-fragmentation-hot-path/) for the allocation-churn hypothesis.
**Who should read this:** Cloud engineers, anyone touching observability, and anyone trying to make memory incidents diagnosable instead of anecdotal.

---

## The Problem in 30 Seconds

Today we can answer:

- Is RSS growing?
- Is heap growing?
- Is GC freeing anything?
- Are sessions stable?
- What heap object families dominate?

We still cannot answer the only question that matters for a fix:

**Which code path owns the retained memory?**

If the heap grows by 300MB/hour and the snapshots say `Object` + `string`, that is still too generic to act on. We need the cloud to say:

```text
Top owner growth, last 30m:
1. TranscriptionManager.transcriptHistory  +118MB
2. SonioxTranslationProvider.utterances    +41MB
3. AppAudioStreamManager.pendingChunks     +9MB
```

Without that ownership layer, every investigation becomes:

1. form a hypothesis
2. patch one suspect
3. deploy
4. wait
5. learn that heap still grows

That is the loop the team is frustrated with.

---

## What We Already Have

### Layer 1: Health / symptom observability

From issues 055–072, the cloud can already tell us:

- event-loop gaps
- GC probe duration and freed MB
- session counts
- WS churn and close codes
- MongoDB blocking totals
- RSS / heap / external / ArrayBuffer trends

This was necessary work. It ruled out a lot of bad theories and found real bugs.

### Layer 2: Heap-shape observability

Issue 077 adds:

- `heapStats().objectTypeCounts`
- protected object counts
- V8 snapshot support for Chrome comparison

This is also valuable. It answers: **what kinds of objects are growing?**

### What is still missing

Neither layer tells us:

- which manager owns the objects
- which sessions own the growth
- which in-memory structure grew between two ticks
- whether the growth is bounded cache behavior or an unbounded bug

That is Layer 3: **ownership attribution**.

---

## What The Existing Evidence Already Suggests

From the saved heap snapshots in `cloud/.heap/`:

- `us-central-10min.json` → `us-central-20min.json` shows growth dominated by `string` and `Object`
- session/manager instance counts scale normally with session count
- later snapshots show the same pattern at much larger scale: generic payload/state objects dominate, not runaway class instance counts

This strongly suggests the remaining issue is retained data inside healthy sessions, not “one extra manager leaked forever.”

That narrows the likely owners to:

- transcript history
- token/utterance buffers
- per-session caches
- pending chunk queues
- message/history arrays
- App/session relay payloads

But “likely” is not enough. We need hard numbers in prod.

---

## The Missing Dimensions

To make the issue diagnosable, the cloud needs to surface four dimensions it does not currently track:

### 1. Owner

Not “Object” or “string.”

Actual code owners like:

- `transcription.history.en-US`
- `transcription.history.fr-FR`
- `transcription.vad-audio-buffer`
- `translation.audio-buffer`
- `translation.soniox.utterances`
- `calendar.events`
- `dashboard.main-content`
- `app-audio.pending-chunks`

### 2. Scope

We need to know whether the memory is:

- global (singleton/service-wide)
- per-session
- per-app-session
- per-stream/provider

### 3. Growth delta

Absolute size alone is not enough. The key signal is:

- current estimated bytes
- delta since last vitals tick
- high-water mark

The question is not just “what is big?” It is “what is still growing?”

### 4. Session attribution

If 12 out of 80 sessions own 80% of the growth, that changes the investigation completely. We need:

- top sessions by estimated memory
- top sessions by growth over last N ticks
- owner breakdown per top session

---

## Candidate Owners To Instrument First

These are the high-value, long-lived structures that are likely to explain `Object`/`string` growth and are cheap to measure.

### Transcription

- `TranscriptionManager.transcriptHistory.segments`
- `TranscriptionManager.transcriptHistory.languageSegments`
- `TranscriptionManager.vadAudioBuffer`
- `TranscriptionManager.activeSubscriptions`

Why: transcript history literally stores strings and segment objects per session with 30-minute retention. It is a prime ownership candidate.

### Translation / Soniox

- `TranslationManager.audioBuffer`
- `SonioxTranslationProvider.pendingAudioChunks`
- `SonioxTranslationProvider.utterancesByLanguage`
- `SonioxTranslationProvider.latencyMeasurements`

Why: these hold token arrays, translated text fragments, and buffered audio during stream lifecycle gaps.

### App / relay path

- `AppAudioStreamManager.pendingChunks`
- `AppSession.subscriptionHistory`
- `UserSession.bufferedAudio`
- `UserSession.audioPlayRequestMapping`

Why: these are per-session retained queues/maps and are easy to make visible.

### Dashboard / calendar / misc caches

- `CalendarManager.events`
- `DashboardManager.mainContent`
- `DashboardManager.expandedContent`
- `DashboardManager.alwaysOnContent`

Why: likely not the main culprit, but good controls. They are bounded, so exposing them lets us quickly eliminate them from future incidents.

---

## What “Enough Observability” Actually Looks Like

A memory incident is diagnosable when one prod query can answer:

1. Which owner grew?
2. By how much?
3. In which sessions?
4. Since when?
5. What event correlated with the start?

Today we have:

- 4 and parts of 5

Issue 077 gives us:

- a weak version of 1 (“heap types”)

What we still need is:

- a strong version of 1 (“code owners”)
- 2
- 3

That is what this issue proposes.

---

## Conclusions

| Finding | Confidence |
| ------- | ---------- |
| The team is not back at square one | **Confirmed** — existing observability already ruled out multiple classes of failures |
| Issue 077 is useful but insufficient | **Confirmed** — heap shape is not the same as code ownership |
| The missing layer is ownership attribution, not more generic metrics | **High** |
| A production-safe census of long-lived structures is the shortest path to root cause | **High** |
| The census should focus on per-session retained structures first | **High** |

---

## Next Steps

1. Implement a `MemoryStatProvider` / ownership-census interface for high-suspicion managers first.
2. Add session-level aggregation to `UserSession`.
3. Log the top owners and top sessions in `system-vitals`.
4. Expose the full census in `/api/admin/memory/now`.
5. Add a `bstack` command for owner growth over time.
6. Use V8 snapshots only after the census points to a specific owner — snapshots become proof, not fishing.
