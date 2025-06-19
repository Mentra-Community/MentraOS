---
sidebar_position: 2
title: Event Types
---

# Event Types

This page documents the data interfaces for events that can be received from the AugmentOS platform.

## TranscriptionData

Data structure for real-time speech transcription results.

```typescript
interface TranscriptionData extends BaseMessage {
  /** Must be StreamType.TRANSCRIPTION. */
  type: StreamType.TRANSCRIPTION;
  
  /** The transcribed text segment. */
  text: string;
  
  /** Indicates if this is the final result for this utterance (true) or an interim result (false). */
  isFinal: boolean;
  
  /** Language code of the transcribed text (e.g., 'en-US'). Optional. */
  transcribeLanguage?: string;
  
  /** Start timestamp (milliseconds) of the transcribed audio segment relative to some epoch. */
  startTime: number;
  
  /** End timestamp (milliseconds) of the transcribed audio segment. */
  endTime: number;
  
  /** Identifier for the speaker, if speaker diarization is enabled (optional). */
  speakerId?: string;
  
  /** Duration (milliseconds) of the audio segment (optional). */
  duration?: number;
}
```

**Example:**
```typescript
// Subscribe to transcription events
tpaSession.events.onTranscription((data) => {
  console.log(`Transcription: ${data.text}`);
  console.log(`Final: ${data.isFinal}`);
  
  if (data.isFinal) {
    // Process complete utterance
  }
});
```

## TranslationData

Data structure for real-time speech translation results.

```typescript
interface TranslationData extends BaseMessage {
  /** Must be StreamType.TRANSLATION. */
  type: StreamType.TRANSLATION;
  
  /** The translated text segment. */
  text: string;
  
  /** The original transcribed text before translation. */
  originalText?: string;
  
  /** Indicates if this is the final translation result for this utterance. */
  isFinal: boolean;
  
  /** Start timestamp (milliseconds) of the original audio segment. */
  startTime: number;
  
  /** End timestamp (milliseconds) of the original audio segment. */
  endTime: number;
  
  /** Identifier for the speaker (optional). */
  speakerId?: string;
  
  /** Duration (milliseconds) of the audio segment (optional). */
  duration?: number;
  
  /** Language code of the original transcription (e.g., 'en-US'). Optional. */
  transcribeLanguage?: string;
  
  /** Language code of the translated text (e.g., 'es-ES'). Optional. */
  translateLanguage?: string;
  
  /** Indicates whether the text was actually translated (true) or not (false). */
  didTranslate?: boolean;
}
```

## ButtonPress

Data for a hardware button press event on the glasses.

```typescript
interface ButtonPress extends BaseMessage {
  /** Typically GlassesToCloudMessageType.BUTTON_PRESS or StreamType.BUTTON_PRESS. */
  type: GlassesToCloudMessageType.BUTTON_PRESS | StreamType.BUTTON_PRESS;
  
  /** Identifier for the button that was pressed. */
  buttonId: string;
  
  /** Type of press ('short' or 'long'). */
  pressType: 'short' | 'long';
}
```

**Example:**
```typescript
tpaSession.events.onButtonPress((data) => {
  if (data.buttonId === 'main' && data.pressType === 'short') {
    // Handle main button short press
    tpaSession.layouts.showTextWall('Button pressed!');
  }
});
```

## HeadPosition

Data for a head movement event.

```typescript
interface HeadPosition extends BaseMessage {
  /** Typically GlassesToCloudMessageType.HEAD_POSITION or StreamType.HEAD_POSITION. */
  type: GlassesToCloudMessageType.HEAD_POSITION | StreamType.HEAD_POSITION;
  
  /** Direction of head movement ('up' or 'down'). */
  position: 'up' | 'down';
}
```

**Example:**
```typescript
tpaSession.events.onHeadPosition((data) => {
  if (data.position === 'up') {
    // Handle looking up
    tpaSession.layouts.showTextWall('You looked up!');
  } else if (data.position === 'down') {
    // Handle looking down
    tpaSession.layouts.showTextWall('You looked down!');
  }
});
```

