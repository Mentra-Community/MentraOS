# Transcription Utterance ID & Speaker Diarization

Add utterance tracking and speaker identification to transcription data so apps can properly correlate interim and final transcripts.

## Documents

- **transcription-utterance-id-spec.md** - Problem, goals, constraints
- **transcription-utterance-id-architecture.md** - Technical design

## Quick Context

**Current**: `TranscriptionData` has no ID field. Apps can't correlate interim→final transcripts, especially with multiple speakers or languages. Speaker diarization is enabled but `speakerId` is never populated.

**Proposed**: Add `utteranceId` to identify speech segments. Populate `speakerId` from Soniox tokens. Apps can then properly track and replace interim transcripts.

## Key Context

Soniox returns tokens with `speaker` field when `enable_speaker_diarization: true` (already enabled), but we discard this data. The `<end>` token from endpoint detection marks utterance boundaries. We need to track these and expose them to apps.

## Status

- [x] Add `utteranceId?: string` to SDK `TranscriptionData` interface
- [x] Track utterance boundaries in `SonioxTranscriptionProvider`
- [x] Populate `speakerId` from Soniox tokens
- [x] Update captions app to use new fields
- [ ] Test with multiple speakers
