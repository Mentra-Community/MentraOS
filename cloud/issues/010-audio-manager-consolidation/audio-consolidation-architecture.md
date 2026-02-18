# Audio Manager Consolidation Architecture

## Current System

### Manager Responsibilities

```
AudioManager                          MicrophoneManager
├── processAudioData()                ├── updateState()
├── relayToSubscribedApps()           ├── sendMicStateToPhone()
├── getSubscribedApps()               ├── calculateRequiredData()
└── dispose()                         ├── debounceStateChanges()
                                      └── dispose()

TranscriptionManager
├── handleVad()  ← VAD lives here (wrong place)
├── startTranscription()
├── stopTranscription()
└── ...
```

### Current Data Flow

```
Phone Mic → Audio Data → Cloud
                           │
                           ├─ AudioManager.processAudioData()
                           │       │
                           │       └─ Relay to subscribed apps
                           │
                           └─ VAD Message
                                   │
                                   └─ TranscriptionManager.handleVad()
                                           │
                                           └─ Start/stop transcription only
                                              (TranslationManager can't access VAD)

Subscription Changes → SubscriptionManager
                              │
                              └─ MicrophoneManager.updateState()
                                      │
                                      ├─ Calculate required data
                                      ├─ Compare with last state
                                      ├─ Debounce
                                      └─ Send SET_MICROPHONE_STATE to phone
                                              │
                                              └─ Phone toggles mic (commanded)
```

### Problems Illustrated

**VAD Access Problem:**

```
TranscriptionManager owns VAD
        │
        └─ TranslationManager needs VAD
                │
                └─ No clean way to get it
                        │
                        └─ Would need to couple TranslationManager to TranscriptionManager
```

**Mic State Sync Problem:**

```
Subscription change #1 → MicrophoneManager → Send message
Subscription change #2 → MicrophoneManager → Send message (redundant if state same)
Subscription change #3 → MicrophoneManager → Send message (redundant)
...
Result: Spam of SET_MICROPHONE_STATE messages, need debouncing hacks
```

## Proposed System

### Consolidated AudioManager

```
AudioManager (consolidated)
├── Audio Data Processing
│   ├── processAudioData()
│   ├── bufferAudio()
│   └── relayToSubscribedApps()
│
├── VAD Management
│   ├── handleVad()
│   ├── vadState: boolean
│   ├── vadListeners: Set<VadListener>
│   ├── onVadChange(callback): unsubscribe
│   └── notifyVadListeners()
│
├── Mic Requirements
│   ├── currentRequirements: MicRequirements
│   ├── calculateRequirements(): MicRequirements
│   ├── publishRequirements()
│   └── onRequirementsChange()
│
└── Lifecycle
    ├── dispose()
    └── resources: ResourceTracker
```

### Proposed Data Flow

```
Phone Mic → Audio Data → Cloud
                           │
                           └─ AudioManager.processAudioData()
                                   │
                                   ├─ Buffer if needed
                                   └─ Relay to subscribed apps

VAD Message → AudioManager.handleVad()
                     │
                     ├─ Update vadState
                     └─ Notify listeners
                             │
                             ├─ TranscriptionManager.onVadChange()
                             ├─ TranslationManager.onVadChange()
                             └─ Apps subscribed to VAD stream

Subscription Changes → SubscriptionManager
                              │
                              └─ AudioManager.onSubscriptionsChanged()
                                      │
                                      ├─ Calculate new requirements
                                      ├─ Compare with current requirements
                                      └─ If changed: publishRequirements()
                                              │
                                              └─ Send MIC_REQUIREMENTS_UPDATE to phone
                                                      │
                                                      └─ Phone derives mic state (informed)
```

## Implementation Details

### Phase 1: VAD to AudioManager

#### Step 1: Add VAD Handling to AudioManager

