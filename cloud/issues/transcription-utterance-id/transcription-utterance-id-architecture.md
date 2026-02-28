# Transcription Utterance ID Architecture

## Current System

### Data Flow

```
Soniox API → SonioxTranscriptionProvider → TranscriptionManager → SDK → App
   │                    │                          │
   │ tokens with        │ tokens processed,        │ TranscriptionData
   │ speaker field      │ speaker discarded        │ (no ID, no speaker)
   │                    │                          │
   ▼                    ▼                          ▼
{speaker: "1"}    tailTokens (no speaker)    {speakerId: undefined}
```

### Key Code Paths

**Soniox config enables diarization** (`SonioxTranscriptionProvider.ts` L469-479):

```typescript
const config: any = {
  api_key: this.config.apiKey,
  model: this.config.model || "stt-rt-v3-preview",
  // ...
  enable_speaker_diarization: true, // ✓ Enabled
  // ...
}
```

**Token interface has speaker field** (`SonioxTranscriptionProvider.ts` L52-60):

```typescript
interface SonioxApiToken {
  text: string
  start_ms: number
  end_ms: number
  confidence: number
  is_final: boolean
  speaker?: string // ✓ Defined
  language?: string
}
```

**Speaker discarded during processing** (`SonioxTranscriptionProvider.ts` L608-620):

```typescript
tailTokens.push({
  text: token.text,
  isFinal: false,
  confidence: token.confidence,
  start_ms: token.start_ms ?? 0,
  end_ms: token.end_ms ?? 0,
  // speaker: token.speaker  ← NOT COPIED
})
```

**TranscriptionData created without speakerId** (`SonioxTranscriptionProvider.ts` L687-710):

```typescript
const interimData: TranscriptionData = {
  type: StreamType.TRANSCRIPTION,
  text: currentInterim,
  isFinal: false,
  // ...
  // speakerId: ???  ← NOT SET
  // utteranceId: ???  ← DOESN'T EXIST
}
```

### SDK Interface (current)

```typescript
// packages/sdk/src/types/messages/cloud-to-app.ts L118-130
export interface TranscriptionData extends BaseMessage {
  type: StreamType.TRANSCRIPTION
  text: string
  isFinal: boolean
  transcribeLanguage?: string
  startTime: number
  endTime: number
  speakerId?: string // Exists but never populated
  duration?: number
  provider?: string
  confidence?: number
  metadata?: TranscriptionMetadata
  // utteranceId: ???       // Doesn't exist
}
```

## Proposed System

### Data Flow

```
Soniox API → SonioxTranscriptionProvider → TranscriptionManager → SDK → App
   │                    │                          │
   │ tokens with        │ track utterance state,   │ TranscriptionData
   │ speaker field      │ generate IDs on          │ with utteranceId
   │                    │ boundaries               │ and speakerId
   ▼                    ▼                          ▼
{speaker: "1"}    currentUtteranceId        {utteranceId: "utt_001",
                  currentSpeakerId            speakerId: "1"}
```

### SDK Interface Changes

```typescript
// packages/sdk/src/types/messages/cloud-to-app.ts
export interface TranscriptionData extends BaseMessage {
  type: StreamType.TRANSCRIPTION
  text: string
  isFinal: boolean

  // NEW - optional for backwards compatibility
  utteranceId?: string // Identifies speech segment, same for interim+final

  transcribeLanguage?: string
  startTime: number
  endTime: number
  speakerId?: string // NOW POPULATED from Soniox diarization
  duration?: number
  provider?: string
  confidence?: number
  metadata?: TranscriptionMetadata
}
```

### Utterance Boundary Detection

New utterance ID generated when:

| Trigger         | Detection                            | Rationale                               |
| --------------- | ------------------------------------ | --------------------------------------- |
| `<end>` token   | `token.text === "<end>"`             | Endpoint detection fired (speech pause) |
| Speaker change  | `token.speaker !== currentSpeaker`   | Different person talking                |
| Language change | `token.language !== currentLanguage` | Different language context              |
| Stream start    | First token received                 | Initial utterance                       |

### Implementation Details

**New state in SonioxTranscriptionStream:**