## PhoneNotification

Data for a notification received from the connected phone.

```typescript
interface PhoneNotification extends BaseMessage {
  /** Typically GlassesToCloudMessageType.PHONE_NOTIFICATION or StreamType.PHONE_NOTIFICATION. */
  type: GlassesToCloudMessageType.PHONE_NOTIFICATION | StreamType.PHONE_NOTIFICATION;
  
  /** Unique identifier for the notification. */
  notificationId: string;
  
  /** Name of the application that generated the notification. */
  app: string;
  
  /** The title of the notification. */
  title: string;
  
  /** The main content/body of the notification. */
  content: string;
  
  /** Priority level of the notification. */
  priority: 'low' | 'normal' | 'high';
}
```

**Example:**
```typescript
tpaSession.events.onPhoneNotifications((data) => {
  if (data.priority === 'high') {
    // Format the notification for display
    const notificationText = `${data.app}: ${data.title}\n${data.content}`;
    tpaSession.layouts.showReferenceCard('New Notification', notificationText);
  }
});
```

## GlassesBatteryUpdate

Data for glasses battery status updates.

```typescript
interface GlassesBatteryUpdate extends BaseMessage {
  /** Typically GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE or StreamType.GLASSES_BATTERY_UPDATE. */
  type: GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE | StreamType.GLASSES_BATTERY_UPDATE;
  
  /** Battery percentage (0-100). */
  level: number;
  
  /** Whether the glasses are currently charging. */
  charging: boolean;
  
  /** Estimated time remaining in minutes (optional). */
  timeRemaining?: number;
}
```

**Example:**
```typescript
tpaSession.events.onGlassesBattery((data) => {
  // Update battery status in dashboard
  const batteryStatus = data.charging 
    ? `${data.level}% (Charging)` 
    : `${data.level}%`;
  
  tpaSession.layouts.showDashboardCard('Battery', batteryStatus);
  
  // Alert on low battery
  if (data.level < 15 && !data.charging) {
    tpaSession.layouts.showTextWall('Warning: Battery low!');
  }
});
```

## PhoneBatteryUpdate

Data for connected phone battery status updates.

```typescript
interface PhoneBatteryUpdate extends BaseMessage {
  /** Typically GlassesToCloudMessageType.PHONE_BATTERY_UPDATE or StreamType.PHONE_BATTERY_UPDATE. */
  type: GlassesToCloudMessageType.PHONE_BATTERY_UPDATE | StreamType.PHONE_BATTERY_UPDATE;
  
  /** Battery percentage (0-100). */
  level: number;
  
  /** Whether the phone is currently charging. */
  charging: boolean;
  
  /** Estimated time remaining in minutes (optional). */
  timeRemaining?: number;
}
```

## LocationUpdate

GPS location data.

```typescript
interface LocationUpdate extends BaseMessage {
  /** Typically GlassesToCloudMessageType.LOCATION_UPDATE or StreamType.LOCATION_UPDATE. */
  type: GlassesToCloudMessageType.LOCATION_UPDATE | StreamType.LOCATION_UPDATE;
  
  /** Latitude coordinate. */
  lat: number;
  
  /** Longitude coordinate. */
  lng: number;
}
```

**Example:**
```typescript
tpaSession.events.onLocation((data) => {
  console.log(`Current location: ${data.lat}, ${data.lng}`);
  
  // Update location-based information
  fetchWeatherForLocation(data.lat, data.lng)
    .then(weather => {
      tpaSession.layouts.showReferenceCard(
        'Current Weather', 
        `${weather.condition}\nTemp: ${weather.temperature}°F\nHumidity: ${weather.humidity}%`
      );
    });
});
```

## CalendarEvent

Data for a calendar event from the connected phone.

