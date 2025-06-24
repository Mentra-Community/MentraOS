# MentraOS Cloud Events

MentraOS Cloud uses an event-driven architecture to communicate real-time data from the smartglasses to your MentraOS app. Your app can *subscribe* to specific events and receive data as it becomes available. This document describes how to subscribe to events, the available event types, and the data structure for each event.

## Subscribing to Events

The [`TpaSession`](/reference/tpa-session) class in the `@mentra/sdk` provides several ways to subscribe to events.  You'll typically do this within the [`onSession`](/reference/tpa-server#onsession-protected) method of your [`TpaServer`](/reference/tpa-server):

```typescript
protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
  // ... your session setup ...

  // Subscribe to transcription events
  const unsubscribe = session.events.onTranscription((data) => {
    // Handle transcription data
    console.log(data.text);
  });

  // ... other event subscriptions ...

  // **Important:** Unsubscribe when the session ends.
  this.addCleanupHandler(unsubscribe);
}
```

`session.events` is an [`EventManager`](/reference/managers/event-manager) instance that provides a consistent interface for all event subscriptions.  All subscription methods return an `unsubscribe` function, which you *must* call when you no longer need the subscription (typically when the session ends).

### Subscription Methods

You can subscribe to events using these methods:

1.  **Direct Methods (Recommended):**  The [`EventManager`](/reference/managers/event-manager) provides convenience methods for the most common event types. These methods are type-safe and provide the best developer experience.

    ```typescript
    session.events.onTranscription((data: TranscriptionData) => { ... });
    session.events.onHeadPosition((data: HeadPosition) => { ... });
    session.events.onButtonPress((data: ButtonPress) => { ... });
    // ... other direct methods ...
    ```