```typescript
class SonioxTranscriptionStream {
  // Existing
  private stablePrefixText: string = ""
  private lastSentInterim = ""

  // NEW: Utterance tracking
  private currentUtteranceId: string | null = null
  private currentSpeakerId: string | undefined = undefined
  private currentLanguage: string | undefined = undefined

  private generateUtteranceId(): string {
    return `utt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  private startNewUtterance(speakerId?: string, language?: string): void {
    this.currentUtteranceId = this.generateUtteranceId()
    this.currentSpeakerId = speakerId
    this.currentLanguage = language
    this.stablePrefixText = ""
    this.lastSentInterim = ""
  }
}
```

**Modified token processing:**

```typescript
private processTranscriptionTokens(tokens: SonioxApiToken[]): void {
  let hasEndToken = false;

  for (const token of tokens) {
    if (token.text === "<end>") {
      hasEndToken = true;
      continue;
    }

    // Detect speaker change → new utterance
    if (token.speaker && token.speaker !== this.currentSpeakerId) {
      if (this.currentUtteranceId && this.stablePrefixText) {
        // Emit final for previous utterance before starting new one
        this.emitFinal();
      }
      this.startNewUtterance(token.speaker, token.language);
    }

    // Detect language change → new utterance (same speaker)
    if (token.language && token.language !== this.currentLanguage) {
      if (this.currentUtteranceId && this.stablePrefixText) {
        this.emitFinal();
      }
      this.startNewUtterance(this.currentSpeakerId, token.language);
    }

    // Ensure utterance exists
    if (!this.currentUtteranceId) {
      this.startNewUtterance(token.speaker, token.language);
    }

    // Process token (existing logic)
    if (token.is_final) {
      this.stablePrefixText += token.text;
    } else {
      tailTokens.push({
        text: token.text,
        isFinal: false,
        confidence: token.confidence,
        start_ms: token.start_ms ?? 0,
        end_ms: token.end_ms ?? 0,
        speaker: token.speaker,  // NOW CAPTURED
      });
    }
  }

  // Emit interim with utteranceId and speakerId
  if (currentInterim && currentInterim !== this.lastSentInterim) {
    const interimData: TranscriptionData = {
      type: StreamType.TRANSCRIPTION,
      text: currentInterim,
      isFinal: false,
      utteranceId: this.currentUtteranceId,      // NEW
      speakerId: this.currentSpeakerId,          // NOW SET
      transcribeLanguage: this.currentLanguage || this.language,
      // ...
    };
    this.callbacks.onData?.(interimData);
  }

  // <end> token → emit final and reset for next utterance
  if (hasEndToken) {
    this.emitFinal();
    this.currentUtteranceId = null;  // Next speech gets new ID
  }
}

private emitFinal(): void {
  if (!this.lastSentInterim) return;

  const finalData: TranscriptionData = {
    type: StreamType.TRANSCRIPTION,
    text: this.lastSentInterim,
    isFinal: true,
    utteranceId: this.currentUtteranceId,      // SAME as interim
    speakerId: this.currentSpeakerId,          // NOW SET
    transcribeLanguage: this.currentLanguage || this.language,
    // ...
  };
  this.callbacks.onData?.(finalData);

  this.stablePrefixText = "";
  this.lastSentInterim = "";
}
```

### App Usage Pattern

```typescript
// Simple app logic with utteranceId
function handleTranscription(data: TranscriptionData) {
  if (!data.utteranceId) {
    // Backwards compat: old cloud version, no utteranceId
    // Fall back to existing behavior
    return handleLegacyTranscription(data)
  }

  const idx = transcripts.findIndex((t) => t.utteranceId === data.utteranceId)

  if (idx >= 0) {
    // Update existing (interim→interim or interim→final)
    transcripts[idx] = data
  } else {
    // New utterance
    transcripts.push(data)
  }

  // Can now display speaker info
  // data.speakerId = "1" → "Speaker 1"
}
```

### Example Timeline

Multi-speaker conversation:

| #   | Event                 | utteranceId | speakerId | isFinal  | text             |
| --- | --------------------- | ----------- | --------- | -------- | ---------------- |
| 1   | Speaker 1 starts      | `utt_001`   | `1`       | false    | "Hello"          |
| 2   | Speaker 1 continues   | `utt_001`   | `1`       | false    | "Hello there"    |
| 3   | `<end>` token         | `utt_001`   | `1`       | **true** | "Hello there"    |
| 4   | Speaker 2 starts      | `utt_002`   | `2`       | false    | "Hi"             |
| 5   | Speaker 2 continues   | `utt_002`   | `2`       | false    | "Hi how are"     |
| 6   | Speaker 1 interrupts  | `utt_003`   | `1`       | false    | "Good"           |
| 7   | `<end>` for Speaker 2 | `utt_002`   | `2`       | **true** | "Hi how are you" |
| 8   | Speaker 1 continues   | `utt_003`   | `1`       | false    | "Good thanks"    |
| 9   | `<end>` for Speaker 1 | `utt_003`   | `1`       | **true** | "Good thanks"    |

## Files to Modify

### SDK

1. `packages/sdk/src/types/messages/cloud-to-app.ts`
   - Add `utteranceId?: string` to `TranscriptionData`

### Cloud

2. `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`
   - Add utterance tracking state
   - Capture `speaker` from tokens
   - Generate `utteranceId` on boundaries
   - Populate `speakerId` and `utteranceId` in emitted data

### Apps (example update)

3. `packages/apps/captions/src/app/session/TranscriptsManager.ts`
   - Read `speakerId` from `TranscriptionData` instead of hardcoding
   - Use `utteranceId` for interim→final correlation

## Testing

1. **Single speaker**: Verify utteranceId changes on `<end>` tokens
2. **Two speakers**: Verify different utteranceIds per speaker
3. **Speaker switch mid-stream**: Verify clean handoff
4. **Language switch**: Verify new utteranceId on language change
5. **Backwards compat**: Verify apps without utteranceId handling still work

## Open Questions

1. **Should we emit a final before speaker change?**
   - Current plan: Yes, auto-finalize previous utterance
   - Alternative: Let Soniox's `<end>` handle it
   - **Need to test** what Soniox does on speaker switches

2. **What if Soniox doesn't return speaker for some tokens?**
   - Could happen during fast speech or unclear audio
   - Plan: Keep current utteranceId if speaker is undefined
   - Only change on explicit speaker change

3. **Maximum utterance length?**
   - Very long monologue = very long utteranceId lifetime
   - Probably fine, but **should monitor** memory/state