```typescript
// packages/cloud/src/services/session/AudioManager.ts

import {Logger} from "pino"
import WebSocket from "ws"
import {StreamType, VadMessage} from "@mentra/sdk"
import {ResourceTracker} from "../../utils/resource-tracker"
import UserSession from "./UserSession"

type VadListener = (isSpeaking: boolean) => void

export class AudioManager {
  private userSession: UserSession
  private logger: Logger
  private resources = new ResourceTracker()
  private disposed = false

  // Existing audio processing
  private bufferedAudio: Buffer[] = []

  // VAD state and listeners
  private vadState: boolean = false
  private vadListeners: Set<VadListener> = new Set()

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "AudioManager"})
  }

  // ===== VAD Handling =====

  /**
   * Handle VAD message from glasses
   * Updates state and notifies all registered listeners
   */
  handleVad(message: VadMessage): void {
    const isSpeaking = message.isSpeaking

    if (this.vadState !== isSpeaking) {
      this.vadState = isSpeaking
      this.logger.debug({isSpeaking}, "VAD state changed")
      this.notifyVadListeners()
    }
  }

  /**
   * Register a VAD state change listener
   * @returns Unsubscribe function
   */
  onVadChange(callback: VadListener): () => void {
    this.vadListeners.add(callback)

    // Track for cleanup
    this.resources.track(() => {
      this.vadListeners.delete(callback)
    })

    return () => {
      this.vadListeners.delete(callback)
    }
  }

  /**
   * Get current VAD state
   */
  getVadState(): boolean {
    return this.vadState
  }

  private notifyVadListeners(): void {
    for (const listener of this.vadListeners) {
      try {
        listener(this.vadState)
      } catch (error) {
        this.logger.error({error}, "Error in VAD listener")
      }
    }
  }

  // ===== Existing Audio Processing =====

  processAudioData(data: Buffer | ArrayBuffer): void {
    if (this.disposed) return
    // ... existing implementation
  }

  // ... rest of existing methods

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    this.vadListeners.clear()
    this.bufferedAudio = []
    this.resources.dispose()

    this.logger.info("AudioManager disposed")
  }
}

export default AudioManager
```

#### Step 2: Update TranscriptionManager as VAD Listener

```typescript
// packages/cloud/src/services/session/transcription/TranscriptionManager.ts

export class TranscriptionManager {
  private userSession: UserSession
  private logger: Logger
  private unsubscribeVad?: () => void

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "TranscriptionManager"})

    // Register as VAD listener
    this.unsubscribeVad = userSession.audioManager.onVadChange((isSpeaking) => {
      this.handleVadStateChange(isSpeaking)
    })
  }

  /**
   * Handle VAD state changes (called by AudioManager)
   */
  private handleVadStateChange(isSpeaking: boolean): void {
    this.logger.debug({isSpeaking}, "VAD state change received")

    if (isSpeaking) {
      this.onSpeechStart()
    } else {
      this.onSpeechEnd()
    }
  }

  private onSpeechStart(): void {
    // ... existing speech start logic
  }

  private onSpeechEnd(): void {
    // ... existing speech end logic
  }

  dispose(): void {
    if (this.unsubscribeVad) {
      this.unsubscribeVad()
    }
    // ... rest of disposal
  }
}
```

#### Step 3: Update TranslationManager as VAD Listener

```typescript
// packages/cloud/src/services/session/translation/TranslationManager.ts

export class TranslationManager {
  private userSession: UserSession
  private logger: Logger
  private unsubscribeVad?: () => void

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "TranslationManager"})

    // Register as VAD listener
    this.unsubscribeVad = userSession.audioManager.onVadChange((isSpeaking) => {
      this.handleVadStateChange(isSpeaking)
    })
  }

  private handleVadStateChange(isSpeaking: boolean): void {
    this.logger.debug({isSpeaking}, "VAD state change received")
    // Translation-specific VAD handling
  }

  dispose(): void {
    if (this.unsubscribeVad) {
      this.unsubscribeVad()
    }
    // ... rest of disposal
  }
}
```

### Phase 2: Requirements Pattern

#### Message Type Definition

```typescript
// In @mentra/sdk types

export interface MicRequirementsUpdate {
  type: "mic_requirements_update"
  requirements: MicRequirements
  timestamp: Date
}

export interface MicRequirements {
  // Whether any app needs audio at all
  audioEnabled: boolean

  // Whether raw PCM is needed (vs just transcription)
  pcmRequired: boolean

  // Languages needed for transcription
  transcriptionLanguages: string[]

  // Whether translation is needed
  translationRequired: boolean
}
```

#### AudioManager Requirements Publishing

