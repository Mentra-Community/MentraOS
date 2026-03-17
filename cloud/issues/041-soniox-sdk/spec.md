# Spec: Soniox Node SDK Migration

## Overview

**What this doc covers:** Specification for replacing `SonioxTranscriptionStream` (raw WebSocket, ~840 lines) with a thin wrapper around the official Soniox Node SDK (`@soniox/node`), including exact event-to-data mappings, utterance lifecycle, translation handling, and acceptance criteria.

**Why this doc exists:** The spike confirmed that our manual token processing re-triggers speaker-change detection on every batch because Soniox delivers a rolling token window, not deltas. The SDK handles this correctly. This spec defines exactly what the migration looks like so we can implement without ambiguity.

**What you need to know first:** [spike.md](spike.md) — root cause analysis and SDK evaluation.

**Who should read this:** Anyone implementing or reviewing the Soniox SDK migration.

---

## The Problem in 30 Seconds

`SonioxTranscriptionStream.processTranscriptionTokens()` iterates all tokens in every WebSocket message assuming they're new. Soniox sends the full rolling token list (16 → 17 → 18 → 19... tokens per message). With diarization enabled, old Speaker 1 tokens replay every batch, triggering a false "speaker change" → new `utteranceId` → new card in Captions → 5+ duplicates per utterance. The Soniox Node SDK's `RealtimeSegmentBuffer` handles this internally and correctly.

---

## Spec

### 1. Dependency

Add `@soniox/node` to `packages/cloud/package.json`. Pin to a specific version (latest stable at time of implementation). Verify it installs and imports cleanly under Bun.

### 2. New class: `SonioxSdkTranscriptionStream`

Replaces `SonioxTranscriptionStream` (L257–1098 in `SonioxTranscriptionProvider.ts`). Implements the same interface so `SonioxTranscriptionProvider.createTranscriptionStream()` can return it without changes to `TranscriptionManager`.

#### 2.1 Construction

Accepts the same parameters as the current stream:

- `streamId: string`
- `subscription: string` (e.g., `"transcription:en-US"`)
- `callbacks: TranscriptionStreamCallbacks` (`onData`, `onError`, `onClosed`)
- `logger: Logger`
- `provider: SonioxTranscriptionProvider`

Internally creates:

- `SonioxNodeClient` (singleton per provider, not per stream)
- `RealtimeSttSession` via `client.realtime.stt(config)`
- `RealtimeSegmentBuffer` with `{ final_only: false, group_by: ['speaker', 'language'] }`
- `RealtimeUtteranceBuffer` with `{ final_only: true, group_by: ['speaker'] }`

#### 2.2 Session configuration

```
model: 'stt-rt-v4'          // verify availability; fall back to 'stt-rt-preview' if needed
audio_format: 'pcm_s16le'
sample_rate: 16000
num_channels: 1
enable_endpoint_detection: true
enable_speaker_diarization: true
enable_language_identification: <derived from subscription — true if auto mode>
language_hints: <derived from subscription — e.g., ['en'] for 'transcription:en-US'>
context: { terms: ['AugmentOS', 'Mentra', 'MentraOS'] }
```

For translation streams, add:

```
translation: {
    type: 'one_way',
    target_language: <target from subscription>
}
// OR for two-way:
translation: {
    type: 'two_way',
    language_a: <source>,
    language_b: <target>
}
```

#### 2.3 Event handling

##### `result` event → interim `TranscriptionData`

On every `result` event:

1. Feed `result` into `segmentBuffer.add(result)` → get stable `RealtimeSegment[]`
2. Feed `result` into `utteranceBuffer.addResult(result)` (accumulates for endpoint flush)
3. For each stable segment, build and emit an **interim** `TranscriptionData`:

```
{
    type: StreamType.TRANSCRIPTION,
    text: segment.text,
    isFinal: false,
    utteranceId: <derived from segment — see §2.4>,
    speakerId: segment.speaker || "0",
    confidence: <average of segment.tokens[].confidence>,
    startTime: formatTimestamp(segment.start_ms),
    endTime: formatTimestamp(segment.end_ms),
    transcribeLanguage: this.language,
    detectedLanguage: segment.language || this.language,
    provider: "soniox",
    metadata: {
        provider: "soniox",
        soniox: {
            tokens: segment.tokens.map(t => ({
                text: t.text,
                isFinal: t.is_final,
                confidence: t.confidence,
                start_ms: t.start_ms,
                end_ms: t.end_ms,
                speaker: t.speaker
            }))
        }
    }
}
```

4. Call `callbacks.onData(interimData)`

##### `endpoint` event → final `TranscriptionData`

