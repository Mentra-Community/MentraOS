---
sidebar_position: 3
title: TpaSession
---


# TpaSession

`TpaSession` (also known as `TpaClient` in older documentation) manages an active WebSocket connection (session) between an app instance and AugmentOS Cloud. It handles event subscriptions, layout display, and connection management for a single user session.

```typescript
import { TpaSession } from '@augmentos/sdk';
```

## Constructor

```typescript
constructor(config: TpaSessionConfig)
```

**Parameters:**
- `config`: [Configuration](#configuration) options for the app session

## Properties

### events

Provides access to the [`EventManager`](/reference/managers/event-manager) for subscribing to real-time events.

```typescript
readonly events: EventManager
```

### layouts

Provides access to the [`LayoutManager`](/reference/managers/layout-manager) for controlling the AR display.

```typescript
readonly layouts: LayoutManager
```

### settings

Provides access to the [`SettingsManager`](/reference/managers/settings-manager) for reading and monitoring app settings.

```typescript
readonly settings: SettingsManager
```

## Event Handling Methods

### onTranscription()

Registers a handler for real-time speech transcription events.

```typescript
onTranscription(handler: (data: TranscriptionData) => void): () => void
```

**Parameters:**
- `handler`: Callback function to process [`TranscriptionData`](/reference/interfaces/event-types#transcriptiondata)

**Returns:** An unsubscribe function to remove the handler

### onHeadPosition()

Registers a handler for head position change events (e.g., 'up', 'down').

```typescript
onHeadPosition(handler: (data: HeadPosition) => void): () => void
```

**Parameters:**
- `handler`: Callback function to process [`HeadPosition`](/reference/interfaces/event-types#headposition) data

**Returns:** An unsubscribe function to remove the handler

### onButtonPress()

Registers a handler for hardware button press events on the glasses.

```typescript
onButtonPress(handler: (data: ButtonPress) => void): () => void
```

**Parameters:**
- `handler`: Callback function to process [`ButtonPress`](/reference/interfaces/event-types#buttonpress) data

**Returns:** An unsubscribe function to remove the handler

### onPhoneNotifications()

Registers a handler for notifications received from the connected phone.

```typescript
onPhoneNotifications(handler: (data: PhoneNotification) => void): () => void
```

**Parameters:**
- `handler`: Callback function to process [`PhoneNotification`](/reference/interfaces/event-types#phonenotification) data

**Returns:** An unsubscribe function to remove the handler

## Subscription Methods

### subscribe()

Informs the AugmentOS Cloud that this app session wants to receive events of the specified type.

```typescript
subscribe(type: StreamType): void
```

**Parameters:**
- `type`: The [`StreamType`](/reference/enums#streamtype) to subscribe to

### on()

Generic method to subscribe to any data stream type. Use specific `on<EventType>` methods where available.

```typescript
on<T extends StreamType>(
  event: T,
  handler: (data: StreamDataTypes[T]) => void
): () => void
```

**Parameters:**
- `event`: The [`StreamType`](/reference/enums#streamtype) to listen for
- `handler`: Callback function to process the data associated with the stream type

**Returns:** An unsubscribe function to remove the handler

## Connection Methods

### connect()

Establishes the WebSocket connection to AugmentOS Cloud for this session.

```typescript
connect(sessionId: string): Promise<void>
```

**Parameters:**
- `sessionId`: The unique identifier for this session (provided by the [`SESSION_REQUEST`](/reference/interfaces/webhook-types#sessionwebhookrequest) webhook)

**Returns:** A promise that resolves upon successful connection and authentication, or rejects on failure

### disconnect()

Gracefully closes the WebSocket connection and cleans up resources for this session.

```typescript
disconnect(): void
```

## Settings Methods

### getSettings()

Retrieves all current application settings for this user session.

```typescript
getSettings(): AppSettings
```

**Returns:** A copy of the current [`AppSettings`](/reference/interfaces/config-types#appsettings)

### getSetting()

Retrieves the value of a specific application setting by its key.

```typescript
getSetting<T>(key: string): T | undefined
```

**Parameters:**
- `key`: The key of the setting to retrieve

**Returns:** The value of the setting, or undefined if not found or not set

### setSubscriptionSettings()

Configures the app session to automatically manage subscriptions based on changes to specific settings.

```typescript
setSubscriptionSettings(options: {
  updateOnChange: string[];
  handler: (settings: AppSettings) => StreamType[];
}): void
```

**Parameters:**
- `options`: Configuration object
	- `options.updateOnChange`: An array of setting keys that should trigger a subscription update when their value changes
	- `options.handler`: A function that takes the current [`AppSettings`](/reference/interfaces/config-types#appsettings) and returns an array of [`StreamType`](/reference/enums#streamtype) subscriptions that should be active

## Configuration

```typescript
interface TpaSessionConfig {
  /** Your unique app identifier (e.g., 'org.company.appname'). */
  packageName: string;

  /** Your API key for authentication. */
  apiKey: string;

  /** The WebSocket URL provided by AugmentOS Cloud. Defaults to 'ws://localhost:8002/tpa-ws'. */
  augmentOSWebsocketUrl?: string;

  /** Whether the session should automatically attempt to reconnect if the connection drops. Defaults to `false`. */
  autoReconnect?: boolean;

  /** Maximum number of reconnection attempts if `autoReconnect` is true. Default: 0 (no limit). */
  maxReconnectAttempts?: number;

  /** Initial delay (in ms) before the first reconnection attempt. Delay increases exponentially. Defaults to 1000. */
  reconnectDelay?: number;
}
```