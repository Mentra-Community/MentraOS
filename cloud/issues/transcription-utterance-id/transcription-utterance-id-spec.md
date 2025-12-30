# Transcription Utterance ID Spec

## Overview

Add `utteranceId` and `speakerId` fields to `TranscriptionData` so apps can correlate interim and final transcripts, especially when multiple speakers or languages are involved.

## Problem

### 1. No way to correlate interim → final transcripts

`TranscriptionData` has no ID field:

```typescript
// Current SDK interface - no ID!
interface TranscriptionData {
  type: StreamType.TRANSCRIPTION
  text: string
  isFinal: boolean
  transcribeLanguage?: string
  speakerId?: string // Exists but never populated
  // ...
}
```

Apps receive a stream of transcripts but can't tell which final replaces which interim:

```
interim: "Hello"        → which final matches this?
interim: "Hi there"     → or this?
final: "Hello everyone" → replaces what?
final: "Hi there friend"
```

### 2. Speaker diarization data is lost

Soniox returns speaker info per token when `enable_speaker_diarization: true`:

```json
{
  "tokens": [
    {
      "text": "Hello",
      "is_final": true,
      "speaker": "1"
    }
  ]
}
```

We enable diarization but **never extract or pass through the `speaker` field**:

```typescript
// SonioxTranscriptionProvider.ts L608-620
tailTokens.push({
  text: token.text,
  isFinal: false,
  confidence: token.confidence,
  start_ms: token.start_ms ?? 0,
  end_ms: token.end_ms ?? 0,
  // speaker: token.speaker  ← MISSING!
})
```

### 3. Multi-speaker/multi-language scenarios broken

Without IDs, apps can't handle:

- Two speakers talking (which interim belongs to which speaker?)
- Language switching (Spanish interim, English interim, which final matches?)
- Overlapping speech

The captions app currently hardcodes `"Speaker 1"`:

```typescript
// TranscriptsManager.ts
private currentSpeaker = "Speaker 1"  // Never changes
```

## Constraints

- **Backwards compatible**: `utteranceId` must be optional
- **Soniox token model**: No native "utterance" concept - tokens stream continuously
- **Boundary detection**: Use `<end>` token (endpoint detection) and speaker/language changes
- **SDK interface change**: Requires SDK version bump

## Goals

1. Add `utteranceId?: string` to `TranscriptionData` interface
2. Generate utterance IDs in cloud when boundaries detected:
   - `<end>` token received (endpoint detection)
   - Speaker changes (from diarization)
   - Language changes
3. Populate `speakerId` from Soniox token `speaker` field
4. Apps can correlate interim→final by matching `utteranceId`

## Non-Goals

- Translation utterance tracking (separate feature)
- Changing how Soniox processes audio
- Real-time speaker identification UI (app responsibility)
- Historical transcript storage changes

## Open Questions

1. **utteranceId format?**
   - Option A: `{timestamp}-{random}` (simple)
   - Option B: `{sessionId}-{speakerId}-{sequence}` (more semantic)
   - **Leaning**: Option A - simpler, no coordination needed

2. **Language change = new utterance?**
   - Same speaker switches languages mid-sentence
   - Probably yes - different language context
   - **Need to verify** Soniox behavior

3. **Overlapping speech handling?**
   - Two speakers at once → two concurrent utteranceIds
   - Soniox assigns tokens to speakers, so this should work
   - **Need to test**