```typescript
// packages/cloud/src/services/session/AudioManager.ts

export class AudioManager {
  // ... existing code ...

  // ===== Mic Requirements =====

  private currentRequirements: MicRequirements = {
    audioEnabled: false,
    pcmRequired: false,
    transcriptionLanguages: [],
    translationRequired: false,
  }

  /**
   * Called when subscriptions change
   * Recalculates and publishes requirements if changed
   */
  onSubscriptionsChanged(): void {
    const newRequirements = this.calculateRequirements()

    if (!this.requirementsEqual(this.currentRequirements, newRequirements)) {
      this.currentRequirements = newRequirements
      this.publishRequirements()
    }
  }

  private calculateRequirements(): MicRequirements {
    const subscriptionManager = this.userSession.subscriptionManager

    return {
      audioEnabled: subscriptionManager.hasAudioSubscriptions(),
      pcmRequired: subscriptionManager.hasPCMSubscriptions(),
      transcriptionLanguages: subscriptionManager.getLanguageSubscriptions(),
      translationRequired: subscriptionManager.hasTranslationSubscriptions(),
    }
  }

  private requirementsEqual(a: MicRequirements, b: MicRequirements): boolean {
    return (
      a.audioEnabled === b.audioEnabled &&
      a.pcmRequired === b.pcmRequired &&
      a.translationRequired === b.translationRequired &&
      a.transcriptionLanguages.length === b.transcriptionLanguages.length &&
      a.transcriptionLanguages.every((lang, i) => lang === b.transcriptionLanguages[i])
    )
  }

  private publishRequirements(): void {
    const ws = this.userSession.websocket
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.warn("Cannot publish mic requirements: WebSocket not open")
      return
    }

    const message: MicRequirementsUpdate = {
      type: "mic_requirements_update",
      requirements: this.currentRequirements,
      timestamp: new Date(),
    }

    ws.send(JSON.stringify(message))
    this.logger.debug({requirements: this.currentRequirements}, "Published mic requirements")
  }

  /**
   * Get current requirements (for debugging/health checks)
   */
  getRequirements(): MicRequirements {
    return {...this.currentRequirements}
  }
}
```

### Phase 3: Remove MicrophoneManager

#### Update SubscriptionManager to Notify AudioManager

```typescript
// packages/cloud/src/services/session/SubscriptionManager.ts

export class SubscriptionManager {
  // ... existing code ...

  /**
   * Called when any subscription changes
   */
  private onSubscriptionChange(): void {
    // Notify AudioManager to recalculate requirements
    this.userSession.audioManager.onSubscriptionsChanged()

    // ... any other subscription change handling
  }
}
```

#### Update UserSession Constructor

```typescript
// packages/cloud/src/services/session/UserSession.ts

constructor(userId: string, websocket: WebSocket) {
  // ... existing initialization ...

  // Initialize AudioManager (now handles VAD + requirements)
  this.audioManager = new AudioManager(this);

  // Initialize SubscriptionManager
  this.subscriptionManager = new SubscriptionManager(this);

  // Initialize TranscriptionManager (registers as VAD listener in constructor)
  this.transcriptionManager = new TranscriptionManager(this);

  // Initialize TranslationManager (registers as VAD listener in constructor)
  this.translationManager = new TranslationManager(this);

  // NOTE: MicrophoneManager removed
  // this.microphoneManager = new MicrophoneManager(this); // DELETED
}
```

### Backward Compatibility

During transition, support both message types:

```typescript
// AudioManager.ts - backward compatibility

private publishRequirements(): void {
  const ws = this.userSession.websocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // New format
  const requirementsMessage: MicRequirementsUpdate = {
    type: "mic_requirements_update",
    requirements: this.currentRequirements,
    timestamp: new Date(),
  };
  ws.send(JSON.stringify(requirementsMessage));

  // Legacy format (for older clients)
  // TODO: Remove after mobile clients are updated
  if (config.features.sendLegacyMicState) {
    const legacyMessage = {
      type: "set_microphone_state",
      isEnabled: this.currentRequirements.audioEnabled,
      timestamp: new Date(),
    };
    ws.send(JSON.stringify(legacyMessage));
  }
}
```

## File Changes Summary

### Phase 1 (Cloud Only)