On `endpoint` event:

1. Call `utteranceBuffer.markEndpoint()` → get `RealtimeUtterance | undefined`
2. If utterance exists and has text, build and emit a **final** `TranscriptionData`:

```
{
    type: StreamType.TRANSCRIPTION,
    text: utterance.text,
    isFinal: true,
    utteranceId: <current utteranceId — see §2.4>,
    speakerId: utterance.speaker || "0",
    confidence: <average of utterance.tokens[].confidence>,
    startTime: formatTimestamp(utterance.start_ms),
    endTime: formatTimestamp(utterance.end_ms),
    transcribeLanguage: this.language,
    detectedLanguage: utterance.language || this.language,
    provider: "soniox",
    metadata: { provider: "soniox" }
}
```

3. Call `callbacks.onData(finalData)`
4. Generate new `utteranceId` for next utterance

##### `error` event → error handling

1. Log error with stream context
2. Call `this.provider.recordFailure(error)`
3. Call `callbacks.onError(error)`

##### `disconnected` event → cleanup

1. Log reason
2. Call `callbacks.onClosed(reason)`

#### 2.4 Utterance ID management

**One utterance ID per endpoint-delimited utterance.** This is the critical fix.

- Generate `utteranceId` on first token of a new utterance: `utt_{timestamp}_{random}`
- Same `utteranceId` for ALL interims within that utterance
- Same `utteranceId` for the final emission at endpoint
- New `utteranceId` only after `endpoint` event fires and a new token arrives
- Speaker changes within an utterance do NOT generate new utterance IDs — the SDK's segment buffer handles speaker grouping internally

This replaces the current behavior where `startNewUtterance()` fires on every speaker-change detection (which fires every batch due to the rolling-window bug).

#### 2.5 VAD integration

`forceFinalizePendingTokens()` currently exists for VAD stop events. Map to:

```typescript
forceFinalizePendingTokens(): void {
    // SDK equivalent: request server-side finalization
    this.session.finalize();
    // The 'finalized' event will fire when server confirms,
    // at which point we flush the utterance buffer
}
```

On `finalized` event:

1. Flush `utteranceBuffer.markEndpoint()` → emit final if text exists
2. Flush `segmentBuffer.flushAll()` → emit any remaining segments

#### 2.6 Audio writing

```typescript
async writeAudio(chunk: Buffer): Promise<void> {
    if (this.session.state !== 'connected') return;
    this.session.sendAudio(chunk);
    this.metrics.audioChunksWritten++;
    this.metrics.totalAudioBytesSent += chunk.length;
}
```

No buffering, no manual error handling for individual writes — the SDK manages the WebSocket internally.

#### 2.7 Pause / Resume

Map to SDK's built-in pause/resume with auto-keepalive:

```typescript
pause(): void {
    this.session.pause();  // SDK sends keepalive automatically
}

resume(): void {
    this.session.resume();
}
```

Replaces our manual `startKeepalive()` / `stopKeepalive()` / `sendKeepalive()` (~45 lines).

#### 2.8 Lifecycle

```
initialize():
    await this.session.connect()
    // state: idle → connecting → connected

close():
    await this.session.finish()    // graceful: wait for remaining results
    // OR this.session.close()     // immediate cancel
    segmentBuffer.reset()
    utteranceBuffer.reset()
```

#### 2.9 Metrics preservation

Keep the existing `metrics` object. Populate from SDK events:

| Metric                 | Source                                                    |
| ---------------------- | --------------------------------------------------------- |
| `audioChunksWritten`   | Incremented in `writeAudio()`                             |
| `totalAudioBytesSent`  | Incremented in `writeAudio()`                             |
| `tokenBatchesReceived` | Incremented on `result` event                             |
| `lastTokenBatchSize`   | `result.tokens.length`                                    |
| `lastTokenReceivedAt`  | `Date.now()` on `result` event                            |
| `realtimeLatencyMs`    | `result.total_audio_proc_ms - result.final_audio_proc_ms` |
| `isReceivingTokens`    | `true` on `result`, `false` after timeout                 |

Metrics we can drop (no longer meaningful with SDK):

- `stablePrefixText` length tracking
- `processingDeficitMs` (SDK handles internally)

#### 2.10 Translation streams

The Soniox SDK supports translation natively via `SttSessionConfig.translation`:

- **One-way** (e.g., Japanese → English): `{ type: 'one_way', target_language: 'en' }`
- **Two-way** (e.g., English ↔ Spanish): `{ type: 'two_way', language_a: 'en', language_b: 'es' }`

Tokens come back with `translation_status: 'original' | 'translation'` and `source_language`.

