# Session Service Refactoring Plan

## Overview

This document outlines the refactoring plan for the Session Service, which is part of the larger WebSocket service refactoring effort. The goal is to create a more modular, maintainable architecture with clearer separation of concerns.

## Current Issues

1. **Split Responsibilities**: Session-related functionality is currently split between session.service.ts and websocket.service.ts
2. **Mixed Concerns**: Session management is mixed with WebSocket handling
3. **Inconsistent Error Handling**: Error handling varies across different functions
4. **Limited Manager Pattern**: Some components use the manager pattern, but not consistently
5. **Missing Functionality**: Key functions like transcription management are not properly encapsulated
6. **Tight Coupling**: WebSocket and session logic are tightly coupled

## Refactoring Goals

1. **Consolidate Session Logic**: Move all session-related functions from websocket.service.ts to session.service.ts
2. **Implement Manager Pattern**: Use the manager pattern consistently for all components
3. **Improve Error Handling**: Implement consistent error handling patterns
4. **Clarify Responsibilities**: Make it clear which service handles which functionality
5. **Ensure No Regression**: Preserve all existing functionality while improving architecture

## New Directory Structure

```
/packages/cloud/src/services/
├── session/
│   ├── session.service.ts       # Enhanced session service
│   ├── MicrophoneManager.ts     # Microphone state management
│   ├── docs/
│   │   ├── OLD-SESSION-SERVICE.md  # Documentation of original service
│   │   ├── SESSION-SERVICE-REFACTORING.md  # This document
│   │   └── IMPROVED-SESSION-SERVICE.md  # Documentation of new design
├── websocket/
│   ├── websocket.service.ts     # Core WebSocket setup
│   ├── websocket-tpa.service.ts # TPA connection handling
│   ├── websocket-glasses.service.ts # Glasses connection handling
│   └── REFACTORING-PLAN.md      # WebSocket refactoring plan
```

## Important Implementation Note

**Regarding Subscription Management**: While the session interface shows a `subscriptionManager` property, our implementation should continue to use the existing `subscriptionService` instead. The `SubscriptionManager` is not fully implemented yet, and introducing it at this stage would be risky. We should stick with the proven `subscriptionService` to ensure stability during this refactoring.

Example of how to use the subscription service:
```typescript
// Instead of using userSession.subscriptionManager
const hasMediaSubscriptions = subscriptionService.hasMediaSubscriptions(userSession.sessionId);
const subscribedApps = subscriptionService.getSubscribedApps(userSession, streamType);
```

This approach ensures we maintain compatibility with existing code while refactoring.

## Functions to Add to Session Service

### Transcription Management

1. **handleTranscriptionStart(userSession)**
   - Start transcription for a user session
   - Update session transcription state
   - Handle errors appropriately

2. **handleTranscriptionStop(userSession)**
   - Stop transcription for a user session
   - Update session transcription state
   - Handle errors appropriately

### User Settings Management

3. **getUserSettings(userId)**
   - Retrieve user settings from database
   - Return default settings if database access fails
   - Format settings for client consumption

### Message Relaying

4. **relayMessageToTpas(userSession, streamType, data)**
   - Relay messages to subscribed TPAs
   - Filter based on subscriptions
   - Format messages appropriately

5. **relayAudioToTpas(userSession, audioData)**
   - Relay audio data to subscribed TPAs
   - Handle binary data appropriately
   - Optimize for performance

### App Lifecycle Management

6. **startAppSession(userSession, packageName)**
   - Handle app startup
   - Trigger webhooks
   - Update session state
   - Handle errors appropriately

7. **stopAppSession(userSession, packageName)**
   - Handle app shutdown
   - Clean up resources
   - Update session state
   - Handle errors appropriately

8. **isAppRunning(userSession, packageName)**
   - Check if an app is already running
   - Used by other functions to prevent duplicate starts

### Session State Management

9. **handleTpaInit(ws, initMessage, setCurrentSessionId)**
   - Handle TPA initialization
   - Set up TPA session
   - Validate authentication
   - Handle errors appropriately

10. **handleAppStateBroadcast(userSession)**
    - Broadcast app state to all connected clients
    - Format state data appropriately
    - Handle errors appropriately

## Existing Functions to Preserve

All existing functions from the original session.service.ts will be preserved with their current behavior:

1. **createSession(ws, userId)**
2. **getSession(sessionId)**
3. **transformUserSessionForClient(userSession)**
4. **triggerAppStateChange(userId)**
5. **updateDisplay(userSessionId, displayRequest)**
6. **addTranscriptSegment(userSession, segment, language)**
7. **handleAudioData(userSession, audioData, isLC3)**
8. **endSession(userSession)**
9. **getAllSessions()**
10. **getSessionByUserId(userId)**
11. **getSessionsForUser(userId)**
12. **markSessionDisconnected(userSession)**
13. **getAudioServiceInfo(sessionId)**

## Error Handling Architecture

The improved error handling architecture will follow the pattern established in the WebSocket refactoring:

1. **Function-level try/catch**:
```typescript
async function handleSomething(userSession: ExtendedUserSession): Promise<void> {
  try {
    // Function-specific logic
  } catch (error) {
    userSession.logger.error(`Error handling something:`, {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    });
    // Handle error appropriately, do not propagate
  }
}
```

2. **Consistent Error Logging**:
- Use structured logging with context
- Include appropriate details without sensitive information
- Use consistent log levels

3. **Error Recovery**:
- Services should recover gracefully from errors
- Avoid terminating sessions due to non-critical errors
- Implement appropriate fallbacks

## Integration with New WebSocket Services

The new WebSocket services will use the session service for:

1. **Session Creation**: When users connect
2. **Message Processing**: Delegate to session methods
3. **Session State**: Access and update session state
4. **Session Termination**: When users disconnect

```typescript
// Example integration in websocket-glasses.service.ts
private async handleVad(userSession: ExtendedUserSession, message: Vad): Promise<void> {
  const userId = userSession.userId;
  const isSpeaking = message.status === true || message.status === 'true';
  
  if (isSpeaking) {
    userSession.logger.info(`🎙️ VAD detected speech - starting transcription for user: ${userId}`);
    userSession.isTranscribing = true;
    await sessionService.handleTranscriptionStart(userSession);
  } else {
    userSession.logger.info(`🤫 VAD detected silence - stopping transcription for user: ${userId}`);
    userSession.isTranscribing = false;
    await sessionService.handleTranscriptionStop(userSession);
  }
}
```

## Migration Strategy

Our migration strategy emphasizes safety and maintainability:

1. Create a new session.service.ts in the session directory
2. Keep the original session.service.ts untouched
3. Implement all functionality in the new service
4. Update the new WebSocket services to use the new session service
5. Test both implementations side-by-side
6. Only remove the original implementation once the new one is confirmed working

## Benefits

1. **Improved Maintainability**: Smaller, focused components with clear responsibilities
2. **Better Error Handling**: Consistent error handling with proper recovery
3. **Clearer Architecture**: Proper separation between WebSocket handling and session logic
4. **Improved Developer Experience**: Easier to understand and modify
5. **Future Extensibility**: Cleaner structure for adding new functionality

## Risks and Mitigations

| Risk | Description | Mitigation |
|------|-------------|------------|
| Regression | Loss of existing functionality | Comprehensive testing, no modifications to original code |
| Incomplete Migration | Missing some functionality | Thorough analysis of both services before implementation |
| Performance Impact | New architecture could affect performance | Performance testing with both implementations |
| Backward Compatibility | Breaking changes | Keep original implementation available during transition |