```typescript
interface CalendarEvent extends BaseMessage {
  /** Typically GlassesToCloudMessageType.CALENDAR_EVENT or StreamType.CALENDAR_EVENT. */
  type: GlassesToCloudMessageType.CALENDAR_EVENT | StreamType.CALENDAR_EVENT;
  
  /** Unique identifier for the calendar event. */
  eventId: string;
  
  /** The title or summary of the event. */
  title: string;
  
  /** Start date/time string (ISO format recommended). */
  dtStart: string;
  
  /** End date/time string (ISO format recommended). */
  dtEnd: string;
  
  /** Timezone identifier (e.g., 'America/New_York'). */
  timezone: string;
  
  /** Timestamp when the event was received/processed. */
  timeStamp: string;
}
```

**Example:**
```typescript
tpaSession.events.onCalendarEvent((data) => {
  // Format dates for display
  const startDate = new Date(data.dtStart);
  const endDate = new Date(data.dtEnd);
  
  const eventInfo = `${startDate.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}\n${data.title}`;
  
  // Show upcoming event
  tpaSession.layouts.showReferenceCard('Upcoming Event', eventInfo);
});
```

## Vad (Voice Activity Detection)

Voice Activity Detection status update.

```typescript
interface Vad extends BaseMessage {
  /** Typically GlassesToCloudMessageType.VAD or StreamType.VAD. */
  type: GlassesToCloudMessageType.VAD | StreamType.VAD;
  
  /** Indicates if voice activity is detected (true = speaking, false = not speaking). 
      Note: received as string sometimes. */
  status: boolean | "true" | "false";
}
```

**Example:**
```typescript
tpaSession.events.onVoiceActivity((data) => {
  const isSpeaking = data.status === true || data.status === "true";
  
  if (isSpeaking) {
    console.log("User started speaking");
    // Maybe start a visual indicator
  } else {
    console.log("User stopped speaking");
    // Maybe stop the visual indicator
  }
});
```

## AudioChunk

Data structure for a chunk of raw audio data.

```typescript
interface AudioChunk extends BaseMessage {
  /** Must be StreamType.AUDIO_CHUNK. */
  type: StreamType.AUDIO_CHUNK;
  
  /** The raw audio data. */
  arrayBuffer: ArrayBufferLike;
  
  /** The sample rate of the audio (e.g., 16000). Optional. */
  sampleRate?: number;
}
```

**Note:** Receiving audio chunks requires an explicit subscription:

```typescript
// First subscribe to audio chunks
tpaSession.subscribe(StreamType.AUDIO_CHUNK);

// Then set up the handler
tpaSession.events.onAudioChunk((data) => {
  // Process raw audio data
  // Example: Convert to PCM samples for audio processing
  const pcmData = new Int16Array(data.arrayBuffer);
  
  // Process the PCM data (e.g., calculate volume level)
  const volume = calculateRmsVolume(pcmData);
  console.log(`Current audio volume: ${volume}`);
});
```

## NotificationDismissed

Event indicating a notification was dismissed.

```typescript
interface NotificationDismissed extends BaseMessage {
  /** Typically GlassesToCloudMessageType.NOTIFICATION_DISMISSED or StreamType.NOTIFICATION_DISMISSED. */
  type: GlassesToCloudMessageType.NOTIFICATION_DISMISSED | StreamType.NOTIFICATION_DISMISSED;
  
  /** The ID of the notification that was dismissed. */
  notificationId: string;
}
```

## GlassesConnectionState

Information about the connected glasses hardware.

```typescript
interface GlassesConnectionState extends BaseMessage {
  /** Typically GlassesToCloudMessageType.GLASSES_CONNECTION_STATE or StreamType.GLASSES_CONNECTION_STATE. */
  type: GlassesToCloudMessageType.GLASSES_CONNECTION_STATE | StreamType.GLASSES_CONNECTION_STATE;
  
  /** The model name of the connected glasses. */
  modelName: string;
  
  /** Current connection status string. */
  status: string;
}
``` 