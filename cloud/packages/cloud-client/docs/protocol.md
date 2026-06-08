# Protocol Documentation

This document describes the WebSocket message protocol between the MentraClient and AugmentOS cloud, based on the official SDK types.

## Connection Flow

### 1. WebSocket Connection
- Client connects to WebSocket endpoint: `ws://server/glasses-ws`
- Authorization header required: `Authorization: Bearer <core_token>`

### 2. Connection Initialization
```typescript
// Client → Cloud
{
  "type": "connection_init",
  "timestamp": "2024-01-01T00:00:00.000Z"
}

// Cloud → Client
{
  "type": "connection_ack",
  "sessionId": "user@example.com",
  "userSession": { /* session data */ },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Message Categories

### Glasses → Cloud Messages

#### Control Actions
Messages that trigger actions or state changes in the cloud.

**Start App**
```typescript
{
  "type": "start_app",
  "packageName": "com.augmentos.translator",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Stop App**
```typescript
{
  "type": "stop_app",
  "packageName": "com.augmentos.translator",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### Event Data
Messages that provide sensor data or user interactions.

**Voice Activity Detection (VAD)**
```typescript
{
  "type": "vad",
  "status": true,  // or false
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Head Position**
```typescript
{
  "type": "head_position",
  "position": "up",  // or "down"
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Location Update**
```typescript
{
  "type": "location_update",
  "lat": 37.7749,
  "lng": -122.4194,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Button Press**
```typescript
{
  "type": "button_press",
  "buttonId": "action",
  "pressType": "short",  // or "long"
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Core Status Update**
```typescript
{
  "type": "core_status_update",
  "status": "{\"battery\": 85, \"brightness\": 50}",
  "details": {
    "coreInfo": {
      "version": "1.0.0",
      "micEnabled": true
    },
    "glassesInfo": {
      "model": "Even Realities G1",
      "battery": 85,
      "connected": true
    }
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Glasses Connection State**
```typescript
{
  "type": "glasses_connection_state",
  "modelName": "Even Realities G1",
  "status": "CONNECTED",  // or "DISCONNECTED"
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### Audio Data
Audio is sent as binary WebSocket messages, not JSON. The client sends raw audio chunks directly to the cloud for transcription processing.

### Cloud → Glasses Messages

#### Connection Responses

**Connection Acknowledgment**
```typescript
{
  "type": "connection_ack",
  "sessionId": "user@example.com",
  "userSession": {
    "sessionId": "user@example.com",
    "userId": "user@example.com",
    "startTime": "2024-01-01T00:00:00.000Z",
    "activeAppSessions": ["com.augmentos.dashboard"],
    "loadingApps": [],
    "isTranscribing": false
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Connection Error**
```typescript
{
  "type": "connection_error",
  "code": "INVALID_TOKEN",
  "message": "Authentication failed",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### Display Updates

**Display Event**
```typescript
{
  "type": "display_event",
  "sessionId": "user@example.com",
  "layout": {
    "type": "text_wall",
    "content": "Hello, World!",
    "view": "main"  // or "dashboard"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### State Changes

**App State Change**
```typescript
{
  "type": "app_state_change",
  "sessionId": "user@example.com",
  "userSession": {
    "activeAppSessions": ["com.augmentos.translator"],
    "loadingApps": [],
    "isTranscribing": true
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Microphone State Change**
```typescript
{
  "type": "microphone_state_change",
  "sessionId": "user@example.com",
  "userSession": { /* session data */ },
  "isMicrophoneEnabled": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Settings Update**
```typescript
{
  "type": "settings_update",
  "sessionId": "user@example.com",
  "settings": {
    "useOnboardMic": false,
    "contextualDashboard": true,
    "brightness": 50,
    "autoBrightness": false
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Message Type Reference

### Glasses → Cloud Message Types

| Type | Description | Required Fields |
|------|-------------|----------------|
| `connection_init` | Initialize connection | - |
| `start_app` | Launch an app | `packageName` |
| `stop_app` | Stop an app | `packageName` |
| `vad` | Voice activity detection | `status` |
| `head_position` | Head movement event | `position` |
| `location_update` | GPS coordinates | `lat`, `lng` |
| `button_press` | Physical button interaction | `buttonId`, `pressType` |
| `core_status_update` | System status | `status` |
| `glasses_connection_state` | Hardware connection | `modelName`, `status` |
| `request_settings` | Request current settings | `sessionId` |
| `augmentos_settings_update_request` | Request settings update | - |

### Cloud → Glasses Message Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `connection_ack` | Connection confirmed | `sessionId`, `userSession` |
| `connection_error` | Connection failed | `code`, `message` |
| `display_event` | UI layout update | `layout` |
| `app_state_change` | App lifecycle change | `userSession` |
| `microphone_state_change` | Mic state update | `isMicrophoneEnabled` |
| `settings_update` | Settings changed | `settings` |

## Protocol Implementation

### WebSocket Setup
```typescript
const ws = new WebSocket('ws://server/glasses-ws', {
  headers: {
    'Authorization': `Bearer ${coreToken}`
  }
});
```

### Message Sending
```typescript
// Send JSON message
const message = {
  type: 'vad',
  status: true,
  timestamp: new Date()
};
ws.send(JSON.stringify(message));

// Send binary audio data
const audioChunk = new Uint8Array(1600); // 100ms of 16kHz audio
ws.send(audioChunk);
```

### Message Receiving
```typescript
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    // Handle binary audio data (not used in glasses → cloud direction)
    console.log('Received binary data:', data.length, 'bytes');
  } else {
    // Handle JSON message
    const message = JSON.parse(data.toString());
    console.log('Received message:', message.type);
  }
});
```

### Error Handling
```typescript
ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('close', (code, reason) => {
  console.log('Connection closed:', code, reason);
});
```

## Authentication

### Core Token Exchange
Before connecting to the WebSocket, clients must obtain a core token:

```typescript
// Exchange Supabase token for core token
const response = await fetch('/api/auth/exchange-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ supabaseToken: '<supabase_jwt>' })
});

const { coreToken } = await response.json();
```

### WebSocket Authentication
The core token is passed in the WebSocket upgrade request:

```typescript
const ws = new WebSocket('ws://server/glasses-ws', {
  headers: {
    'Authorization': `Bearer ${coreToken}`
  }
});
```

## Dashboard View Logic

The dashboard system has two views that switch based on head position:

### View Types
- **Main View**: Default view showing app content
- **Dashboard View**: Special system dashboard with status info

### Head Position Behavior
- **Look Up**: Switch to dashboard view (if dashboard enabled)
- **Look Down**: Switch to main view

### Display Request Routing
- `view: "dashboard"` → Updates dashboard view content
- `view: "main"` or undefined → Updates main view content

### Current View Determination
```typescript
function getCurrentView(headPosition, dashboardEnabled, hasMainView, hasDashboardView) {
  if (dashboardEnabled && headPosition === 'up' && hasDashboardView) {
    return 'dashboard';
  } else if (hasMainView) {
    return 'main';
  } else {
    return 'none';
  }
}
```

## Best Practices

### Message Timing
- Don't send messages faster than 10Hz (100ms intervals)
- Audio chunks should be sent consistently (e.g., every 100ms)
- Status updates should be sent periodically (e.g., every 10 seconds)

### Error Recovery
- Implement exponential backoff for reconnection
- Handle partial message delivery gracefully
- Validate message format before sending

### Performance
- Keep message payloads small
- Use binary format for audio data
- Batch multiple state changes when possible

### Security
- Always use secure WebSocket (wss://) in production
- Validate and sanitize all message content
- Implement proper token refresh logic
