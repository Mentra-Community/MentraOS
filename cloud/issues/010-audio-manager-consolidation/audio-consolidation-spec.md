# Audio Manager Consolidation Spec

## Overview

Consolidate `AudioManager` and `MicrophoneManager` into a single cohesive audio management system, move VAD handling to the audio layer, and replace the redundant mic state synchronization pattern with a requirements-based approach.

## Problem

### 1. VAD in Wrong Location

VAD (Voice Activity Detection) currently lives in `TranscriptionManager`:

```typescript
// TranscriptionManager.ts
async handleVad(message: VadMessage): Promise<void> {
  const isSpeaking = message.isSpeaking;
  // ... handle VAD
}
```

But VAD is an **audio-level signal**, not a transcription concern. Multiple consumers need VAD:

- TranscriptionManager (start/stop transcription)
- TranslationManager (start/stop translation)
- Apps subscribed to VAD stream
- Future audio-dependent features

Having VAD in TranscriptionManager means TranslationManager can't independently respond to speech detection without going through transcription logic.

### 2. Redundant Managers

Two managers handle related concerns:

**AudioManager** (`services/session/AudioManager.ts`):

- Receives PCM audio from WebSocket
- Buffers audio data
- Relays to subscribed apps
- ~280 lines

**MicrophoneManager** (`services/session/MicrophoneManager.ts`):

- Tracks mic on/off state
- Sends `SET_MICROPHONE_STATE` to phone
- Calculates "required data" from subscriptions
- Complex state reconciliation
- ~450 lines

These should be one manager since they're both about "audio flow control."

### 3. Polling-Like Mic State Sync

MicrophoneManager sends mic state messages on every subscription change:

```typescript
// MicrophoneManager.ts
updateState(requiresAudio: boolean, requiredData: RequiredAudioData) {
  // Called frequently
  // Compares with last state
  // Sends SET_MICROPHONE_STATE if different
}
```

This pattern has problems:

- Sends redundant messages when state hasn't changed
- Race conditions during rapid subscription changes
- Requires debouncing logic to avoid spam
- Cloud is "commanding" phone instead of "informing" it

Evidence: The code has debounce timers and "last state" tracking to reduce redundant messages - this is a symptom of the architectural issue.

### Constraints

- **Mobile client dependency**: Phone app expects `SET_MICROPHONE_STATE` messages
- **Backward compatibility**: Can't break existing mobile clients during transition
- **Gradual rollout**: Need transition period where both patterns work
- **Multiple consumers**: VAD must support multiple listeners, not just transcription

## Goals

### 1. VAD Ownership

Move VAD to AudioManager with listener pattern:

```typescript
class AudioManager {
  handleVad(message: VadMessage): void {
    // Update state
    // Notify all registered listeners
  }

  onVadChange(callback: (isSpeaking: boolean) => void): () => void {
    // Register listener, return unsubscribe function
  }
}
```

TranscriptionManager and TranslationManager become VAD listeners, not owners.

### 2. Manager Consolidation

Single AudioManager handles:

- Audio data reception and buffering
- Audio relay to subscribed apps
- VAD state and event emission
- Mic requirements calculation
- Phone communication about audio needs

### 3. Requirements-Based Sync

Replace "mic on/off commands" with "requirements publishing":

**Current (Command Pattern)**:

```
Cloud: "Turn mic ON" / "Turn mic OFF"
Phone: Obeys command
```

**Proposed (Requirements Pattern)**:

```
Cloud: "Current requirements: { audio: true, pcm: false, languages: ['en-US'] }"
Phone: Derives mic state from requirements, manages its own hardware
```

Benefits:

- Phone is source of truth for mic state
- No redundant messages (only send when requirements change)
- Phone can optimize (e.g., batch multiple requirement changes)
- Cleaner separation of concerns

## Non-Goals

- **Changing audio encoding/format** - Wire protocol stays the same
- **Changing subscription system** - SubscriptionManager unchanged
- **Rewriting TranscriptionManager** - Just becomes VAD listener
- **Phone mic hardware management** - Phone still controls its own mic

## Success Metrics

| Metric                      | Current                  | Target                     |
| --------------------------- | ------------------------ | -------------------------- |
| Managers for audio concerns | 2 (Audio + Microphone)   | 1 (AudioManager)           |
| VAD consumers supported     | 1 (TranscriptionManager) | N (any listener)           |
| Mic state messages/minute   | Variable (redundant)     | Only on requirement change |
| Code duplication            | High                     | Minimal                    |

## Migration Path

### Phase 1: VAD to AudioManager (Cloud Only)

1. Add VAD handling to AudioManager
2. Add listener registration pattern
3. TranscriptionManager registers as VAD listener
4. TranslationManager registers as VAD listener
5. Remove VAD handling from TranscriptionManager

**No mobile changes required.**

### Phase 2: Requirements Pattern (Cloud + Mobile)

1. Define `MIC_REQUIREMENTS_UPDATE` message type
2. AudioManager publishes requirements instead of commands
3. Mobile app accepts new message type
4. Mobile derives mic state from requirements
5. Deprecate `SET_MICROPHONE_STATE` (keep for backward compat)

**Requires mobile team coordination.**

### Phase 3: Consolidation (Cloud Only)

1. Move remaining MicrophoneManager logic to AudioManager
2. Remove MicrophoneManager class
3. Update all references

**No mobile changes required.**

### Phase 4: Cleanup

1. Remove deprecated `SET_MICROPHONE_STATE` support
2. Remove backward compatibility code
3. Update documentation

**Requires all mobile clients updated.**

## Open Questions

1. **Requirements message format?**
   - Option A: Flat object `{ audio: bool, pcm: bool, languages: string[] }`
   - Option B: Nested `{ audio: { enabled: bool, format: 'pcm' }, transcription: { languages: [] } }`
   - **Leaning**: Option A for simplicity

2. **Backward compatibility duration?**
   - How long to support both `SET_MICROPHONE_STATE` and `MIC_REQUIREMENTS_UPDATE`?
   - Depends on mobile app update adoption rate
   - **Suggestion**: 2-3 release cycles

3. **VAD debouncing?**
   - Should AudioManager debounce rapid VAD changes before notifying listeners?
   - Or let each listener handle their own debouncing?
   - **Leaning**: Let listeners handle it (different consumers may want different behavior)

4. **Phone-side mic state feedback?**
   - Should phone report actual mic state back to cloud?
   - Useful for debugging but adds complexity
   - **Leaning**: Nice to have, not required for initial implementation
