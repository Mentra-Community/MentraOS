# Multi-Language Transcription Support

## Current Architecture Overview

### Transcription Service

The transcription service (`transcription.service.ts`) is responsible for capturing, processing, and storing speech transcriptions. It leverages Azure Cognitive Services Speech SDK to perform speech recognition across multiple languages. The service:

1. Initializes speech recognition with appropriate language settings
2. Processes real-time speech from audio streams
3. Stores transcription results in the user session

### Key Components

- **TranscriptionService**: Main service class that handles speech recognition
- **ExtendedUserSession**: Contains the transcript history in `transcript.segments` array
- **TranscriptSegment**: Represents a single transcription segment with text, timestamp, and speaker information
- **LanguageStreamInfo**: Provides language-specific configuration for transcription

### Current Limitations

The current implementation only stores English transcripts in the session history:

```typescript
if (languageInfo.transcribeLanguage === 'en-US') {
  this.updateTranscriptHistory(userSession, event, false);
}
```

This creates limitations for multilingual applications, as non-English transcripts are processed but not stored for later retrieval.

## Related Files

1. **transcription.service.ts**: Core service that handles speech recognition
2. **session.service.ts**: Manages user sessions including transcript storage
3. **transcripts.routes.ts**: API endpoints for transcript retrieval
4. **streams.ts**: Defines language-related types and utilities

## Planned Extension for Multi-Language Support

### 1. Session Storage Modifications

Update the `ExtendedUserSession` interface to support language-specific transcript storage:

```typescript
export interface ExtendedUserSession extends UserSession {
  transcript: {
    segments: TranscriptSegment[]; // Keep for backward compatibility (English)
    languageSegments: Map<string, TranscriptSegment[]>; // New language-indexed map
  };
}
```

### 2. Transcript History Update

Modify the `updateTranscriptHistory` method to store transcripts by language:

```typescript
private updateTranscriptHistory(
  userSession: ExtendedUserSession, 
  event: ConversationTranscriptionEventArgs, 
  isFinal: boolean,
  language: string = 'en-US'
): void {
  // Initialize languageSegments if not exists
  if (!userSession.transcript.languageSegments) {
    userSession.transcript.languageSegments = new Map<string, TranscriptSegment[]>();
  }
  
  // Ensure the language entry exists
  if (!userSession.transcript.languageSegments.has(language)) {
    userSession.transcript.languageSegments.set(language, []);
  }
  
  const segment = createTranscriptSegment(event, isFinal);
  
  // Store in language-specific array
  userSession.transcript.languageSegments.get(language)?.push(segment);
  
  // For backward compatibility, also store English transcripts in segments array
  if (language === 'en-US') {
    userSession.transcript.segments.push(segment);
  }
}
```

### 3. Handle All Languages

Update the speech recognition event handler to store transcripts for all languages:

```typescript
if (languageInfo && languageInfo.transcribeLanguage) {
  this.updateTranscriptHistory(
    userSession, 
    event, 
    false, 
    languageInfo.transcribeLanguage
  );
}
```

### 4. API Enhancements

Modify the transcript retrieval API to support language parameter:

```typescript
router.get('/api/transcripts/:appSessionId', async (req, res) => {
  const appSessionId = req.params.appSessionId;
  const language = req.query.language as string || 'en-US';
  
  // Get user session
  const userSession = await sessionService.getSession(appSessionId);
  if (!userSession) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  let transcriptSegments: TranscriptSegment[] = [];
  
  // If using new language-specific storage
  if (userSession.transcript.languageSegments?.has(language)) {
    transcriptSegments = userSession.transcript.languageSegments.get(language) || [];
  } 
  // Fallback to original segments array (for backward compatibility)
  else if (language === 'en-US') {
    transcriptSegments = userSession.transcript.segments;
  }
  
  return res.json({ transcriptSegments });
});
```

### 5. Session Initialization

Update session initialization to set up language-specific transcript storage:

```typescript
function initializeSession(session: ExtendedUserSession): void {
  if (!session.transcript) {
    session.transcript = {
      segments: [],
      languageSegments: new Map<string, TranscriptSegment[]>()
    };
  } else if (!session.transcript.languageSegments) {
    session.transcript.languageSegments = new Map<string, TranscriptSegment[]>();
    // If there are already English segments, add them to the map
    if (session.transcript.segments?.length > 0) {
      session.transcript.languageSegments.set('en-US', [...session.transcript.segments]);
    }
  }
}
```

## Implementation Considerations

### Backward Compatibility

- Maintain the existing `segments` array for English transcripts to ensure backward compatibility
- Initialize the `languageSegments` map during session creation/retrieval
- Add migration logic to move existing English transcripts to the new storage structure

### Performance Implications

- Using Map for language-indexed storage provides efficient lookup by language code
- Consider memory usage for sessions with transcripts in multiple languages
- Evaluate if transcript history should have a maximum size limit per language

### Future Improvements

1. **Transcript Summarization**: Add language-specific summarization for long transcripts
2. **Transcript Export**: Support exporting transcripts by language
3. **Language Detection**: Implement automatic language detection for streams without explicit language settings
4. **Real-time Translation**: Consider adding real-time translation between languages

## Testing Plan

1. **Unit Tests**:
   - Test transcript storage for multiple languages
   - Verify backward compatibility with existing code

2. **Integration Tests**:
   - Test the full pipeline from speech recognition to API retrieval
   - Verify correct language-specific storage and retrieval

3. **End-to-End Tests**:
   - Test with real multi-language speech input
   - Verify correct transcript storage and retrieval

## Implementation Timeline

1. Update `ExtendedUserSession` interface and session initialization (1 day)
2. Modify transcript history update to support multiple languages (1 day)
3. Update API endpoint to support language parameter (1 day)
4. Add tests and documentation (1 day)
5. Code review and refinement (1 day)