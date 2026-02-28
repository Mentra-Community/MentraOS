# Speaker Labels Display Spec

## Overview

Add visual speaker change indicators to the glasses display and webview preview, leveraging diarization data from Soniox to help deaf and hard of hearing users follow multi-person conversations.

## Problem Statement

### Current State

1. **Diarization data exists** - Soniox provides `speakerId` (e.g., "1", "2") for each transcription token
2. **Data flows through system** - `TranscriptionData.speakerId` is propagated from SonioxTranscriptionProvider → TranscriptionManager → SDK → Captions App
3. **Transcript list handles it well** - Shows speaker badges like "Speaker 1", "Speaker 2" on each card with nice colored indicators
4. **NOT shown on glasses/preview** - `DisplayManager.processAndDisplay()` only receives `text` and `isFinal`, not `speakerId`
5. **TranscriptProcessor is speaker-agnostic** - It concatenates text without any speaker context

### User Impact

- Deaf/HoH users have specifically requested this feature
- Cannot tell when the speaker changes on glasses
- Multi-person conversations are confusing
- Important context is lost (who said what)

## Proposed Solution

### Display Format

Show `[N]:` prefix **only when the speaker changes** (not on every utterance).

### Example Rendering

**Scenario**: Two people having a conversation

**Input transcriptions**:
1. `{text: "Hello, how are you?", speakerId: "1", isFinal: true}`
2. `{text: "I'm doing great, thanks!", speakerId: "2", isFinal: true}`
3. `{text: "That's wonderful.", speakerId: "1", isFinal: true}`

**Current glasses output** (5 lines, 52 chars):
```
Hello, how are you? I'm doing great, thanks!
That's wonderful.



```

**Proposed glasses output** (speaker label only on change):
```
[1]: Hello, how are you?
[2]: I'm doing great, thanks!
[1]: That's wonderful.


```

**Single speaker scenario** - no labels shown:
```
Hello, how are you? I'm doing well. Nice weather
today isn't it?



```

## Architecture Changes

### Data Flow (Current)

```
SonioxTranscriptionProvider
       ↓ TranscriptionData (has speakerId)
TranscriptionManager
       ↓ TranscriptionData (has speakerId)
SDK events.onTranscription
       ↓ TranscriptionData (has speakerId)
LiveCaptionsApp.handleTranscription
       ↓ text, isFinal (speakerId LOST here!)
DisplayManager.processAndDisplay
       ↓ text, isFinal
TranscriptProcessor.processString
       ↓ formatted string
showTextWall()
```

### Data Flow (Proposed)

```
SonioxTranscriptionProvider
       ↓ TranscriptionData (has speakerId)
TranscriptionManager
       ↓ TranscriptionData (has speakerId)
SDK events.onTranscription
       ↓ TranscriptionData (has speakerId)
LiveCaptionsApp.handleTranscription
       ↓ text, isFinal, speakerId ← PASS IT THROUGH
DisplayManager.processAndDisplay
       ↓ text, isFinal, speakerId
TranscriptProcessor.processString
       ↓ formatted string with [N]: prefix on speaker change
showTextWall()
```

## Implementation Plan

### Phase 1: Pass speakerId through the pipeline

**File: `src/app/index.ts`**

```typescript
// Current
private async handleTranscription(userSession: UserSession, transcriptionData: TranscriptionData): Promise<void> {
  const isFinal = transcriptionData.isFinal
  let newTranscript = transcriptionData.text
  // ...
  userSession.display.processAndDisplay(newTranscript, isFinal)
}

// Proposed
private async handleTranscription(userSession: UserSession, transcriptionData: TranscriptionData): Promise<void> {
  const isFinal = transcriptionData.isFinal
  const speakerId = transcriptionData.speakerId
  let newTranscript = transcriptionData.text
  // ...
  userSession.display.processAndDisplay(newTranscript, isFinal, speakerId)
}
```

### Phase 2: Track speaker changes in DisplayManager

**File: `src/app/session/DisplayManager.ts`**

```typescript
export class DisplayManager {
  private processor: TranscriptProcessor
  private lastSpeakerId: string | undefined = undefined  // NEW
  // ...

  processAndDisplay(text: string, isFinal: boolean, speakerId?: string): void {
    // Check if speaker changed
    const speakerChanged = speakerId !== undefined && speakerId !== this.lastSpeakerId
    
    if (speakerChanged) {
      this.lastSpeakerId = speakerId
    }
    
    // Pass speaker info to processor
    const formatted = this.processor.processString(text, isFinal, speakerId, speakerChanged)
    this.showOnGlasses(formatted, isFinal)
    this.resetInactivityTimer()
  }
}
```

### Phase 3: Add speaker labels in TranscriptProcessor

**File: `src/app/utils/text-wrapping/TranscriptProcessor.ts`**

```typescript
public processString(
  newText: string | null, 
  isFinal: boolean,
  speakerId?: string,
  speakerChanged?: boolean
): string {
  newText = newText === null ? "" : newText.trim()
  
  // Add speaker label ONLY if speaker changed
  if (speakerChanged && speakerId) {
    newText = `[${speakerId}]: ${newText}`
  }
  
  // ... rest of existing logic
}
```

### Phase 4: Update transcript history to preserve speaker info

The `finalTranscriptHistory` currently stores plain strings. We need to preserve speaker context for when settings change and display refreshes:

```typescript
interface TranscriptHistoryEntry {
  text: string
  speakerId?: string
  hadSpeakerChange: boolean  // Was there a speaker change when this was added?
}

private finalTranscriptHistory: TranscriptHistoryEntry[] = []
```

## Edge Cases

### 1. Speaker changes mid-utterance

Soniox may detect a speaker change in the middle of continuous speech. When this happens:
- Finalize the current utterance for the old speaker
- Start a new line with the new speaker's label

### 2. Unknown speaker

If `speakerId` is undefined:
- Don't show any label
- Treat as continuation of previous speaker

### 3. Single speaker throughout

If there's only one speaker:
- No labels shown at all (cleaner display)
- Only show `[1]:` if/when a second speaker appears

### 4. Line width considerations

The `[1]: ` prefix is 5 characters. With a 52-char line width:
- First line of speaker's turn: 47 effective chars
- Continuation lines: 52 chars (no label)

Need to account for this in word wrapping.

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/index.ts` | Pass `speakerId` to `processAndDisplay()` |
| `src/app/session/DisplayManager.ts` | Track speaker changes, pass to processor |
| `src/app/utils/text-wrapping/TranscriptProcessor.ts` | Add speaker labels on change, update history format |

## Dependencies

This feature should be implemented AFTER fixing:
- [transcript-list-correction-bug](../transcript-list-correction-bug) - Fix dual subscription paths first so both views receive same data

## Success Criteria

- [ ] Speaker changes are visually indicated on glasses with `[N]:` prefix
- [ ] Labels only appear when speaker changes (not on every utterance)
- [ ] Preview mirrors glasses display with speaker labels
- [ ] Single-speaker scenarios show no labels
- [ ] Performance not impacted (< 5ms additional processing)
- [ ] Works correctly with 2+ speakers
- [ ] Labels persist through settings changes
- [ ] User feedback validates format choice