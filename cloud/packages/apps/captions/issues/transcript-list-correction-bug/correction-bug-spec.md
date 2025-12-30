# Transcript List vs Preview Mismatch Bug

## Overview

The transcript list UI shows completely different text than the glasses preview/display. This is a fundamental data integrity issue - the actual transcribed content differs between the two views.

## Evidence

**Transcript List shows:**
- "123, 123, 123." (Speaker 2)
- "ABCDEFG." (Speaker 2)
- "123, 123." (Speaker 2)
- "It's on pace." (Speaker 1)
- "It's my own pace." (Speaker 1)
- "This is a test 123." (Speaker 1)

**Preview (glasses) shows:**
- "three. Just it, just it, one, two, three. ABCDEFG. One, two, three, four, five. It's on face. It's mouthpiece. It's smiley face. It's smiley face. This is just one, two, three."

These are **completely different texts**!

## Root Cause Analysis

### Dual Subscription Paths

The captions app has **two separate transcription subscriptions** that create different stream types:

### Path 1: Transcript List (TranscriptsManager)
```typescript
// src/app/session/TranscriptsManager.ts
constructor(userSession: UserSession) {
  // ...
  this.disposables.push(this.userSession.appSession.events.onTranscription(onTranscription))
}
```

This calls `createTranscriptionStream("en-US")` → subscribes to `transcription:en-US`

### Path 2: Glasses/Preview (LiveCaptionsApp)
```typescript
// src/app/index.ts
const cleanup = session.onTranscriptionForLanguage(
  subscriptionLocale,  // e.g., "en-US"
  (data: TranscriptionData) => {
    this.handleTranscription(userSession, data)
  },
  {
    hints: languageHints,  // e.g., ["ja", "af", "sq", "fr", "zh"]
  },
)
```

This calls `createTranscriptionStream("en-US", {hints: ["ja", "af", ...]})` → subscribes to `transcription:en-US?hints=ja,af,sq,fr,zh`

### Why They Differ

These are **different stream type identifiers**:
- `transcription:en-US` (TranscriptsManager)
- `transcription:en-US?hints=ja,af,sq,fr,zh` (LiveCaptionsApp)

The SDK routes messages based on exact stream type match. The cloud may:
1. Send different data on each stream
2. Have different language detection behavior based on hints
3. Route transcriptions to one stream but not the other

### Additional Problems with Current Architecture

1. **Logic split across files**: Business logic (Pinyin conversion, settings) is in `index.ts` instead of managers
2. **Hardcoded language**: TranscriptsManager always subscribes to `en-US`, ignoring user's language setting
3. **Duplicate subscriptions**: Two subscriptions for transcription wastes resources
4. **No coordination**: TranscriptsManager and DisplayManager don't share the same transcription data

## Proposed Solution: Refactor to Single Subscription

### Architecture Change

Move all transcription handling into the managers, with a single subscription owned by the UserSession:

```
UserSession.initialize()
    └── Subscribe to transcription (language + hints from SettingsManager)
           └── TranscriptsManager.handleTranscription(data)
                  ├── Update transcript list
                  ├── Broadcast to SSE clients
                  └── DisplayManager.processAndDisplay(data)
                         ├── Format for glasses
                         └── Broadcast preview to SSE clients
```

### Implementation Plan

#### Phase 1: Move subscription to UserSession

