# Design: Soniox Node SDK Migration

## Overview

**What this doc covers:** File-by-file implementation plan for replacing `SonioxTranscriptionStream` with a thin wrapper around the official Soniox Node SDK (`@soniox/node`), including code structure, rollout order, and testing strategy.

**Why this doc exists:** The spec defines _what_ we're building. This doc defines _how_ — which files change, what the code looks like, and how we ship it safely.

**What you need to know first:** [spike.md](spike.md) (root cause), [spec.md](spec.md) (specification and acceptance criteria).

**Who should read this:** Anyone implementing or reviewing the SDK migration PR.

---

## Changes Summary

| Component         | File                                          | What changes                                                                           |
| ----------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Dependency        | `packages/cloud/package.json`                 | Add `@soniox/node`                                                                     |
| New file          | `providers/SonioxSdkStream.ts`                | New ~200-line SDK-based stream class                                                   |
| Modified          | `providers/SonioxTranscriptionProvider.ts`    | Add `SonioxNodeClient` singleton, wire up new stream class, keep old class behind flag |
| Modified          | `.env` / environment config                   | Add `SONIOX_USE_SDK=true/false` feature flag, verify `SONIOX_API_KEY`                  |
| Deleted (phase 2) | `SonioxTranscriptionStream` class (L257–1098) | Remove after SDK stream is proven                                                      |

Files that do NOT change:

- `TranscriptionManager.ts` — consumes `TranscriptionStream` interface, unaware of implementation
- `SubscriptionManager.ts` — no transcription logic
- `TranslationManager.ts` — unchanged for now (follow-up)
- Any app code (Captions, Flash, Merge, etc.) — consumes `TranscriptionData`, unchanged

---

## Phase 1: Install SDK and Verify Bun Compatibility

### Change 1: Add `@soniox/node` dependency

**File:** `packages/cloud/package.json`

Add to dependencies:

```json
"@soniox/node": "^1.x.x"
```

Run `bun install` and verify:

- Package resolves and installs
- `import { SonioxNodeClient, RealtimeSegmentBuffer, RealtimeUtteranceBuffer } from '@soniox/node'` compiles
- No Bun-specific WebSocket incompatibilities (the SDK uses standard `WebSocket` — Bun supports this)

**Verification:**

```typescript
import {SonioxNodeClient} from "@soniox/node"
const client = new SonioxNodeClient({api_key: process.env.SONIOX_API_KEY})
const session = client.realtime.stt({model: "stt-rt-v4"})
console.log("SDK loaded, session state:", session.state) // should print "idle"
```

---

## Phase 2: New Stream Class

### Change 2: Create `SonioxSdkStream.ts`

**File:** `packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts`

This is the core of the migration — a new class that wraps `RealtimeSttSession`, `RealtimeSegmentBuffer`, and `RealtimeUtteranceBuffer` behind the existing `TranscriptionStream`-compatible interface.

### Structure

```
SonioxSdkStream
├── Properties
│   ├── state, startTime, readyTime, lastActivity, lastError, metrics (same as old)
│   ├── session: RealtimeSttSession
│   ├── segmentBuffer: RealtimeSegmentBuffer
│   ├── utteranceBuffer: RealtimeUtteranceBuffer
│   └── currentUtteranceId: string | null
├── Constructor(streamId, subscription, callbacks, logger, client)
├── initialize() → connect session, wire events
├── writeAudio(chunk) → session.sendAudio(chunk)
├── forceFinalizePendingTokens() → session.finalize()
├── close() → session.finish() or session.close()
├── getHealth() → health snapshot
├── Event handlers (private)
│   ├── handleResult(result) → segmentBuffer.add, utteranceBuffer.addResult, emit interims
│   ├── handleEndpoint() → utteranceBuffer.markEndpoint, emit final
│   ├── handleFinalized() → flush buffers, emit final
│   ├── handleError(error) → callbacks.onError
│   └── handleDisconnected(reason) → callbacks.onClosed
└── Helpers (private)
    ├── generateUtteranceId() → utt_{timestamp}_{random}
    ├── buildInterimData(segment) → TranscriptionData
    ├── buildFinalData(utterance) → TranscriptionData
    └── parseSubscription(sub) → { language, targetLanguage, hints }
```

### Key implementation details

#### Session config derivation

The subscription string (e.g., `"transcription:en-US"`, `"transcription:auto"`, `"transcription:en-US?hints=ja"`) needs to be parsed into `SttSessionConfig`:

```
subscription: "transcription:en-US"
    → language_hints: ['en']
    → enable_language_identification: false

subscription: "transcription:auto"
    → language_hints: []
    → enable_language_identification: true

subscription: "transcription:en-US?hints=ja&target=es"
    → language_hints: ['en']
    → enable_language_identification: false
    → translation: { type: 'one_way', target_language: 'es' }
```

This reuses the same parsing logic currently in `sendConfiguration()` (L458–570), but outputs an `SttSessionConfig` object instead of a raw JSON message.

#### Interim emission from segments

When `segmentBuffer.add(result)` returns stable segments, each segment becomes an interim `TranscriptionData`. The key difference from the old code:

- **Old:** Every token batch rebuilds `stablePrefixText + tailText` and emits if changed
- **New:** Only stable segments (tokens confirmed by `final_audio_proc_ms`) are emitted

This means interims might arrive slightly less frequently (only when tokens are confirmed stable), but they'll never duplicate or fragment. For live captions, this is the right tradeoff — a 100–200ms delay on interims is imperceptible, while duplicate cards are very visible.

If we need more aggressive interim display (every token batch, including non-stable tokens), we can set `final_only: false` on the segment buffer and emit the full current text on every `result` event. The utteranceId will still be stable because we only rotate it on `endpoint`.

#### Utterance ID stability

This is the critical behavioral change. The utteranceId lifecycle:

```
[first token arrives] → generateUtteranceId() → "utt_1771560775304_a4zhjiz"
    ↓
[result events] → interims emitted with same utteranceId
    ↓
[endpoint event] → final emitted with same utteranceId
    ↓
[next token arrives] → generateUtteranceId() → "utt_1771560790000_new1234"
```

Speaker changes within an utterance do NOT generate new IDs. The `RealtimeSegmentBuffer` groups by speaker internally and returns separate `RealtimeSegment` objects per speaker, but they're all part of the same utterance until `endpoint` fires.

If Captions needs to visually distinguish speakers within an utterance, it can use `segment.speaker` — but the card itself (keyed by `utteranceId`) stays the same.

#### Translation handling (initial pass)

For the initial migration, translation streams are handled by passing `translation` config to the SDK session:

```typescript
if (targetLanguage) {
  config.translation = {
    type: "one_way",
    target_language: targetLanguage,
  }
}
```

Tokens with `translation_status === 'translation'` are the translated output. Tokens with `translation_status === 'original'` are the source transcription. We emit both with appropriate `StreamType` values.

This is a simplification over the current `TranslationManager` approach (which creates a separate Soniox stream for translation). If this works well, we can follow up by unifying transcription and translation into a single stream. For now, we keep `TranslationManager` as-is and only use SDK translation if the subscription explicitly requests it.

---

## Phase 3: Wire Up Provider

### Change 3: Modify `SonioxTranscriptionProvider`

**File:** `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`

#### Add client singleton

```typescript
import {SonioxNodeClient} from "@soniox/node"

class SonioxTranscriptionProvider {
  // ... existing fields ...
  private sdkClient: SonioxNodeClient | null = null

  async initialize(): Promise<void> {
    // ... existing initialization ...

    // Initialize SDK client
    if (process.env.SONIOX_USE_SDK === "true") {
      this.sdkClient = new SonioxNodeClient({
        api_key: process.env.SONIOX_API_KEY,
      })
      this.logger.info("Soniox SDK client initialized")
    }
  }
}
```

#### Feature-flagged stream creation

```typescript
async createTranscriptionStream(
    streamId: string,
    subscription: string,
    callbacks: TranscriptionStreamCallbacks,
): Promise<TranscriptionStream> {
    if (this.sdkClient && process.env.SONIOX_USE_SDK === 'true') {
        const stream = new SonioxSdkStream(
            streamId,
            subscription,
            callbacks,
            this.logger.child({ streamId, provider: 'soniox-sdk' }),
            this.sdkClient,
            this,
        );
        await stream.initialize();
        return stream;
    }

    // Fall back to old implementation
    const stream = new SonioxTranscriptionStream(/* ... existing ... */);
    await stream.initialize();
    return stream;
}
```

This lets us deploy with `SONIOX_USE_SDK=false` (old behavior) and flip to `true` per environment without a code change.

#### Dispose

```typescript
async dispose(): Promise<void> {
    // SDK client doesn't need explicit disposal — it's stateless
    this.sdkClient = null;
}
```

---

## Phase 4: A/B Testing (Optional but Recommended)

Before removing the old stream class, we can run both side-by-side:

### Change 4: Dual-stream comparison mode

**Controlled by:** `SONIOX_COMPARE_MODE=true`

When enabled, `createTranscriptionStream` creates BOTH an old `SonioxTranscriptionStream` and a new `SonioxSdkStream`, feeding audio to both. Only the new stream's output goes to apps. The old stream's output is logged for comparison.

```
Audio → [SDK Stream] → callbacks.onData (to apps)
     → [Old Stream] → log-only comparison
```

Key comparison metrics to log:

- Utterance count (should be fewer with SDK — no duplicates)
- Final text content (should match)
- Speaker attribution (should match)
- Latency difference (time from audio write to first interim)

This is a safety net, not a long-term feature. Remove after one dev cycle.

---

## Phase 5: Cleanup

### Change 5: Remove old stream class

Once SDK stream is proven on dev and staging:

1. Remove `SonioxTranscriptionStream` class (L257–1098)
2. Remove `SonioxApiToken` interface (L45–53)
3. Remove `SonioxResponse` interface (L55–62)
4. Remove `SONIOX_WEBSOCKET_URL` constant (L42)
5. Remove `SONIOX_USE_SDK` feature flag checks
6. Remove comparison mode code

Net change: **~840 lines deleted, ~200 lines added** = ~640 lines of net reduction.