This means we can potentially unify transcription and translation into a single stream with translation config, rather than maintaining separate `TranslationManager` streams. However, this is a **follow-up optimization** — for the initial migration, keep `TranslationManager` as-is and only replace the raw transcription path.

### 3. Provider changes

`SonioxTranscriptionProvider` (L64–252) changes minimally:

- Add a `SonioxNodeClient` singleton: `private client: SonioxNodeClient`
- Initialize in `initialize()`: `this.client = new SonioxNodeClient({ api_key: process.env.SONIOX_API_KEY })`
- In `createTranscriptionStream()`: return `new SonioxSdkTranscriptionStream(...)` instead of `new SonioxTranscriptionStream(...)`
- Keep `supportsSubscription()`, `supportsLanguage()`, `getLanguageCapabilities()`, `getHealthStatus()` unchanged
- Keep `recordFailure()` / `recordSuccess()` unchanged

### 4. What stays the same

- `TranscriptionManager` — no changes
- `SubscriptionManager` — no changes
- `TranscriptionStreamCallbacks` interface — no changes
- `TranscriptionData` type — no changes
- App-facing data format — no changes
- `TranslationManager` — no changes (follow-up)

### 5. What gets deleted

- `SonioxTranscriptionStream` class (L257–1098, ~840 lines)
- All manual WebSocket management (`ws`, `connectionTimeout`, `isConfigSent`)
- Manual `stablePrefixText` / `lastSentInterim` / `tailTokens` processing
- Manual `startKeepalive` / `stopKeepalive` / `sendKeepalive`
- Manual `sendConfiguration` (SDK handles via `SttSessionConfig`)
- `SonioxApiToken` and `SonioxResponse` interfaces (raw WebSocket protocol types)

---

## Acceptance Criteria

### Must have

1. **No duplicate cards**: Same utterance → same `utteranceId` across all interims and the final. New `utteranceId` only on endpoint.
2. **Speaker diarization works**: Different speakers get different `speakerId` values. Speaker changes don't cause utterance fragmentation.
3. **Interims update smoothly**: Text grows word-by-word within a single card (same `utteranceId`), not card-per-word.
4. **Finals emit once**: One final per endpoint, not one per token batch.
5. **VAD stop triggers finalization**: `forceFinalizePendingTokens()` causes the current utterance to finalize.
6. **Audio format accepted**: PCM s16le, 16kHz, mono works without conversion.
7. **Keepalive works**: Session stays alive during idle periods without manual intervention.
8. **Existing apps work unchanged**: Captions, Flash, Merge, and any other transcription consumer receive `TranscriptionData` in the same format.

### Should have

9. **Metrics populated**: `tokenBatchesReceived`, `audioChunksWritten`, `realtimeLatencyMs` still available for observability.
10. **Error recovery**: SDK reconnection or error → `callbacks.onError` fires → `TranscriptionManager` can recreate the stream.
11. **Logging parity**: Key events logged at same level as today (stream created, connected, first token, endpoint, error, closed).

### Nice to have

12. **A/B comparison mode**: Feature flag to run both old and new streams side-by-side, logging diffs without affecting app output.
13. **Model flexibility**: Ability to switch between `stt-rt-v4` and `stt-rt-preview` via env var.

---

## Decision Log

| Decision                                                      | Alternatives considered                | Why we chose this                                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Replace `SonioxTranscriptionStream` entirely with SDK wrapper | Patch with delta-index tracking        | Delta patch doesn't handle token revisions, leaves ~840 lines of manual code, same class of bug will recur                                   |
| Use `RealtimeSegmentBuffer` for interims                      | Process `result.tokens` directly       | Buffer handles rolling-window dedup, speaker grouping, and stable segment emission — exactly our bug                                         |
| Use `RealtimeUtteranceBuffer` for finals                      | Track manually with `stablePrefixText` | Buffer + `markEndpoint()` gives clean utterance boundaries driven by Soniox's endpoint detection                                             |
| One `utteranceId` per endpoint-delimited utterance            | New `utteranceId` per speaker change   | Speaker changes within a continuous utterance should NOT create new cards — the segment buffer handles speaker grouping within the utterance |
| Keep `TranslationManager` as-is for now                       | Unify via SDK's built-in translation   | Smaller blast radius; translation unification is a follow-up once the core migration is proven                                               |
| `SonioxNodeClient` as singleton on provider                   | New client per stream                  | Client manages API key and HTTP client; one per provider is sufficient and avoids redundant connections                                      |
| Keep `TranscriptionData` type unchanged                       | Extend with SDK-specific fields        | No downstream changes needed; apps don't need to know we switched to the SDK                                                                 |
