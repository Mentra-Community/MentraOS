---
sidebar_position: 5
title: Message Types
---

# Message Types

This page documents the WebSocket message interfaces used for real-time communication in the MentraOS SDK.

## BaseMessage

The fundamental structure for all messages exchanged within the MentraOS system.

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

## App to Cloud Messages

### AppConnectionInit

Message sent by App to initiate connection with cloud.

```typescript
interface AppConnectionInit extends BaseMessage {
  type: AppToCloudMessageType.CONNECTION_INIT;
  packageName: string;
  sessionId: string; // Session ID obtained from webhook
  apiKey: string;    // App's API Key
}
```

**Note:** This message is automatically sent by the SDK when [`appSession.connect()`](/reference/app-session#connect) is called.

### AppSubscriptionUpdate

Message sent by App to update its active event subscriptions.

```typescript
interface AppSubscriptionUpdate extends BaseMessage {
  type: AppToCloudMessageType.SUBSCRIPTION_UPDATE;
  packageName: string;
  subscriptions: ExtendedStreamType[]; // List of StreamType or language-specific strings
}
```

**Note:** This message is automatically sent by the SDK when [`appSession.subscribe()`](/reference/app-session#subscribe) is called or when subscription settings change.

### DisplayRequest

Message sent from a App to request displaying a layout. Covered in detail in the [Layout Types](/reference/interfaces/layout-types) section.

```typescript
interface DisplayRequest extends BaseMessage {
  type: AppToCloudMessageType.DISPLAY_REQUEST;
  packageName: string;
  view: ViewType;
  layout: Layout;
  durationMs?: number;
  forceDisplay?: boolean;
}
```

**Note:** This message is automatically sent by the SDK when using [`appSession.layouts`](/reference/managers/layout-manager) methods.

### DashboardContentUpdate

Message sent from a App to update dashboard content.

```typescript
interface DashboardContentUpdate extends BaseMessage {
  type: AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE;
  packageName: string;
  sessionId: string;
  content: string;
  modes: DashboardMode[]; // Target dashboard modes
  timestamp: Date;
}
```

**Note:** This message is automatically sent by the SDK when using [`session.dashboard.content`](/reference/dashboard-api#class-dashboardcontentapi) methods.

## Cloud to App Messages

### AppConnectionAck

Message sent by cloud to App confirming successful connection and providing initial settings/config.

```typescript
interface AppConnectionAck extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ACK;
  settings?: AppSettings; // Current user settings for this App
  config?: AppConfig;     // App configuration fetched by the cloud (optional)
}
```

When this message is received, the SDK fires the `onConnected` event handler with the settings.

### AppConnectionError

Message sent by cloud to App indicating a connection failure.

```typescript
interface AppConnectionError extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ERROR;
  message: string; // Error description
  code?: string;    // Optional error code
}
```

### AppStopped

Message sent by cloud to App indicating the session has been stopped.

```typescript
interface AppStopped extends BaseMessage {
  type: CloudToAppMessageType.APP_STOPPED;
  reason: "user_disabled" | "system_stop" | "error"; // Reason for stopping
  message?: string; // Optional additional details
}
```

When this message is received, the SDK triggers the disconnect process and fires the `onDisconnected` event handler.

### SettingsUpdate

Message sent by cloud to App when the user updates the App's settings.

```typescript
interface SettingsUpdate extends BaseMessage {
  type: CloudToAppMessageType.SETTINGS_UPDATE;
  packageName: string;
  settings: AppSettings; // The complete new set of settings
}
```

When this message is received, the SDK updates its internal settings and fires the `onSettingsUpdate` event handler.

### DataStream

Wrapper message sent by cloud to App carrying data for a subscribed stream.

```typescript
interface DataStream extends BaseMessage {
  type: CloudToAppMessageType.DATA_STREAM; // Wrapper type
  streamType: StreamType; // The actual type of the data payload
  data: unknown; // The payload, type depends on streamType
}
```

The SDK unwraps this message and dispatches it to the appropriate event handlers based on the `streamType`.

### DashboardModeChanged

Message sent by cloud to App when the dashboard mode changes.

```typescript
interface DashboardModeChanged extends BaseMessage {
  type: CloudToAppMessageType.DASHBOARD_MODE_CHANGED;
  mode: DashboardMode; // The new dashboard mode
}
```

When this message is received, the SDK fires any registered `onModeChange` callbacks with the new mode.

### DashboardAlwaysOnChanged

Message sent by cloud to App when the always-on dashboard state changes.

```typescript
interface DashboardAlwaysOnChanged extends BaseMessage {
  type: CloudToAppMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
  enabled: boolean; // Whether always-on dashboard is now enabled
}
```

When this message is received, the SDK fires any registered always-on change callbacks.

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

### AppToCloudMessageType

Message types sent FROM App TO cloud.

```typescript
enum AppToCloudMessageType {
  CONNECTION_INIT = 'tpa_connection_init',
  SUBSCRIPTION_UPDATE = 'subscription_update',
  DISPLAY_REQUEST = 'display_event',
  DASHBOARD_CONTENT_UPDATE = 'dashboard_content_update'
}
```

### CloudToAppMessageType

Message types sent FROM cloud TO App.

```typescript
enum CloudToAppMessageType {
  CONNECTION_ACK = 'tpa_connection_ack',
  CONNECTION_ERROR = 'tpa_connection_error',
  APP_STOPPED = 'app_stopped',
  SETTINGS_UPDATE = 'settings_update',
  DATA_STREAM = 'data_stream',
  DASHBOARD_MODE_CHANGED = 'dashboard_mode_changed',
  DASHBOARD_ALWAYS_ON_CHANGED = 'dashboard_always_on_changed',
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
// For App to Cloud messages
function isAppConnectionInit(message: AppToCloudMessage): message is AppConnectionInit;
function isAppSubscriptionUpdate(message: AppToCloudMessage): message is AppSubscriptionUpdate;
function isDisplayRequest(message: AppToCloudMessage): message is DisplayRequest;
function isDashboardContentUpdate(message: AppToCloudMessage): message is DashboardContentUpdate;
function isDashboardModeChange(message: AppToCloudMessage): message is DashboardModeChange;
function isDashboardSystemUpdate(message: AppToCloudMessage): message is DashboardSystemUpdate;

// For Cloud to App messages
function isAppConnectionAck(message: CloudToAppMessage): message is AppConnectionAck;
function isAppConnectionError(message: CloudToAppMessage): message is AppConnectionError;
function isAppStopped(message: CloudToAppMessage): message is AppStopped;
function isSettingsUpdate(message: CloudToAppMessage): message is SettingsUpdate;
function isDataStream(message: CloudToAppMessage): message is DataStream | AudioChunk;
function isAudioChunk(message: CloudToAppMessage): message is AudioChunk;
function isDashboardModeChanged(message: CloudToAppMessage): message is DashboardModeChanged;
function isDashboardAlwaysOnChanged(message: CloudToAppMessage): message is DashboardAlwaysOnChanged;
```

## WebSocket Connection Flow

1. **Initialization**:
   - When [`appSession.connect()`](/reference/app-session#connect) is called, the SDK establishes a WebSocket connection to the URL provided
   - It sends a [`AppConnectionInit`](#appconnectioninit) message with the App's credentials

2. **Authentication**:
   - The cloud validates the credentials
   - If valid, it sends back a [`AppConnectionAck`](#appconnectionack) with the user's settings
   - If invalid, it sends back a [`AppConnectionError`](#appconnectionerror)

3. **Subscribing to Streams**:
   - The App can call [`appSession.subscribe()`](/reference/app-session#subscribe) to receive specific event types
   - The SDK sends a [`AppSubscriptionUpdate`](#appsubscriptionupdate) message to the cloud

4. **Receiving Data**:
   - The cloud sends data for subscribed streams either directly or wrapped in a [`DataStream`](#datastream) message
   - The SDK dispatches this data to the appropriate event handlers

5. **Session Termination**:
   - When a session is stopped, the cloud sends an [`AppStopped`](#appstopped) message
   - The SDK handles cleanup and fires the `onDisconnected` event handler