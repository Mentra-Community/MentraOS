# @mentra/webview-sdk

JavaScript SDK for building local mini apps (LMA) in MentraOS WebViews.

## Overview

This SDK provides a simple API for building web-based applications that run inside MentraOS smartglasses WebViews. It handles communication with the native MentraOS runtime and provides access to:

- **Display**: Show text on smartglasses
- **Microphone**: Control microphone state
- **Transcriptions**: Receive real-time speech transcriptions (online/local)
- **Audio**: Receive audio stream data
- **Movement**: Receive IMU/motion data

## Installation

```bash
npm install @mentra/webview-sdk
```

Or using bun:

```bash
bun add @mentra/webview-sdk
```

## Quick Start

### Basic Usage (Vanilla JavaScript/TypeScript)

```typescript
import { CoreModule, Events } from '@mentra/webview-sdk'

// Display text on glasses
CoreModule.displayText('Hello from WebView')

// Subscribe to transcriptions
Events.requestTranscriptions({ type: 'online', fallback: true }, (text) => {
  console.log('Transcription:', text)
  CoreModule.displayText(text)
})
```

### Using in HTML (via CDN or bundler)

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module">
      import { CoreModule, Events } from '@mentra/webview-sdk'

      // Display text on glasses
      CoreModule.displayText('Hello from WebView')

      // Subscribe to transcriptions
      Events.requestTranscriptions({ type: 'online', fallback: true }, (text) => {
        CoreModule.displayText(text)
      })
    </script>
  </head>
  <body>
    <h1>My MentraOS App</h1>
  </body>
</html>
```

## API Reference

### CoreModule

Core functionality for controlling MentraOS features.

#### `CoreModule.displayText(text: string | DisplayTextArgs): void`

Display text on the smartglasses.

```typescript
// Simple usage
CoreModule.displayText('Hello World')

// With options
CoreModule.displayText({ text: 'Hello World' })
```

#### `CoreModule.setMicState(state: MicState | SetMicStateArgs): void`

Control the microphone state.

```typescript
// Simple usage
CoreModule.setMicState('on') // 'on' | 'off' | 'muted'

// With options
CoreModule.setMicState({ state: 'on' })
```

### Events

Subscribe to real-time events from MentraOS.

#### `Events.requestTranscriptions(options: TranscriptionOptions, handler: (text: string) => void): void`

Subscribe to speech transcriptions from the smartglasses.

**Options:**
- `type`: `'online'` | `'local'` - Use online (Soniox) or local transcription
- `fallback`: `boolean` - If `true`, fallback to local if online fails

```typescript
Events.requestTranscriptions(
  { type: 'online', fallback: true },
  (text) => {
    console.log('User said:', text)
  }
)
```

#### `Events.requestAudio(options: AudioOptions, handler: (data: AudioPayload) => void): void`

Subscribe to audio stream data from the smartglasses.

**Options:**
- `sampleRate`: `number` - Desired sample rate (optional)
- `channels`: `number` - Number of audio channels (optional)

```typescript
Events.requestAudio(
  { sampleRate: 16000, channels: 1 },
  (audioData) => {
    console.log('Received audio data:', audioData)
  }
)
```

#### `Events.requestMovement(options: MovementOptions, handler: (data: MovementPayload) => void): void`

Subscribe to IMU/motion data from the smartglasses.

**Options:**
- `frequency`: `number` - Update frequency in Hz (optional)

```typescript
Events.requestMovement(
  { frequency: 60 },
  (movement) => {
    console.log('Movement:', movement.x, movement.y, movement.z)
  }
)
```

#### Unsubscribe Methods

```typescript
Events.stopTranscriptions()
Events.stopAudio()
Events.stopMovement()
```

## TypeScript Support

This package includes full TypeScript type definitions. All types are exported from the main package:

```typescript
import type {
  TranscriptionOptions,
  AudioOptions,
  MovementOptions,
  MicState,
  DisplayTextArgs,
  TranscriptionPayload,
  AudioPayload,
  MovementPayload,
} from '@mentra/webview-sdk'
```

## Advanced Usage

### Manual Initialization

The SDK auto-initializes on import, but you can manually control initialization:

```typescript
import { initialize } from '@mentra/webview-sdk'

// Manually initialize when ready
initialize()
```

### Using the Bridge Directly

For advanced use cases, you can access the underlying bridge:

```typescript
import { getBridge } from '@mentra/webview-sdk/bridge'

const bridge = getBridge()

// Send custom messages
bridge.send({
  type: 'custom_action',
  payload: { action: 'myAction', data: {} }
})

// Subscribe to custom events
bridge.subscribe('custom_event', (payload) => {
  console.log('Custom event:', payload)
})
```

## Complete Example

```typescript
import { CoreModule, Events } from '@mentra/webview-sdk'

// Display welcome message
CoreModule.displayText('Voice Assistant Active')

// Enable microphone
CoreModule.setMicState('on')

// Handle transcriptions
Events.requestTranscriptions(
  { type: 'online', fallback: true },
  (text) => {
    // Display what user said
    CoreModule.displayText(`You said: ${text}`)

    // Process commands
    if (text.toLowerCase().includes('hello')) {
      CoreModule.displayText('Hello! How can I help?')
    }
  }
)

// Handle movement data
Events.requestMovement(
  { frequency: 30 },
  (movement) => {
    // Detect head nod (simple example)
    if (movement.y > 0.5) {
      CoreModule.displayText('Head nod detected!')
    }
  }
)
```

## App Configuration

Create an `app.json` file to configure your local mini app:

```json
{
  "name": "My App",
  "packageName": "com.example.myapp",
  "version": "1.0.0",
  "main": "index.html",
  "type": "standard",
  "hardwareRequirements": [
    { "type": "DISPLAY", "level": "REQUIRED" },
    { "type": "MICROPHONE", "level": "REQUIRED" }
  ],
  "declaredPermissions": [
    { "type": "MICROPHONE", "level": "REQUIRED" }
  ],
  "subscriptions": ["online_transcription"]
}
```

## Development

```bash
# Install dependencies
bun install

# Build the package
bun run build

# Watch mode for development
bun run dev
```

## License

MIT

## Support

For issues and questions, visit the [MentraOS Discord](https://discord.gg/5ukNvkEAqT)
