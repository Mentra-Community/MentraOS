# Spike: Soniox Node SDK Migration

## Overview

**What this doc covers:** Root cause analysis of duplicate transcription cards in Captions, traced to a fundamental mismatch between how our `SonioxTranscriptionStream` processes tokens and how Soniox actually delivers them, plus evaluation of the official Soniox Node SDK as a replacement.

**Why this doc exists:** On Feb 19 2026 (dev server), live captions showed 5+ duplicate cards for the same utterance during a speaker diarization session. BetterStack log analysis confirmed the bug is in `processTranscriptionTokens` — it re-processes the full rolling token list on every WebSocket message, re-triggering speaker-change detection and generating a new `utteranceId` every ~150ms. The Soniox Node SDK (`@soniox/node`) handles all of this correctly out of the box.

**Who should read this:** Anyone working on transcription, captions, or the Soniox integration in cloud.

---

## Background

### Current architecture

Audio flows through this path:

```
Client mic → UDP/WebSocket → AudioManager → TranscriptionManager → SonioxTranscriptionProvider
    → SonioxTranscriptionStream (raw WebSocket to wss://stt-rt.soniox.com)
        → processTranscriptionTokens() → TranscriptionData → Apps (Captions, etc.)
```

`SonioxTranscriptionStream` (~840 lines, `SonioxTranscriptionProvider.ts` L257–1098) manages:

- Raw WebSocket connection to Soniox
- Manual config message construction (L458–570)
- Token-by-token processing with speaker change detection (L612–797)
- Manual `stablePrefixText` / `lastSentInterim` / `utteranceId` tracking
- Manual keepalive (L1053–1097)
- Manual reconnection and error handling

### How Soniox delivers tokens

Soniox's real-time WebSocket sends a **rolling token window** with each message — the full list of tokens from stream start, growing by one or more tokens per message. This is confirmed by BetterStack logs:

```
04:12:57.696  🔍 SONIOX RAW TOKENS: 16/16 have speaker field
04:12:57.937  🔍 SONIOX RAW TOKENS: 17/17 have speaker field
04:12:58.104  🔍 SONIOX RAW TOKENS: 18/18 have speaker field
04:12:58.352  🔍 SONIOX RAW TOKENS: 19/19 have speaker field
04:12:58.419  🔍 SONIOX RAW TOKENS: 20/20 have speaker field
```

Token count grows monotonically: 16 → 17 → 18 → 19 → 20. Each message contains ALL tokens, not just new ones.

### What our code assumes

`processTranscriptionTokens` (L612–797) iterates **all tokens** in every message as if they're new:

```typescript
// L638-655 — the bug
for (const token of tokens) {
  if (token.text === "<end>") {
    hasEndToken = true
    continue
  }

  // Detect speaker change → new utterance
  if (token.speaker && token.speaker !== this.currentSpeakerId) {
    if (this.currentUtteranceId && this.lastSentInterim) {
      this.emitFinalTranscription("speaker_change")
    }
    this.startNewUtterance(token.speaker, token.language || this.language)
  }
  // ...accumulate stablePrefixText and tailTokens...
}
```

This code was written assuming **delta tokens** (only new tokens per message). With the rolling window, it re-encounters the Speaker 1 → Speaker 2 transition on every single message.

---

## Findings

### 1. Root cause confirmed via BetterStack logs

Session: `caydenpierce4@gmail.com`, Feb 19 2026, dev server (`devapi.mentra.glass`).

Every FINAL emission has `trigger: "speaker_change"` even though the speaker stays as "2":