2.  **Generic [`on`](/reference/managers/event-manager#on) Method:** Use this for events that don't have a dedicated method, or for custom event types:

    ```typescript
    import { StreamType, ButtonPress } from '@mentra/sdk';

    session.events.on<ButtonPress>(StreamType.BUTTON_PRESS, (data) => {
      // Handle button press data
      console.log(data.buttonId);
    });
    ```

3. **[Subscribe method](/reference/tpa-session#subscribe):** Use this to manually signal to the backend which streams your app wants to subscripbe to.
    ```typescript
    session.subscribe(StreamType.TRANSCRIPTION);
    ```

    The first two approaches automatically manage subscriptions for you, however for some use cases you may want to manually set the stream subscriptions.

### Unsubscribing from Events

Always unsubscribe from events when they are no longer needed to prevent memory leaks and unexpected behavior:

```typescript
const unsubscribe = session.events.onTranscription((data) => {
  // ... handle transcription ...
});

// Later, when you no longer need the subscription:
unsubscribe();
```

A good practice is to store the unsubscribe functions and call them in a cleanup handler:

```typescript
const cleanupHandlers: (() => void)[] = [];

// ... within your onSession method ...
cleanupHandlers.push(session.events.onTranscription((data) => { ... }));
cleanupHandlers.push(session.events.onHeadPosition((data) => { ... }));

// ...

// Add a cleanup handler to your TpaServer
cleanupHandlers.forEach(handler => this.addCleanupHandler(handler));
```

## Available Events

The following table lists the available event types, their descriptions, and the corresponding data types.  The [`StreamType`](/reference/enums#streamtype) enum in `@mentra/sdk` provides the canonical names for these events.

| Event Type                     | `StreamType` Constant              | Description                                                                          | Data Type                        |
| :----------------------------- | :---------------------------------- | :----------------------------------------------------------------------------------- | :-------------------------------- |
| Transcription                  | [`StreamType.TRANSCRIPTION`](/reference/enums#streamtype)          | Real-time speech-to-text transcription.                                         | [`TranscriptionData`](/reference/interfaces/event-types#transcriptiondata)              |
| Translation                    | [`StreamType.TRANSLATION`](/reference/enums#streamtype)            | Real-time translation of transcribed text.                                     | [`TranslationData`](/reference/interfaces/event-types#translationdata)              |
| Head Position                  | [`StreamType.HEAD_POSITION`](/reference/enums#streamtype)          | User's head position ('up' or 'down').                                           | [`HeadPosition`](/reference/interfaces/event-types#headposition)                   |
| Button Press                   | [`StreamType.BUTTON_PRESS`](/reference/enums#streamtype)           | Hardware button press on the glasses.                                          | [`ButtonPress`](/reference/interfaces/event-types#buttonpress)                    |
| Phone Notification             | [`StreamType.PHONE_NOTIFICATION`](/reference/enums#streamtype)     | Notification received from the user's connected phone.                           | [`PhoneNotification`](/reference/interfaces/event-types#phonenotification)              |
| Glasses Battery Update         | [`StreamType.GLASSES_BATTERY_UPDATE`](/reference/enums#streamtype) | Battery level update from the glasses.                                        | [`GlassesBatteryUpdate`](/reference/interfaces/event-types#glassesbatteryupdate)           |
| Phone Battery Update           | [`StreamType.PHONE_BATTERY_UPDATE`](/reference/enums#streamtype)   | Battery level update from the phone.                                           | [`PhoneBatteryUpdate`](/reference/interfaces/event-types#phonebatteryupdate)             |
| Glasses Connection State       | [`StreamType.GLASSES_CONNECTION_STATE`](/reference/enums#streamtype) | Connection status of the glasses.                                             | [`GlassesConnectionState`](/reference/interfaces/event-types#glassesconnectionstate)         |
| Location Update                | [`StreamType.LOCATION_UPDATE`](/reference/enums#streamtype)        | User's GPS location.                                                             | [`LocationUpdate`](/reference/interfaces/event-types#locationupdate)                 |
| Voice Activity Detection (VAD) | [`StreamType.VAD`](/reference/enums#streamtype)                    | Indicates whether voice activity is detected.                                  | [`Vad`](/reference/interfaces/event-types#vad-voice-activity-detection)                            |
| Notification Dismissed         | [`StreamType.NOTIFICATION_DISMISSED`](/reference/enums#streamtype) | User dismissed a notification.                                                    | [`NotificationDismissed`](/reference/interfaces/event-types#notificationdismissed)          |
| Audio Chunk                    | [`StreamType.AUDIO_CHUNK`](/reference/enums#streamtype)            | Raw audio data (for advanced use cases).                                      | [`ArrayBuffer`](/reference/interfaces/event-types#audiochunk)                   |
| Video                         |  [`StreamType.VIDEO`](/reference/enums#streamtype)               | Raw video data.                                             | [`ArrayBuffer`](/reference/interfaces/event-types#audiochunk)       |
| Start App                      | [`StreamType.START_APP`](/reference/enums#streamtype)              | User requested to start your app (you don't usually need to handle this directly). | `undefined` |
| Stop App                       | [`StreamType.STOP_APP`](/reference/enums#streamtype)               | User requested to stop your app (you don't usually need to handle this directly).  | `undefined` |
| Open Dashboard                 | [`StreamType.OPEN_DASHBOARD`](/reference/enums#streamtype)             | User requested to open the dashboard (you don't usually need to handle this directly).              | `undefined` |
| All                    | [`StreamType.ALL`](/reference/enums#streamtype)           | All available streams for the user.                        | `any`     |
| Wildcard               | [`StreamType.WILDCARD`](/reference/enums#streamtype)     |   Wildcard for all available streams for the user.                   | `any`      |

**System Events:**

These events are not tied to specific data streams and are handled using `session.events.on<EventName>()`:

| Event Name       | Description                                            | Data Type       |
| :--------------- | :----------------------------------------------------- | :-------------- |
| [`connected`](/reference/managers/event-manager#onconnected)      | Emitted when the WebSocket connection is established.   | [`AppSettings`](/reference/interfaces/config-types#appsettings) (or undefined) |
| [`disconnected`](/reference/managers/event-manager#ondisconnected)   | Emitted when the WebSocket connection is closed.       | `string` (reason) |
| [`error`](/reference/managers/event-manager#onerror)          | Emitted when an error occurs.                          | [`Error`](/reference/interfaces/message-types#websocketerror)         |
| [`settings_update`](/reference/managers/event-manager#onsettingsupdate)| Emitted when the user updates the app's settings       | [`AppSettings`](/reference/interfaces/config-types#appsettings)                    |

## Event Data Types

The following TypeScript interfaces define the structure of the data you'll receive with each event.

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface TranscriptionData {
  type: StreamType.TRANSCRIPTION;
  text: string;
  isFinal: boolean;
  transcribeLanguage?: string;
  startTime: number;
  endTime: number;
  speakerId?: string;
  duration?: number;
}
```

```typescript
// In packages/sdk/types/src/messages/cloud-to-tpa.ts
interface TranslationData {
  type: StreamType.TRANSLATION;
  text: string;
  originalText?: string;
  isFinal: boolean;
  startTime: number;
  endTime: number;
  speakerId?: string;
  duration?: number;
  transcribeLanguage?: string;
  translateLanguage?: string;
  didTranslate?: boolean;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface HeadPosition {
    type: GlassesToCloudMessageType.HEAD_POSITION;
    sessionId: string;
    position: 'up' | 'down';
    timestamp: string;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface ButtonPress {
  type: GlassesToCloudMessageType.BUTTON_PRESS;
  sessionId: string;
  buttonId: string; // This could be an enum in a future version
  pressType: 'short' | 'long';
  timestamp: string;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface PhoneNotification {
    type: StreamType.PHONE_NOTIFICATION;
    sessionId: string;
    app: string;        // e.g., 'com.android.email'
    title: string;
    content: string;    // Notification body
    timestamp: Date;    // When the notification was received
    priority: 'low' | 'normal' | 'high';
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface GlassesBatteryUpdate {
  type: GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE;
  sessionId: string;
  level: number; // 0-100
  charging: boolean;
  timeRemaining?: number;
  timestamp: string;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface PhoneBatteryUpdate {
  type: GlassesToCloudMessageType.PHONE_BATTERY_UPDATE;
  sessionId: string;
  level: number; // 0-100
  charging: boolean;
  timeRemaining?: number;
  timestamp: string;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface GlassesConnectionState {
  type: GlassesToCloudMessageType.GLASSES_CONNECTION_STATE;
  sessionId: string;
  modelName: string;
  status: 'BLUETOOTH_CONNECTING' | 'BLUETOOTH_CONNECTED' |
          'BLUETOOTH_DISCONNECTED' | 'WIFI_CONNECTING' |
          'WIFI_CONNECTED' | 'WIFI_DISCONNECTED' | 'CONNECTED' |
          'DISCONNECTED' | 'RECONNECTING' | 'UNKNOWN';
  batterySaver: boolean;
  doNotDisturb: boolean;
  timestamp: string;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface LocationUpdate {
  type: StreamType.LOCATION_UPDATE;
  sessionId: string;
  lat: number;
  lng: number;
  timestamp: Date;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface Vad {
  type: StreamType.VAD;
  sessionId: string;
  status: boolean | "true" | "false";
  timestamp: Date;
}
```

```typescript
// In packages/sdk/types/src/messages/glasses-to-cloud.ts
interface NotificationDismissed {
  type: StreamType.NOTIFICATION_DISMISSED;
  sessionId: string;
  notificationId: string; // Or whatever ID is used
  timestamp: Date;
}
```

```typescript
// In packages/sdk/types/src/messages/cloud-to-tpa.ts
interface AudioChunk {
  type: StreamType.AUDIO_CHUNK,
  sessionId: string,
  arrayBuffer: ArrayBufferLike
  timestamp: Date,
}
```
