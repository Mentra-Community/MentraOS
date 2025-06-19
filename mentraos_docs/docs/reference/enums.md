---
sidebar_position: 3
title: Enums
---

# Enums

This page documents all the enumeration types available in the AugmentOS SDK. Enums are used to define sets of named constants that represent distinct values throughout the SDK.

## TpaType

Defines the different types or roles a TPA can have within the AugmentOS system.

```typescript
enum TpaType {
  SYSTEM_DASHBOARD = 'system_dashboard', // Special UI placement, system functionality
  SYSTEM_APPSTORE = 'system_appstore',   // System app store functionality
  BACKGROUND = 'background',             // Runs without primary UI, can temporarily display content
  STANDARD = 'standard'                  // Regular TPA with standard lifecycle and UI interaction (default)
}
```

## AppState

Represents the lifecycle states of a TPA on the user's device.

```typescript
enum AppState {
  NOT_INSTALLED = 'not_installed', // App is not installed
  INSTALLED = 'installed',         // App is installed but not running
  BOOTING = 'booting',             // App is in the process of starting
  RUNNING = 'running',             // App is currently active
  STOPPED = 'stopped',             // App has been stopped (by user or system)
  ERROR = 'error'                  // App encountered an error
}
```

## Language

Defines supported language codes (BCP 47 format).

```typescript
enum Language {
  EN = "en", // English
  ES = "es", // Spanish
  FR = "fr"  // French
  // Additional languages may be added as supported
}
```

## LayoutType

Identifies the different predefined UI layout structures available for display.

```typescript
enum LayoutType {
  TEXT_WALL = 'text_wall',           // Single block of text
  DOUBLE_TEXT_WALL = 'double_text_wall', // Two blocks of text (top/bottom)
  DASHBOARD_CARD = 'dashboard_card',   // Key-value pair style card (left/right text)
  REFERENCE_CARD = 'reference_card',   // Card with a title and content text
  BITMAP_VIEW = 'bitmap_view'          // Displays a bitmap image
}
```

## ViewType

Specifies the target area on the AR display where a layout should appear.

```typescript
enum ViewType {
  DASHBOARD = 'dashboard', // The persistent dashboard area
  MAIN = 'main'            // The main, typically temporary, display area
}
```

## AppSettingType

Defines the types of interactive settings that can be configured for a TPA in the AugmentOS settings UI. Used within the `TpaConfig` interface.

```typescript
enum AppSettingType {
  TOGGLE = 'toggle', // A boolean switch
  TEXT = 'text',     // A text input field
  SELECT = 'select'  // A dropdown selection list
}
```

## StreamType

Identifies the different types of real-time data streams and events TPAs can subscribe to.

```typescript
enum StreamType {
  // Hardware streams
  BUTTON_PRESS = 'button_press',             // Hardware button pressed on glasses
  HEAD_POSITION = 'head_position',           // Head movement detected (e.g., up, down)
  GLASSES_BATTERY_UPDATE = 'glasses_battery_update', // Glasses battery level and status
  PHONE_BATTERY_UPDATE = 'phone_battery_update',   // Connected phone battery level and status
  GLASSES_CONNECTION_STATE = 'glasses_connection_state', // Glasses connection info (e.g., model)
  LOCATION_UPDATE = 'location_update',       // GPS location update
  
  // Audio streams
  TRANSCRIPTION = 'transcription',           // Real-time speech-to-text results
  TRANSLATION = 'translation',               // Real-time speech translation results
  VAD = 'VAD',                               // Voice Activity Detection status (speaking/not speaking)
  AUDIO_CHUNK = 'audio_chunk',               // Raw audio data chunks (requires explicit subscription)
  
  // Phone streams
  PHONE_NOTIFICATION = 'phone_notification', // Notification received on the connected phone
  NOTIFICATION_DISMISSED = 'notification_dismissed', // Notification dismissed on the glasses/phone
  CALENDAR_EVENT = 'calendar_event',         // Calendar event from the connected phone
  
  // System streams / Control actions originating from glasses
  START_APP = 'start_app',                   // User requested to start an app
  STOP_APP = 'stop_app',                     // User requested to stop an app
  OPEN_DASHBOARD = 'open_dashboard',         // User requested to open the dashboard
  
  // Video streams
  VIDEO = 'video',                           // Video stream data (if available/supported)
  
  // Special subscription types (for cloud internal use primarily)
  ALL = 'all',                               // Subscribe to all possible streams
  WILDCARD = '*'                             // Wildcard subscription (similar to ALL)
}
```

## WebhookRequestType

Identifies the type of request being sent from AugmentOS Cloud to a TPA server's webhook endpoint.

```typescript
enum WebhookRequestType {
  SESSION_REQUEST = 'session_request',         // Request to start a new TPA session for a user
  STOP_REQUEST = 'stop_request',               // Request to stop an existing TPA session
  SERVER_REGISTRATION = 'server_registration', // Confirmation that the TPA server is registered
  SERVER_HEARTBEAT = 'server_heartbeat',       // Periodic check to ensure the TPA server is responsive
  SESSION_RECOVERY = 'session_recovery'        // Request to recover a session (e.g., after cloud restart)
}
```

## Message Type Enums

These enums are used to identify the types of messages exchanged between different components of the AugmentOS system.

### GlassesToCloudMessageType

Message types sent FROM glasses TO cloud.

```typescript
enum GlassesToCloudMessageType {
  CONNECTION_INIT = 'connection_init',
  START_APP = 'start_app',
  STOP_APP = 'stop_app',
  DASHBOARD_STATE = 'dashboard_state',
  OPEN_DASHBOARD = 'open_dashboard',
  BUTTON_PRESS = 'button_press',
  HEAD_POSITION = 'head_position',
  GLASSES_BATTERY_UPDATE = 'glasses_battery_update',
  PHONE_BATTERY_UPDATE = 'phone_battery_update',
  GLASSES_CONNECTION_STATE = 'glasses_connection_state',
  LOCATION_UPDATE = 'location_update',
  VAD = 'VAD',
  PHONE_NOTIFICATION = 'phone_notification',
  NOTIFICATION_DISMISSED = 'notification_dismissed',
  CALENDAR_EVENT = 'calendar_event'
}
```

### CloudToGlassesMessageType

Message types sent FROM cloud TO glasses.

```typescript
enum CloudToGlassesMessageType {
  CONNECTION_ACK = 'connection_ack',
  CONNECTION_ERROR = 'connection_error',
  AUTH_ERROR = 'auth_error',
  DISPLAY_EVENT = 'display_event',
  APP_STATE_CHANGE = 'app_state_change',
  MICROPHONE_STATE_CHANGE = 'microphone_state_change',
  WEBSOCKET_ERROR = 'websocket_error'
}
```

### TpaToCloudMessageType

Message types sent FROM TPA TO cloud.

```typescript
enum TpaToCloudMessageType {
  CONNECTION_INIT = 'tpa_connection_init',
  SUBSCRIPTION_UPDATE = 'subscription_update',
  DISPLAY_REQUEST = 'display_event' // Note: Reuses 'display_event' type string
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
  DATA_STREAM = 'data_stream', // Wrapper for stream data
  WEBSOCKET_ERROR = 'websocket_error'
  // Note: Specific stream data like TranscriptionData uses StreamType directly as its type identifier.
}
``` 