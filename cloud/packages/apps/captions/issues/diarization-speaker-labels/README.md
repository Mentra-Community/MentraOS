# Diarization Speaker Labels on Glasses Display

Show speaker change indicators on glasses and preview when different speakers are detected, helping deaf and hard of hearing users follow multi-person conversations.

## Documents

- **speaker-labels-spec.md** - Technical specification and implementation plan

## Quick Context

**Current**: The glasses display shows a continuous stream of text without indicating who is speaking. Diarization data (`speakerId`) is available from Soniox but only used in the transcript list UI.

**Implemented**: Speaker labels like `[1]:` or `[2]:` appear at the start of each speaker's turn in the glasses display and preview, making it clear when the speaker changes.

## User Need

Deaf and hard of hearing users have specifically requested this feature. In multi-person conversations, it's difficult to follow who is speaking without visual speaker indicators. This is especially important for:
- Meetings with multiple participants
- Conversations at restaurants/social settings
- Any scenario with 2+ speakers

## Example Output

**Previous display (no speaker info):**
```
Hello, how are you today? I'm doing
great thanks. Did you see the news
about the product launch? Yes I did,
it looks amazing.
```

**New display with speaker labels:**
```
[1]: Hello, how are you today?
[2]: I'm doing great thanks. Did you
see the news about the product launch?
[1]: Yes I did, it looks amazing.
```

## Implementation Details

### Changes Made

1. **DisplayManager.ts**
   - Added `lastSpeakerId` tracking to detect speaker changes
   - Passes `speakerId` and `speakerChanged` to TranscriptProcessor
   - Updated `cleanTranscriptText()` to preserve `[N]:` speaker labels

2. **TranscriptProcessor.ts**
   - New `TranscriptHistoryEntry` interface stores `text`, `speakerId`, and `hadSpeakerChange`
   - `processString()` now accepts `speakerId` and `speakerChanged` parameters
   - `buildDisplayText()` adds `[N]:` prefix only when speaker changes
   - History preserves speaker info for display refresh after settings change

### Behavior

- Labels only appear when speaker **changes** (not on every utterance)
- Single-speaker scenarios show no labels (cleaner display)
- Labels are preserved when display settings change
- Inactivity timer resets speaker tracking

## Status

- [x] Feature request documented
- [x] Fix transcript-list-correction-bug first (refactored to single subscription)
- [x] Design speaker label format (`[1]:`, `[2]:`, etc.)
- [x] Implement in TranscriptProcessor
- [x] Update DisplayManager to pass speakerId
- [ ] Test with multi-speaker scenarios on real glasses
- [ ] Gather user feedback on label format

## Priority

**HIGH** - Requested by deaf and hard of hearing users to follow multi-person conversations.