# Transcript List vs Preview Mismatch Bug

The transcript list UI shows completely different text than the glasses preview/display. This is a fundamental data integrity issue - the actual transcribed content differs between the two views.

## Documents

- **correction-bug-spec.md** - Root cause analysis and proposed fix

## Quick Context

**Current**: The captions app has two separate transcription subscriptions that receive different data:
- Transcript list uses `appSession.events.onTranscription()` - receives ALL transcriptions
- Glasses/preview uses `session.onTranscriptionForLanguage()` - receives FILTERED transcriptions with language hints

**Result**: Users see different text content in the transcript list vs the glasses preview.

## Evidence

**Transcript List shows:**
- "123, 123, 123." (Speaker 2)
- "ABCDEFG." (Speaker 2)
- "It's my own pace." (Speaker 1)

**Preview (glasses) shows:**
- "three. Just it, just it, one, two, three. ABCDEFG. One, two, three, four, five. It's on face. It's mouthpiece..."

These are **completely different texts**!

## Root Cause

Two separate subscription paths in the code:

```
TranscriptsManager.constructor()
  └── appSession.events.onTranscription()     ← Unfiltered
  
LiveCaptionsApp.onSession()
  └── session.onTranscriptionForLanguage()    ← Filtered with hints
```

## Proposed Fix

Route all transcription data through a single path:
1. Remove the direct subscription in `TranscriptsManager`
2. Have `LiveCaptionsApp.handleTranscription()` call both systems with the same data

## Status

- [x] Bug identified
- [x] Root cause found (dual subscription paths)
- [x] Fix implemented - Refactored to single subscription in UserSession
- [ ] Tested with multi-speaker, multi-language scenarios

## Priority

**HIGH** - Users see different content in different views, which is confusing and undermines trust.