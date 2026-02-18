# Subscription Race Condition Spec

## Overview

App subscription updates are processed concurrently on the cloud, causing race conditions where the final subscription state doesn't match what the SDK intended.

## Problem

### Symptom

Apps lose subscriptions during session startup. Example: Recorder app subscribes to `audio_chunk` AND `transcription:en-US`, but only `audio_chunk` ends up active.

### Root Cause

Two issues combine to create this bug:

1. **SDK sends multiple subscription updates rapidly during startup**
   - `handleMessage()` after CONNECTION_ACK: sends `[]` (0 handlers exist yet)
   - `onAudioChunk()` handler setup: sends `[audio_chunk]`
   - `onTranscriptionForLanguage()` handler setup: sends `[audio_chunk, transcription:en-US]`

2. **Cloud processes messages concurrently**
   - Bun's WebSocket `message` handler is async
   - Bun doesn't await the handler - just fires and forgets
   - Multiple messages start processing simultaneously
   - Last one to finish wins, regardless of arrival order

### Code Path

**SDK side** (`packages/sdk/src/app/session/index.ts`):

```typescript
// In handleMessage() after CONNECTION_ACK - line ~1313
this.events.emit("connected", this.settingsData)
this.updateSubscriptions() // Sends [] because onSession hasn't run yet
```

**Cloud side** (`packages/cloud/src/services/websocket/bun-websocket.ts`):

```typescript
// Line ~222
async message(ws: CloudServerWebSocket, message: string | Buffer) {
  if (ws.data.type === "app") {
    await handleAppMessage(ws as AppServerWebSocket, message);  // NOT awaited by Bun!
  }
}
```

**Cloud message handler** (`packages/cloud/src/services/session/handlers/app-message-handler.ts`):

```typescript
// Line ~181
await userSession.subscriptionManager.updateSubscriptions(message.packageName, message.subscriptions)
// This await only serializes within ONE message, not across messages
```

### Timeline

```
SDK                                    Cloud
 |                                      |
 |--[CONNECTION_INIT]------------------>|
 |<-[CONNECTION_ACK]--------------------|
 |                                      |
 |--[SUBSCRIPTION_UPDATE: []]---------->| → starts async processing
 |--[SUBSCRIPTION_UPDATE: [audio]]----->| → starts async processing
 |--[SUBSCRIPTION_UPDATE: [audio,trans]]>| → starts async processing
 |                                      |
 |                            [audio,trans] finishes first → state = [audio,trans]
 |                            [] finishes (ignored by grace window)
 |                            [audio] finishes LAST → state = [audio] ← BUG!
```

## Constraints

- Can't change Bun's WebSocket behavior (it's a framework design choice)
- SDK is published to npm - changes require new release and apps to update
- Must maintain backward compatibility with existing apps
- Can't add significant latency to message processing

## Goals

1. Subscription updates for the same app must be processed in arrival order
2. Fix should be transparent to SDK (no SDK changes required for fix to work)
3. No significant performance impact for normal message flow

## Non-Goals

- Fixing SDK's redundant `updateSubscriptions()` call (separate issue, nice to have)
- Changing the subscription protocol
- Adding acknowledgment/confirmation for subscriptions

## Solution Options

### Option 1: Queue in AppSession (Chosen)

Add a queue to `AppSession` that serializes async operations.

**Pros:**

- Per-app state belongs in AppSession (queue is inherently per-app)
- Automatic cleanup when AppSession.dispose() is called
- No module-level Maps or exported cleanup functions
- Handler stays stateless, SubscriptionManager stays focused on coordination
- Encapsulated - callers don't need to know about serialization

**Cons:**

- Slightly more refactoring than handler-level fix

### Option 2: Queue in Message Handler

Add a module-level Map in `app-message-handler.ts` to serialize.

**Pros:**

- Quick to implement
- Catches races at WebSocket level

**Cons:**

- Handler becomes stateful (handlers should be pure routing)
- Module-level Map requires manual cleanup functions
- Queue management decoupled from the state it's serializing

### Option 3: Queue in SubscriptionManager

Add per-app queue Map in SubscriptionManager.

**Pros:**

- SubscriptionManager is the entry point for subscription changes

**Cons:**

- SubscriptionManager coordinates across apps, not per-app state
- Would need to maintain Map<packageName, Promise> which is AppSession's job

### Option 4: SDK Fix Only

Remove redundant `updateSubscriptions()` in SDK's `handleMessage()`.

**Pros:**

- Reduces message count from 3 to 2
- Simpler than cloud fix

**Cons:**

- Doesn't fix the fundamental race condition
- Requires SDK release + app updates
- Could still race with 2 messages

## Decision

Implement **Option 1 (Queue in AppSession)** because:

- Per-app state belongs in the per-app object
- Automatic cleanup (no manual cleanup functions needed)
- Encapsulation (callers of updateSubscriptions don't need to serialize)
- Handler stays stateless
- SDK fix can be done later as optimization

## Open Questions

1. **Queue implementation?**
   - Simple array with shift/push
   - Or use async-mutex library
   - **Decision**: Simple promise chain (no library needed)

2. **Queue cleanup timing?**
   - On app disconnect
   - On session end
   - **Decision**: Automatic - queue is instance property, dies with AppSession

3. **Should we also fix SDK?**
   - Reduces unnecessary messages
   - **Decision**: Yes, as follow-up (separate PR)

4. **Where should queue live?**
   - Message handler (module-level Map)
   - SubscriptionManager (per-app Map)
   - AppSession (instance property)
   - **Decision**: AppSession - per-app state belongs in per-app object
