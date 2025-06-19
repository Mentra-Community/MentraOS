---
sidebar_position: 5
title: Message Types
---

# Message Types

This page documents the WebSocket message interfaces used for real-time communication in the AugmentOS SDK.

## BaseMessage

The fundamental structure for all messages exchanged within the AugmentOS system.

```typescript
interface BaseMessage {
  /** A string identifying the specific type of the message. */
  type: string;
  
  /** Optional timestamp indicating when the message was created. */
  timestamp?: Date;
  
  /** Optional session identifier, used for routing messages related to a specific user session. */
  sessionId?: string;
}
```

## TPA to Cloud Messages

### TpaConnectionInit

Message sent by TPA to initiate connection with cloud.

```typescript
interface TpaConnectionInit extends BaseMessage {
  type: TpaToCloudMessageType.CONNECTION_INIT;
  packageName: string;
  sessionId: string; // Session ID obtained from webhook
  apiKey: string;    // TPA's API Key
}
```

**Note:** This message is automatically sent by the SDK when [`tpaSession.connect()`](/reference/tpa-session#connect) is called.

### TpaSubscriptionUpdate

Message sent by TPA to update its active event subscriptions.

```typescript
interface TpaSubscriptionUpdate extends BaseMessage {
  type: TpaToCloudMessageType.SUBSCRIPTION_UPDATE;
  packageName: string;
  subscriptions: ExtendedStreamType[]; // List of StreamType or language-specific strings
}
```

**Note:** This message is automatically sent by the SDK when [`tpaSession.subscribe()`](/reference/tpa-session#subscribe) is called or when subscription settings change.

### DisplayRequest

Message sent from a TPA to request displaying a layout. Covered in detail in the [Layout Types](/reference/interfaces/layout-types) section.

```typescript
interface DisplayRequest extends BaseMessage {
  type: TpaToCloudMessageType.DISPLAY_REQUEST;
  packageName: string;
  view: ViewType;
  layout: Layout;
  durationMs?: number;
  forceDisplay?: boolean;
}
```

**Note:** This message is automatically sent by the SDK when using [`tpaSession.layouts`](/reference/managers/layout-manager) methods.

## Cloud to TPA Messages

### TpaConnectionAck

Message sent by cloud to TPA confirming successful connection and providing initial settings/config.

```typescript
interface TpaConnectionAck extends BaseMessage {
  type: CloudToTpaMessageType.CONNECTION_ACK;
  settings?: AppSettings; // Current user settings for this TPA
  config?: TpaConfig;     // TPA configuration fetched by the cloud (optional)
}
```

When this message is received, the SDK fires the `onConnected` event handler with the settings.

### TpaConnectionError

Message sent by cloud to TPA indicating a connection failure.

```typescript
interface TpaConnectionError extends BaseMessage {
  type: CloudToTpaMessageType.CONNECTION_ERROR;
  message: string; // Error description
  code?: string;    // Optional error code
}
```

### AppStopped

Message sent by cloud to TPA indicating the session has been stopped.

```typescript
interface AppStopped extends BaseMessage {
  type: CloudToTpaMessageType.APP_STOPPED;
  reason: "user_disabled" | "system_stop" | "error"; // Reason for stopping
  message?: string; // Optional additional details
}
```

When this message is received, the SDK triggers the disconnect process and fires the `onDisconnected` event handler.

### SettingsUpdate

Message sent by cloud to TPA when the user updates the TPA's settings.

```typescript
interface SettingsUpdate extends BaseMessage {
  type: CloudToTpaMessageType.SETTINGS_UPDATE;
  packageName: string;
  settings: AppSettings; // The complete new set of settings
}
```

When this message is received, the SDK updates its internal settings and fires the `onSettingsUpdate` event handler.

### DataStream

Wrapper message sent by cloud to TPA carrying data for a subscribed stream.

```typescript
interface DataStream extends BaseMessage {
  type: CloudToTpaMessageType.DATA_STREAM; // Wrapper type
  streamType: StreamType; // The actual type of the data payload
  data: unknown; // The payload, type depends on streamType
}
```

The SDK unwraps this message and dispatches it to the appropriate event handlers based on the `streamType`.

## Stream Data Messages

Stream data can either be sent wrapped in a `DataStream` message or directly as its own message type.

### TranscriptionData

Data for real-time speech transcription. See [Event Types](/reference/interfaces/event-types#transcriptiondata) for details.

```typescript
interface TranscriptionData extends BaseMessage {
  type: StreamType.TRANSCRIPTION;
  text: string;
  isFinal: boolean;
  // Other properties...
}
```

### TranslationData

Data for real-time speech translation. See [Event Types](/reference/interfaces/event-types#translationdata) for details.

```typescript
interface TranslationData extends BaseMessage {
  type: StreamType.TRANSLATION;
  text: string;
  isFinal: boolean;
  // Other properties...
}
```

### AudioChunk

Raw audio data chunk. See [Event Types](/reference/interfaces/event-types#audiochunk) for details.

```typescript
interface AudioChunk extends BaseMessage {
  type: StreamType.AUDIO_CHUNK;
  arrayBuffer: ArrayBufferLike;
  sampleRate?: number;
}
```

## Error-Related Messages

### WebSocketError

Structure for reporting WebSocket-specific errors.

```typescript
interface WebSocketError {
  /** An error code string. */
  code: string;
  
  /** A human-readable description of the error. */
  message: string;
  
  /** Optional additional details about the error. */
  details?: unknown;
}
```

When a WebSocket error occurs, the SDK fires the `onError` event handler with this object.

## Message Type Enums

Four enums are used to identify the types of messages exchanged between different components:

### TpaToCloudMessageType

Message types sent FROM TPA TO cloud.

```typescript
enum TpaToCloudMessageType {
  CONNECTION_INIT = 'tpa_connection_init',
  SUBSCRIPTION_UPDATE = 'subscription_update',
  DISPLAY_REQUEST = 'display_event'
}
```

### CloudToTpaMessageType

Message types sent FROM cloud TO TPA.

```typescript
enum CloudToTpaMessageType {
  CONNECTION_ACK = 'tpa_connection_ack',
  CONNECTION_ERROR = 'tpa_connection_error',
  APP_STOPPED = 'app_stopped',
  SETTINGS_UPDATE = 'settings_update',
  DATA_STREAM = 'data_stream',
  WEBSOCKET_ERROR = 'websocket_error'
}
```

### GlassesToCloudMessageType

Message types sent FROM glasses TO cloud.

```typescript
enum GlassesToCloudMessageType {
  CONNECTION_INIT = 'connection_init',
  START_APP = 'start_app',
  STOP_APP = 'stop_app',
  // Many more types...
}
```

### CloudToGlassesMessageType

Message types sent FROM cloud TO glasses.

```typescript
enum CloudToGlassesMessageType {
  CONNECTION_ACK = 'connection_ack',
  CONNECTION_ERROR = 'connection_error',
  AUTH_ERROR = 'auth_error',
  // More types...
}
```

## Type Guards

The SDK provides type guard functions to identify message types:

```typescript
// For TPA to Cloud messages
function isTpaConnectionInit(message: TpaToCloudMessage): message is TpaConnectionInit;
function isTpaSubscriptionUpdate(message: TpaToCloudMessage): message is TpaSubscriptionUpdate;
function isDisplayRequest(message: TpaToCloudMessage): message is DisplayRequest;

// For Cloud to TPA messages
function isTpaConnectionAck(message: CloudToTpaMessage): message is TpaConnectionAck;
function isTpaConnectionError(message: CloudToTpaMessage): message is TpaConnectionError;
function isAppStopped(message: CloudToTpaMessage): message is AppStopped;
function isSettingsUpdate(message: CloudToTpaMessage): message is SettingsUpdate;
function isDataStream(message: CloudToTpaMessage): message is DataStream | AudioChunk;
function isAudioChunk(message: CloudToTpaMessage): message is AudioChunk;
```

## WebSocket Connection Flow

1. **Initialization**:
   - When [`tpaSession.connect()`](/reference/tpa-session#connect) is called, the SDK establishes a WebSocket connection to the URL provided
   - It sends a [`TpaConnectionInit`](#tpaconnectioninit) message with the TPA's credentials

2. **Authentication**:
   - The cloud validates the credentials
   - If valid, it sends back a [`TpaConnectionAck`](#tpaconnectionack) with the user's settings
   - If invalid, it sends back a [`TpaConnectionError`](#tpaconnectionerror)

3. **Subscribing to Streams**:
   - The TPA can call [`tpaSession.subscribe()`](/reference/tpa-session#subscribe) to receive specific event types
   - The SDK sends a [`TpaSubscriptionUpdate`](#tpasubscriptionupdate) message to the cloud

4. **Receiving Data**:
   - The cloud sends data for subscribed streams either directly or wrapped in a [`DataStream`](#datastream) message
   - The SDK dispatches this data to the appropriate event handlers

5. **Session Termination**:
   - When a session is stopped, the cloud sends an [`AppStopped`](#appstopped) message
   - The SDK handles cleanup and fires the `onDisconnected` event handler 