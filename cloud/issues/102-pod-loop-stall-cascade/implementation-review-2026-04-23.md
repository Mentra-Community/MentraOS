# Implementation Review: Phase 1 Observability PR

## Context

This review is for the uncommitted implementation currently on
`cloud/pod-loop-stall-cascade`. The implementation appears to follow the original
`spec.md` and `design.md` closely:

- `UdpAudioServer.ts`: adds `slow-audio-call`
- `AudioManager.ts`: adds `slow-audio-fanout`
- `SystemVitalsLogger.ts`: adds heartbeat gap, vitals self-timing, natural GC observer

Since those docs were written, an independent follow-up investigation captured in
`spike-independent-2026-04-23.md` changed the design context. The important new
evidence is that during the most recent us-central failure, HTTP/timers were
starved while UDP/audio logs continued. That makes the failure look less like a
complete event-loop freeze and more like UDP/audio monopolizing the loop.

Bottom line: this is a good first draft, but I would not ship it as-is. It will
confirm some useful facts, but it still leaves the highest-value question
ambiguous: which part of audio processing monopolizes the loop?

## Review Summary

Blocking concerns:

1. `PerformanceObserver` GC instrumentation probably does not work in Bun/JSC.
2. Audio instrumentation is too narrow; it times app fan-out but misses LC3,
   transcription, translation, and mic-update substages.
3. `slow-audio-fanout` omits the user/session identifier promised by the spec,
   making correlation with `slow-audio-call` much harder.

Non-blocking but important:

1. Heartbeat gap timestamps need explicit interpretation or a `gapStartedAt`
   field.
2. The S1 docs say "per iteration," but the implementation measures one UDP
   handler invocation/batch.
3. Some docs are stale (`spek.md`, transcript-history note, natural-GC
   expectations).

## Blocking Comments

### 1. Natural GC observer will likely be silent in Bun

**Files:**

- `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts:255-297`
- `cloud/issues/102-pod-loop-stall-cascade/design.md:383`
- `cloud/issues/102-pod-loop-stall-cascade/spec.md:S5`

The implementation installs a Node-style `PerformanceObserver` for
`entryTypes: ["gc"]`. The design says this may not emit on all Bun versions, but
the acceptance criteria still expect `natural-gc` to answer whether natural GC
caused the stall.

I tested the local Bun runtime:

```bash
bun -e 'import { PerformanceObserver } from "node:perf_hooks"; console.log(JSON.stringify(PerformanceObserver.supportedEntryTypes))'
```

It returned:

```json
["mark", "measure", "resource"]
```

A second local smoke test registering `entryTypes: ["gc"]`, forcing
`Bun.gc(true)`, and waiting briefly produced zero entries. `observe()` does not
throw, so this code will log "Natural GC observer started" and then probably
emit no `natural-gc` events. That is dangerous because post-deploy silence would
look like "no natural GC pauses," when the real meaning is "this instrumentation
source does not work."

Recommended change:

- Remove S5 from this PR, or gate it behind an explicit support check that logs
  `feature="natural-gc-unsupported"` when `gc` is absent from
  `PerformanceObserver.supportedEntryTypes`.
- If natural GC remains important, design a Bun/JSC-specific mechanism in a
  follow-up. Do not make `natural-gc` part of acceptance until it is proven to
  emit in the deployed runtime.

Suggested reviewer response:

> Please do not ship the GC observer as an acceptance signal until we prove it
> emits in Bun. Right now it can fail silently by logging "started" and then
> producing no events forever.

### 2. Audio instrumentation misses the likely expensive substages

**Files:**

- `cloud/packages/cloud/src/services/session/AudioManager.ts:265-338`
- `cloud/packages/cloud/src/services/session/AudioManager.ts:362-435`
- `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts:265-303`

The independent investigation suggests UDP/audio can monopolize the loop while
HTTP disappears. The current PR adds:

- outer UDP handler timing in `UdpAudioServer`
- app fan-out timing in `relayAudioToApps`

But `AudioManager.processAudioData` includes several other hot substages:

```ts
// AudioManager.ts
await this.lc3Service.decodeAudioChunk(...)
this.relayAudioToApps(buf);
this.userSession.transcriptionManager.feedAudio(buf);
this.userSession.translationManager.feedAudio(buf);
this.userSession.microphoneManager.onAudioReceived();
```

`relayAudioToApps` is only one of these. In the newest incident, the dangerous
load looked like aggregate active microphone/audio sessions, not an obvious
single app fan-out explosion. If Soniox `writeAudio`, transcription buffering,
LC3 decode, or mic updates are the expensive part, this PR can deploy, we can
wait for another crash, and still not know the culprit.

Recommended change:

Add substage timing inside `AudioManager.processAudioData`:

- `audio_lc3Decode_ms`
- `audio_normalize_ms`
- `audio_appFanout_ms`
- `audio_transcriptionFeed_ms`
- `audio_translationFeed_ms`
- `audio_microphoneUpdate_ms`

Log a structured `feature="slow-audio-stage"` warning when any stage crosses a
small threshold, and add cumulative operation timers for the same stages so the
next `system-vitals` row shows the breakdown.

Suggested reviewer response:

> The current implementation tells us whether app fan-out is bad, but it does
> not tell us whether transcription/translation writes or LC3 decode are bad.
> The next crash can still come back as "audioProcessing=80s" with
> `slow-audio-fanout=0`, which is not enough to choose Phase 2.

### 3. `slow-audio-fanout` cannot be correlated to `slow-audio-call`

**Files:**

- `cloud/packages/cloud/src/services/session/AudioManager.ts:423-432`
- `cloud/issues/102-pod-loop-stall-cascade/spec.md:S2`

The spec says the `slow-audio-fanout` payload includes:

```ts
{
  feature: "slow-audio-fanout",
  durationMs: <number>,
  subscribers: <length>,
  bytes: <buffer length>,
  userId: <session userId>,
}
```

The implementation logs only:

```ts
{
  feature: "slow-audio-fanout",
  durationMs,
  subscribers,
  bytes,
}
```

That omission matters. `slow-audio-call` logs `userIdHash`, while
`slow-audio-fanout` logs no user/session key. If fan-out warnings appear during
a crash, we cannot reliably tie them back to the UDP handler or the session.

Recommended change:

- Add a privacy-preserving session key to both logs. Prefer `userIdHash` if it
  is already available through the UDP path, or a stable hash of
  `this.userSession.userId`.
- If raw user IDs are acceptable in existing prod logs, at least match the spec
  and include `userId`; but for this incident I would prefer a hash.

Suggested reviewer response:

> Please include a correlation key on `slow-audio-fanout`. Without it, the log
> answers "some session had fan-out" but not "was it the same session whose UDP
> handler went slow?"

## Important Non-Blocking Comments

### 4. Heartbeat gap logs happen at recovery time, not trigger time

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts:231-252`

The heartbeat gap is useful, but the design language says it "pinpoints the
trigger moment with 500ms resolution." The log timestamp is actually when the
timer callback finally runs after starvation, not when starvation began.

For a gap log:

```ts
actualMs = elapsed;
gapStartedAtApprox = logTimestamp - actualMs;
```

Recommended change:

- Add `gapStartedAtMs` or `approxGapStartedAt` to the payload.
- Update the docs and query instructions to sort by approximate start time, not
  just log time.

Suggested reviewer response:

> Keep the heartbeat, but make the payload harder to misread. Otherwise the next
> investigator may look at logs immediately before the heartbeat log, which are
> recovery logs, not trigger logs.

### 5. S1 measures a handler invocation/batch, not a loop iteration

**Files:**

- `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts:265-303`
- `cloud/issues/102-pod-loop-stall-cascade/spec.md:S1`
- `cloud/issues/102-pod-loop-stall-cascade/design.md:25`

The spec says "when a single for-loop iteration takes more than
`SLOW_AUDIO_CALL_MS`." The code starts the timer before the loop and stops it
after the loop, so it measures one UDP handler invocation across the entire
`packetsToProcess` batch.

That might be the right measurement, but the docs should be precise:

- `packetsToProcess=1`, `duration=500ms` means one chunk was expensive.
- `packetsToProcess=10`, `duration=500ms` may mean ten ordinary chunks or one
  expensive chunk inside the batch.

Recommended change:

- Either move the timer inside the loop if true per-packet timing is needed, or
  rename the concept in docs/log text to "handler/batch duration."

Suggested reviewer response:

> The implementation and docs disagree here. Please either time each
> `audioChunk` or update the spec/design to say this is per handler invocation
> over a possible reorder-buffer batch.

### 6. Vitals self-timing does a second session scan

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts:648-652`