| File                      | Change                                                   |
| ------------------------- | -------------------------------------------------------- |
| `AudioManager.ts`         | Add VAD handling, listener pattern                       |
| `TranscriptionManager.ts` | Remove handleVad(), register as VAD listener             |
| `TranslationManager.ts`   | Register as VAD listener                                 |
| `UserSession.ts`          | Update handleGlassesMessage to route VAD to AudioManager |

### Phase 2 (Cloud + Mobile)

| File                | Change                                           |
| ------------------- | ------------------------------------------------ |
| `@mentra/sdk` types | Add MicRequirementsUpdate type                   |
| `AudioManager.ts`   | Add requirements calculation and publishing      |
| Mobile app          | Accept MIC_REQUIREMENTS_UPDATE, derive mic state |

### Phase 3 (Cloud Only)

| File                     | Change                                                 |
| ------------------------ | ------------------------------------------------------ |
| `MicrophoneManager.ts`   | DELETE                                                 |
| `UserSession.ts`         | Remove MicrophoneManager initialization and references |
| `SubscriptionManager.ts` | Call audioManager.onSubscriptionsChanged()             |

### Phase 4 (Cleanup)

| File              | Change                                     |
| ----------------- | ------------------------------------------ |
| `AudioManager.ts` | Remove legacy SET_MICROPHONE_STATE support |
| Mobile app        | Remove SET_MICROPHONE_STATE handling       |

## Testing Strategy

### Unit Tests

```typescript
// AudioManager.test.ts

describe("AudioManager VAD", () => {
  it("should notify listeners on VAD state change", () => {
    const audioManager = new AudioManager(mockUserSession)
    const listener = jest.fn()

    audioManager.onVadChange(listener)
    audioManager.handleVad({isSpeaking: true})

    expect(listener).toHaveBeenCalledWith(true)
  })

  it("should not notify on same state", () => {
    const audioManager = new AudioManager(mockUserSession)
    const listener = jest.fn()

    audioManager.onVadChange(listener)
    audioManager.handleVad({isSpeaking: true})
    audioManager.handleVad({isSpeaking: true}) // Same state

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("should unsubscribe listener", () => {
    const audioManager = new AudioManager(mockUserSession)
    const listener = jest.fn()

    const unsubscribe = audioManager.onVadChange(listener)
    unsubscribe()
    audioManager.handleVad({isSpeaking: true})

    expect(listener).not.toHaveBeenCalled()
  })
})

describe("AudioManager Requirements", () => {
  it("should publish requirements on subscription change", () => {
    const audioManager = new AudioManager(mockUserSession)
    const sendSpy = jest.spyOn(mockWebSocket, "send")

    audioManager.onSubscriptionsChanged()

    expect(sendSpy).toHaveBeenCalledWith(expect.stringContaining("mic_requirements_update"))
  })

  it("should not publish if requirements unchanged", () => {
    const audioManager = new AudioManager(mockUserSession)
    const sendSpy = jest.spyOn(mockWebSocket, "send")

    audioManager.onSubscriptionsChanged()
    sendSpy.mockClear()
    audioManager.onSubscriptionsChanged() // Same requirements

    expect(sendSpy).not.toHaveBeenCalled()
  })
})
```

### Integration Tests

1. VAD flow: Glasses VAD message → AudioManager → TranscriptionManager receives event
2. VAD flow: Glasses VAD message → AudioManager → TranslationManager receives event
3. Requirements: Subscription change → AudioManager → Phone receives requirements
4. Backward compat: Verify old mobile clients still work with legacy messages

## Open Questions

1. **VAD debouncing in AudioManager?**
   - Current: TranscriptionManager may have debouncing logic
   - Question: Move debouncing to AudioManager or keep in listeners?
   - **Recommendation**: Keep in listeners - different consumers may want different debounce behavior

2. **Requirements publish frequency limit?**
   - Should we rate-limit requirements publishing?
   - Probably not needed if we only publish on actual change
   - **Recommendation**: No rate limit, rely on change detection

3. **Phone acknowledgment of requirements?**
   - Should phone send ACK when it processes requirements?
   - Would help debugging but adds complexity
   - **Recommendation**: Not for initial implementation

4. **Error handling for failed VAD listeners?**
   - If one listener throws, should we continue notifying others?
   - **Recommendation**: Yes, wrap each listener call in try/catch