**File: `src/app/session/UserSession.ts`**
```typescript
export class UserSession {
  // ... existing fields ...
  private transcriptionCleanup: (() => void) | null = null

  async initialize(): Promise<void> {
    // Initialize settings first
    await this.settings.initialize()
    
    // Get language config
    const language = await this.settings.getLanguage()
    const hints = await this.settings.getLanguageHints()
    const locale = languageToLocale(language)
    
    // Update display with settings
    const displayWidth = await this.settings.getDisplayWidth()
    const displayLines = await this.settings.getDisplayLines()
    const isChineseLanguage = language === "Chinese (Hanzi)"
    const lineWidth = convertLineWidth(displayWidth.toString(), isChineseLanguage)
    this.display.updateSettings(lineWidth, displayLines, isChineseLanguage)
    
    // Single subscription for all transcription handling
    const subscriptionLocale = language === "auto" ? "en-US" : locale
    this.transcriptionCleanup = this.appSession.events.onTranscriptionForLanguage(
      subscriptionLocale,
      (data) => this.transcripts.handleTranscription(data),
      { hints }
    )
  }

  dispose() {
    this.transcriptionCleanup?.()
    this.transcripts.dispose()
    this.settings.dispose()
    this.display.dispose()
    UserSession.userSessions.delete(this.userId)
  }
}
```

#### Phase 2: Update TranscriptsManager

**File: `src/app/session/TranscriptsManager.ts`**
```typescript
export class TranscriptsManager {
  // Remove the constructor subscription
  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "TranscriptsManager"})
    // NO subscription here - UserSession owns it
  }

  // Public method called by UserSession
  public async handleTranscription(data: TranscriptionData): Promise<void> {
    this.logger.info({...}, `Received transcription: ${data.text}`)

    // 1. Update transcript list
    const entry = this.createEntry(data)
    if (data.utteranceId) {
      this.updateByUtteranceId(entry)
    } else {
      // legacy handling
    }
    this.broadcast(entry)

    // 2. Process for display (handles Pinyin, etc.)
    let displayText = data.text
    const language = await this.userSession.settings.getLanguage()
    if (language === "Chinese (Pinyin)") {
      displayText = convertToPinyin(displayText)
    }

    // 3. Update glasses display
    this.userSession.display.processAndDisplay(
      displayText, 
      data.isFinal,
      data.speakerId  // Pass speakerId for future diarization feature
    )
  }

  dispose() {
    // No subscription to clean up
    this.sseClients.clear()
  }
}
```

#### Phase 3: Simplify LiveCaptionsApp

**File: `src/app/index.ts`**
```typescript
export class LiveCaptionsApp extends AppServer {
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`🗣️ New session for user ${userId}`)
    
    const userSession = new UserSession(session)
    
    try {
      await userSession.initialize()
      console.log(`✅ Session initialized for user ${userId}`)
    } catch (error) {
      console.error("Error initializing session:", error)
      // Fallback handled inside UserSession.initialize()
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} stopped: ${reason}`)
    UserSession.getUserSession(userId)?.dispose()
  }
}
```

## Benefits of Refactoring

| Before | After |
|--------|-------|
| Two subscriptions with different stream types | Single subscription |
| Logic split between index.ts and managers | Logic centralized in managers |
| TranscriptsManager hardcodes "en-US" | Uses user's language settings |
| No coordination between transcript list and display | Same data flows to both |
| Difficult to add features (diarization) | Clear extension points |

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/session/UserSession.ts` | Add `initialize()`, move subscription here |
| `src/app/session/TranscriptsManager.ts` | Remove constructor subscription, add `handleTranscription()` |
| `src/app/index.ts` | Simplify to just create UserSession and call initialize() |

## Testing

1. **Single language**
   - Transcript list and preview should show identical text
   
2. **Multi-language with hints**
   - Both views should show same transcriptions
   
3. **Language change**
   - Changing language should update subscription
   - Both views should reflect new language

4. **Speaker changes (diarization)**
   - Same speakerId in both views
   - Prepared for future speaker label feature

## Priority

**HIGH** - This is a fundamental data integrity issue. Users see different content in different views.

## Dependencies

Once this is fixed, we can implement:
- [diarization-speaker-labels](../diarization-speaker-labels) - Add `[1]:` labels on glasses for speaker changes

## Status

- [x] Bug identified
- [x] Root cause found (dual subscription with different stream types)
- [x] Refactoring plan created
- [ ] Implement refactoring
- [ ] Test with multi-speaker, multi-language scenarios