`logVitals()` already calls `UserSession.getAllSessions()` near the top. The
finally block calls it again to log `activeSessions`.

This is probably not a big cost, but the whole reason for S4 is to determine
whether vitals itself can be expensive. A second session lookup in the measured
finally block adds avoidable noise.

Recommended change:

- Capture `sessionCount` once if possible.
- If `logVitals()` throws before sessions are available, fall back to a safe
  `undefined` or a cheap map size accessor if one exists.

Suggested reviewer response:

> Minor, but avoid adding extra census work to the self-timing path we are
> trying to measure.

### 7. Probe widening should not be described as harmless

**Files:**

- `cloud/issues/102-pod-loop-stall-cascade/spec.md:S6`
- `cloud/issues/102-pod-loop-stall-cascade/design.md:S6`

Widening liveness/readiness thresholds may reduce restarts, but it changes the
failure mode. For an 80s audio starvation window, widening probes can keep the
same stuck single pod in rotation longer. Users may see hung requests/timeouts
instead of a shorter nginx 503/restart cycle.

Recommended change:

- Keep probe widening separate, as the design already says.
- Add a clearer operator warning: this is a mitigation with user-visible
  tradeoffs, not just a harmless survivability band-aid.
- Consider widening liveness only after code instrumentation lands; be more
  cautious with readiness.

Suggested reviewer response:

> Probe widening buys investigation time, but it can also route traffic to a pod
> that is not scheduling HTTP. Please document that tradeoff before applying it
> in Porter.

## Documentation Corrections

Please update these before handing the PR to reviewers:

- `design.md:7` links to `spek.md`; should be `spec.md`.
- `design.md:383` says Bun supports `gc` PerformanceObserver entries. Local
  evidence says this should be softened or removed.
- `design.md:505` mentions `transcription.history.en-US` retaining 1,843 items.
  Current code says transcript history was removed in issue 098.
- `spec.md:S2` includes `userId` in `slow-audio-fanout`; implementation does not.
- `spec.md:S5` acceptance expects `natural-gc`; that should not be an acceptance
  criterion until the runtime support is proven.

## Suggested Revised Phase 1 Scope

I would reshape Phase 1 as:

1. Keep `slow-audio-call`, but clarify it as handler/batch timing.
2. Add `slow-audio-stage` and cumulative operation timers inside
   `AudioManager.processAudioData`.
3. Keep `slow-audio-fanout`, but add a correlation key.
4. Keep `heartbeat-gap`, but include an approximate gap start timestamp.
5. Keep `vitals-self-timing`, with a small cleanup to avoid extra session scans.
6. Remove `natural-gc` or mark it explicitly unsupported until proven otherwise.
7. Add pod-level UDP counters to vitals if feasible:
   - packets received per interval
   - packets dropped per interval
   - active UDP sessions

That revised scope is still observability-only, but it is more likely to answer
the next question we actually need answered:

> Which exact audio substage monopolizes the event loop when us-central crosses
> the liveness-failure threshold?

## Review Verdict

Do not merge as-is.

The implementation is close to the original design, but the original design is
now stale against the latest evidence. If merged unchanged, it may confirm that
"audio is involved" yet still fail to identify whether the expensive work is LC3
decode, app fan-out, transcription feed, translation feed, or UDP scheduling.

Recommended next action: revise the implementation and docs together, then run a
small local smoke check for log shape before deploying to a quiet region.
