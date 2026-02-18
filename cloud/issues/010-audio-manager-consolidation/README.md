# 010: Audio Manager Consolidation

Consolidate AudioManager and MicrophoneManager, move VAD handling to AudioManager, and redesign phone mic state synchronization.

## Documents

- **audio-consolidation-spec.md** - Problem, goals, constraints
- **audio-consolidation-architecture.md** - Technical design

## Quick Context

**Current**:

- `AudioManager` handles audio data processing and relay to apps
- `MicrophoneManager` handles mic on/off state sync with phone (redundant messaging)
- VAD handling lives in `TranscriptionManager` but is consumed by multiple managers
- Phone mic state sync is polling-like, sends redundant messages

**Proposed**:

- Single `AudioManager` owns all audio concerns including VAD
- VAD emits events to listeners (TranscriptionManager, TranslationManager, apps)
- Replace mic on/off sync with "requirements publishing" pattern
- Phone derives mic state locally from requirements

## Key Context

MicrophoneManager sends `SET_MICROPHONE_STATE` messages to the phone on every subscription change. This creates redundant messaging and implies an architectural flaw - the cloud shouldn't be polling/spamming state, it should publish requirements and let the phone decide.

VAD (Voice Activity Detection) is fundamentally an audio-level concern, not transcription. Both TranscriptionManager and TranslationManager need VAD events, so it belongs in AudioManager.

## Dependencies

**Requires mobile client changes** - This is not a cloud-only refactor. The phone app needs to:

1. Accept new `MIC_REQUIREMENTS_UPDATE` message format
2. Derive mic state locally from requirements
3. Stop expecting `SET_MICROPHONE_STATE` messages (deprecate)

## Status

- [ ] Design approved by mobile team
- [ ] Move VAD handling to AudioManager (cloud)
- [ ] Add VAD listener pattern (cloud)
- [ ] Implement requirements publishing (cloud)
- [ ] Update phone to accept requirements (mobile)
- [ ] Update phone to derive mic state (mobile)
- [ ] Deprecate SET_MICROPHONE_STATE (both)
- [ ] Remove MicrophoneManager (cloud)

## Key Files

### Cloud

- `packages/cloud/src/services/session/AudioManager.ts` - Audio processing, will own VAD
- `packages/cloud/src/services/session/MicrophoneManager.ts` - To be removed
- `packages/cloud/src/services/session/transcription/TranscriptionManager.ts` - Currently owns VAD, will become listener
- `packages/cloud/src/services/session/translation/TranslationManager.ts` - Will become VAD listener

### Mobile

- TBD - needs mobile team input on relevant files

## Related Issues

- **009-bun-time/001-extract-message-routing** - VAD moves to AudioManager as part of message routing extraction
