---
sidebar_position: 1
title: EventManager
---

# EventManager

The `EventManager` handles event subscriptions and dispatching within a [`AppSession`](/reference/app-session). It provides methods for subscribing to various event types from the MentraOS platform.

You access the EventManager through the `events` property of a [`AppSession`](/reference/app-session) instance:

```typescript
const eventManager = appSession.events
```

## Event Handler Methods

### onTranscription()

Registers a handler for real-time speech transcription events.

```typescript
onTranscription(handler: (data: TranscriptionData) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`TranscriptionData`](/reference/interfaces/event-types#transcriptiondata) objects

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
const unsubscribe = appSession.events.onTranscription(data => {
  console.log(`Transcription: ${data.text}, Final: ${data.isFinal}`)
  if (data.isFinal) {
    // Process the final transcription
  }
})

// Later, to stop receiving events:
unsubscribe()
```

### onHeadPosition()

Registers a handler for head position change events.

```typescript
onHeadPosition(handler: (data: HeadPosition) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`HeadPosition`](/reference/interfaces/event-types#headposition) objects

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onHeadPosition(data => {
  if (data.position === "up") {
    console.log("User looked up")
  } else if (data.position === "down") {
    console.log("User looked down")
  }
})
```

### onButtonPress()

Registers a handler for hardware button press events on the glasses.

```typescript
onButtonPress(handler: (data: ButtonPress) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`ButtonPress`](/reference/interfaces/event-types#buttonpress) objects

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onButtonPress(data => {
  console.log(`Button ${data.buttonId} was ${data.pressType} pressed`)
})
```

### onPhoneNotifications()

Registers a handler for notifications received from the connected phone.

```typescript
onPhoneNotifications(handler: (data: PhoneNotification) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`PhoneNotification`](/reference/interfaces/event-types#phonenotification) objects

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onPhoneNotifications(data => {
  console.log(`Notification from ${data.app}: ${data.title} - ${data.content}`)
})
```

### onGlassesBattery()

Registers a handler for glasses battery update events.

```typescript
onGlassesBattery(handler: (data: GlassesBatteryUpdate) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`GlassesBatteryUpdate`](/reference/interfaces/event-types#glassesbatteryupdate) objects

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onGlassesBattery(data => {
  console.log(`Glasses battery: ${data.level}%, Charging: ${data.charging}`)
})
```

### onPhoneBattery()

Registers a handler for phone battery update events.

```typescript
onPhoneBattery(handler: (data: PhoneBatteryUpdate) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`PhoneBatteryUpdate`](/reference/interfaces/event-types#phonebatteryupdate) objects

**Returns:** An unsubscribe function to remove the handler

### onVoiceActivity()

Registers a handler for Voice Activity Detection (VAD) events.

```typescript
onVoiceActivity(handler: (data: Vad) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`Vad`](/reference/interfaces/event-types#vad-voice-activity-detection) objects

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onVoiceActivity(data => {
  if (data.status === true || data.status === "true") {
    console.log("User is speaking")
  } else {
    console.log("User stopped speaking")
  }
})
```

### onLocation()

An event handler for raw location updates.

Use the [`LocationManager`](/reference/managers/location-manager) to access location data, as it provides a simple interface for both streaming and polling.

```typescript
onLocation(handler: (data: LocationUpdate) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`LocationUpdate`](/reference/interfaces/event-types#locationupdate) objects

**Returns:** An unsubscribe function to remove the handler

### onCalendarEvent()

Registers a handler for calendar event notifications.

```typescript
onCalendarEvent(handler: (data: CalendarEvent) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`CalendarEvent`](/reference/interfaces/event-types#calendarevent) objects

**Returns:** An unsubscribe function to remove the handler

### onAudioChunk()

Registers a handler for raw audio data chunks. Requires explicit subscription.

```typescript
onAudioChunk(handler: (data: AudioChunk) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives [`AudioChunk`](/reference/interfaces/event-types#audiochunk) objects

**Returns:** An unsubscribe function to remove the handler

**Note:** Audio chunks require an explicit subscription using appSession.subscribe([StreamType.AUDIO_CHUNK](/reference/enums#streamtype)).

## System Event Handlers

### onConnected()

Registers a handler for when the WebSocket connection is successfully established and authenticated.

```typescript
onConnected(handler: (data: AppSettings | undefined) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives optional [`AppSettings`](/reference/interfaces/config-types#appsettings) upon connection

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onConnected(settings => {
  console.log("Connected to MentraOS Cloud")
  if (settings) {
    console.log("Initial settings received:", settings)
  }
})
```

### onDisconnected()

Registers a handler for when the WebSocket connection is closed or lost.

```typescript
onDisconnected(handler: (reason: string) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives a reason string

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onDisconnected(reason => {
  console.log(`Disconnected from MentraOS Cloud. Reason: ${reason}`)
})
```

### onError()

Registers a handler for WebSocket or SDK-level errors.

```typescript
onError(handler: (error: WebSocketError | Error) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives a [`WebSocketError`](/reference/interfaces/message-types#websocketerror) or standard Error object

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onError(error => {
  console.error("Error in App session:", error)
})
```

### onSettingsUpdate()

Registers a handler for when the application settings are updated by the user via MentraOS Cloud.

```typescript
onSettingsUpdate(handler: (settings: AppSettings) => void): () => void
```

**Parameters:**

- `handler`: Callback function that receives the complete updated [`AppSettings`](/reference/interfaces/config-types#appsettings) array

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onSettingsUpdate(settings => {
  console.log("Settings updated:", settings)
})
```

### onSettingChange()

Registers a handler that triggers only when a specific setting's value changes.

```typescript
onSettingChange<T>(
  key: string,
  handler: (value: T, previousValue: T | undefined) => void
): () => void
```

**Parameters:**

- `key`: The key of the setting to monitor
- `handler`: Callback function that receives the new value and the previous value (or undefined initially)

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
appSession.events.onSettingChange<boolean>("enableNotifications", (newValue, oldValue) => {
  console.log(`enableNotifications changed from ${oldValue} to ${newValue}`)
  if (newValue) {
    // Enable notification features
  } else {
    // Disable notification features
  }
})
```

## Generic Event Handler

### on()

Generic event handler for any StreamType. Use specific methods above where possible.

```typescript
on<T extends StreamType>(
  type: T,
  handler: (data: StreamDataTypes[T]) => void
): () => void
```

**Parameters:**

- `type`: The [`StreamType`](/reference/enums#streamtype) to listen for
- `handler`: Callback function that receives data of the appropriate type for the specified StreamType

**Returns:** An unsubscribe function to remove the handler

**Example:**

```typescript
import {StreamType} from "@mentra/sdk"

// Subscribe to a specific stream type
appSession.events.on(StreamType.LOCATION_UPDATE, data => {
  console.log(`Location update: ${data.lat}, ${data.lng}`)
})

// Using a language-specific stream
const transcriptionStream = createTranscriptionStream("en-US")
appSession.events.on(transcriptionStream, data => {
  console.log(`English transcription: ${data.text}`)
})
```