| Timestamp    | Type    | Text                        | utteranceId      | Speaker | Trigger        |
| ------------ | ------- | --------------------------- | ---------------- | ------- | -------------- |
| 04:12:57.696 | FINAL   | "Oh wait...new?"            | `utt_...a4zhjiz` | 1       | speaker_change |
| 04:12:57.696 | interim | "Oh wait...new? Oh"         | `utt_...h8brtb2` | 2       | —              |
| 04:12:57.937 | FINAL   | "Oh wait...new? Oh"         | `utt_...h8brtb2` | 2       | speaker_change |
| 04:12:57.937 | interim | "Oh wait...new? Oh my"      | `utt_...om4v38d` | 2       | —              |
| 04:12:58.104 | FINAL   | "Oh wait...new? Oh my"      | `utt_...om4v38d` | 2       | speaker_change |
| 04:12:58.104 | interim | "Oh wait...new? Oh my God"  | `utt_...xds7nrb` | 2       | —              |
| 04:12:58.352 | FINAL   | "Oh wait...new? Oh my God"  | `utt_...xds7nrb` | 2       | speaker_change |
| 04:12:58.420 | FINAL   | "Oh wait...new? Oh my God," | `utt_...lv9cdkg` | 2       | speaker_change |

Every ~150ms: new utteranceId → new card in Captions UI → 5+ duplicates for the same speech.

Raw token analysis confirmed every batch includes both speakers:

```
speakers: ["1","2"]    // Both speakers in EVERY batch
sampleToken: {"text":" Oh","speaker":"1","is_final":false}  // First token is always Speaker 1
```

### 2. The exact bug mechanism

On **every batch** (~150ms):

1. **Token 1** is from Speaker 1 (old, already processed) → `currentSpeakerId` was "2" from last batch → **speaker change detected** → `emitFinalTranscription("speaker_change")` → resets `stablePrefixText` → `startNewUtterance` for Speaker 1 → **new utteranceId**
2. Speaker 1's `is_final` tokens rebuild `stablePrefixText` from scratch
3. Speaker 2 tokens arrive → **another speaker change** → `emitFinalTranscription("speaker_change")` again → `startNewUtterance` for Speaker 2 → **another new utteranceId**
4. Speaker 2's tokens rebuild text with the one new word
5. Interim emitted with the brand new utteranceId

Result: text is correct (rebuilt from scratch each time), but utteranceId changes every batch → Captions creates a new card per batch.

### 3. This class of bug is unfixable with the current architecture

The rolling-window delivery model means:

- We can't detect speaker changes by iterating all tokens — old transitions replay every time
- We'd need to track a `lastProcessedTokenIndex` and only process deltas
- But Soniox can also **revise** earlier tokens (confidence updates, speaker re-attribution) — delta tracking breaks on revisions
- Manual `stablePrefixText` management creates O(n) recomputation per batch as the token list grows
- The keepalive, connection management, and error handling are all hand-rolled and fragile

A patch (delta-index tracking) would fix the immediate symptom but leaves us exposed to revision-related bugs and doesn't reduce the ~840 lines of manual stream management.

### 4. The Soniox Node SDK handles all of this

Soniox published `@soniox/node` with a real-time API that replaces our entire `SonioxTranscriptionStream`:

**Session creation:**

```typescript
const session = client.realtime.stt({
  model: "stt-rt-v4",
  audio_format: "pcm_s16le",
  sample_rate: 16000,
  num_channels: 1,
  enable_endpoint_detection: true,
  enable_speaker_diarization: true,
  language_hints: ["en"],
})
```

**Events:**

| Event       | Description                                  | Our equivalent                                 |
| ----------- | -------------------------------------------- | ---------------------------------------------- |
| `result`    | Parsed token batch with `RealtimeResult`     | `handleMessage` + `processTranscriptionTokens` |
| `endpoint`  | Speaker finished (`<end>` token detected)    | Manual `hasEndToken` check                     |
| `finalized` | Manual finalization complete (`<fin>` token) | `forceFinalizePendingTokens`                   |
| `finished`  | Session ended                                | `close()`                                      |
| `token`     | Individual token (optional)                  | N/A                                            |

**Key classes:**

| SDK Class                 | What it does                                                        | Lines it replaces                        |
| ------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| `RealtimeSttSession`      | Managed WebSocket, auto-keepalive, pause/resume                     | L257–456, L909–1097 (~400 lines)         |
| `RealtimeSegmentBuffer`   | Groups tokens by speaker/language, handles rolling window correctly | L612–797, L802–885 (~270 lines)          |
| `RealtimeUtteranceBuffer` | Collects segments into complete utterances via endpoint detection   | Manual utteranceId tracking (~100 lines) |