---

## Testing

### Unit tests

| Test                                                                    | What it verifies                |
| ----------------------------------------------------------------------- | ------------------------------- |
| `SonioxSdkStream` constructs with valid subscription                    | Config parsing works            |
| `writeAudio` sends to session                                           | Audio path works                |
| `forceFinalizePendingTokens` calls `session.finalize()`                 | VAD integration works           |
| `close()` calls `session.finish()`                                      | Cleanup works                   |
| Mock `result` event → interim `TranscriptionData`                       | Data mapping correct            |
| Mock `endpoint` event → final `TranscriptionData`                       | Utterance boundary correct      |
| Two `result` events → same `utteranceId`                                | No duplicate IDs                |
| `endpoint` then `result` → new `utteranceId`                            | ID rotates on endpoint          |
| `result` with mixed speakers → segments per speaker, same `utteranceId` | Speaker change doesn't fragment |

### Integration tests (manual, dev server)

1. **Basic transcription**: Speak into glasses → verify live captions show smooth word-by-word updates, one card per utterance, no duplicates
2. **Speaker diarization**: Two people talking → verify different `speakerId` values, no rapid-fire card creation
3. **Long utterance**: Speak for 30+ seconds → verify single card grows, no fragmentation
4. **Silence/endpoint**: Speak, pause 2+ seconds, speak again → verify two cards (two utterances), clean boundary
5. **VAD stop**: Stop mic mid-sentence → verify `forceFinalizePendingTokens` triggers finalization, partial text emitted as final
6. **Reconnection**: Kill WebSocket mid-stream → verify error fires, `TranscriptionManager` recreates stream
7. **Multi-language**: Switch subscription to `transcription:auto` → verify language detection works
8. **Idle keepalive**: Leave session idle for 5+ minutes → verify session stays alive (no 1006 close)

### Regression checklist

- [ ] Captions app displays correctly (no duplicates, smooth updates)
- [ ] Flash app receives transcription data
- [ ] Merge app receives transcription data
- [ ] Any other transcription consumer works unchanged
- [ ] BetterStack logs show clean `result` → `endpoint` lifecycle (no `trigger: speaker_change` spam)
- [ ] Metrics dashboard still populated (`tokenBatchesReceived`, `audioChunksWritten`, etc.)

---

## Rollout

### Order

1. **Dev** (`SONIOX_USE_SDK=true`) — full testing, comparison mode enabled
2. **Staging** (`SONIOX_USE_SDK=true`) — team testing with real glasses
3. **Prod** (`SONIOX_USE_SDK=true`) — after staging sign-off

### Rollback

Set `SONIOX_USE_SDK=false` in environment → immediate rollback to old stream. No code change, no deploy. Old `SonioxTranscriptionStream` class stays in the codebase until we're confident enough to delete it (Phase 5).

### Timeline estimate

| Phase                              | Effort       | Dependencies           |
| ---------------------------------- | ------------ | ---------------------- |
| Phase 1: Install SDK, verify Bun   | 0.5 day      | None                   |
| Phase 2: New stream class          | 2–3 days     | Phase 1                |
| Phase 3: Wire up provider          | 0.5 day      | Phase 2                |
| Phase 4: A/B comparison (optional) | 1 day        | Phase 3                |
| Phase 5: Cleanup                   | 0.5 day      | After staging sign-off |
| **Total**                          | **3–5 days** |                        |

---

## Risks and Mitigations

| Risk                                                     | Likelihood | Impact | Mitigation                                                                                  |
| -------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| SDK WebSocket incompatible with Bun                      | Low        | High   | Phase 1 validates this before any other work                                                |
| `stt-rt-v4` model not available on our account           | Low        | Medium | Fall back to `stt-rt-preview`; check with Soniox                                            |
| `RealtimeSegmentBuffer` emits interims too slowly        | Medium     | Low    | Set `final_only: false` for more aggressive interims                                        |
| SDK has undocumented breaking changes                    | Low        | Medium | Pin version; feature flag allows instant rollback                                           |
| Translation via SDK config differs from current behavior | Medium     | Medium | Keep `TranslationManager` as-is for initial migration; translation unification is follow-up |
| Metrics gaps                                             | Low        | Low    | Map SDK events to existing metrics; accept some metrics are no longer meaningful            |

---

## Follow-up Work (Out of Scope)

These are potential improvements enabled by the SDK migration but not part of this issue:

1. **Translation unification**: Use SDK's built-in `TranslationConfig` instead of separate `TranslationManager` streams → fewer Soniox connections, simpler architecture
2. **Direct stream from client**: SDK supports temporary API keys for client-side WebSocket connections → potential to offload transcription from cloud entirely for some use cases
3. **Context enrichment**: SDK's `TranscriptionContext` supports `general` key-value pairs and `terms` — we could pass user-specific context (name, organization, domain terms) for better accuracy
4. **Two-way translation for conversations**: SDK's `two_way` translation config enables real-time bilingual conversation support
5. **Webhook integration**: SDK's `client.webhooks.handleHono()` could integrate with our Hono API layer for async transcription jobs