**Type mapping:**

| Soniox SDK               | Our `TranscriptionData`              |
| ------------------------ | ------------------------------------ |
| `RealtimeToken.text`     | `TranscriptionData.text`             |
| `RealtimeToken.speaker`  | `TranscriptionData.speakerId`        |
| `RealtimeToken.language` | `TranscriptionData.detectedLanguage` |
| `RealtimeToken.is_final` | `TranscriptionData.isFinal`          |
| `RealtimeSegment.text`   | Grouped text for interim display     |
| `RealtimeUtterance.text` | Final utterance text                 |

**Built-in features we currently hand-roll:**

- Auto-keepalive on `session.pause()` (vs our manual `startKeepalive`/`stopKeepalive`)
- Connection lifecycle management (`idle` → `connecting` → `connected` → `finishing` → `finished`)
- AbortSignal support for cancellation
- Translation config (`one_way` and `two_way`) built into session config — could simplify `TranslationManager`
- Hono webhook handler (`client.webhooks.handleHono()`) — aligns with our Hono API layer

### 5. SDK compatibility check

| Concern                            | Status                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Runtime: Bun                       | SDK uses standard WebSocket — Bun compatible ✅                              |
| Audio format: PCM s16le 16kHz mono | Explicitly supported in `SttSessionConfig` ✅                                |
| Speaker diarization                | `enable_speaker_diarization: true` ✅                                        |
| Language detection                 | `enable_language_identification: true` ✅                                    |
| Endpoint detection                 | `enable_endpoint_detection: true` ✅                                         |
| Translation                        | `TranslationConfig` with `one_way` and `two_way` ✅                          |
| Context/terms                      | `TranscriptionContext` with `terms`, `text`, `general` ✅                    |
| Model                              | `stt-rt-v4` (we currently use `stt-rt-preview`) ⚠️ Verify model availability |
| Pause/resume                       | `session.pause()` / `session.resume()` ✅                                    |

### 6. What the SDK does NOT give us

- **Our `TranscriptionData` interface**: We still need to map SDK types → our app-facing types
- **Integration with `TranscriptionManager`**: The provider interface stays, just the internals change
- **VAD interaction**: `forceFinalizePendingTokens` (called on VAD stop) maps to `session.finalize()`
- **Metrics collection**: We'd need to preserve our `metrics` object and populate it from SDK events
- **Multiple concurrent streams**: Each `RealtimeSttSession` is one stream; multi-language still needs multiple sessions

---

## Conclusions

| Option                                 | Effort            | Risk                                    | Fixes root cause | Maintenance burden          |
| -------------------------------------- | ----------------- | --------------------------------------- | ---------------- | --------------------------- |
| **A: Patch with delta-index tracking** | Small (1–2 days)  | Medium — doesn't handle token revisions | Partially        | Same ~840 lines to maintain |
| **B: Migrate to `@soniox/node` SDK**   | Medium (3–5 days) | Low — SDK is purpose-built for this     | Yes              | ~100 lines replacing ~840   |
| **C: Do nothing**                      | Zero              | High — bug ships                        | No               | —                           |

**Recommendation: Option B (SDK migration).**

The SDK was designed specifically to handle the rolling-window token delivery, speaker change detection, and utterance boundary management that we're doing incorrectly by hand. It eliminates the entire class of bugs (not just this one) and reduces our Soniox integration from ~840 lines of fragile manual WebSocket management to ~100 lines of SDK wrapper code.

The risk is low because:

1. The SDK's `RealtimeSttSession` accepts the exact same audio format and config we already use
2. We can keep the `SonioxTranscriptionProvider` interface unchanged — only the `SonioxTranscriptionStream` internals change
3. We can A/B test by running both implementations side-by-side before cutting over

---

## Next Steps

1. **spec.md** — Define exact behaviors: how SDK events map to `TranscriptionData`, utterance lifecycle, translation handling, metrics preservation
2. **design.md** — File-by-file implementation plan, testing strategy, rollout order
3. **Spike branch** — Install `@soniox/node`, create minimal `SonioxSdkTranscriptionStream`, verify Bun compatibility and audio format handling
