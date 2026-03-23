# MentraOS React App Example

This is a Vite + React + TypeScript example app demonstrating how to use the `@mentra/webview-sdk` package to build local mini apps for MentraOS smartglasses.

## Features

- **TypeScript**: Full type safety with the WebView SDK
- **React**: Modern React 18 with hooks
- **Vite**: Fast development server and optimized builds
- **Tailwind CSS**: Utility-first CSS framework for styling

## Getting Started

### Install Dependencies

```bash
bun install
```

### Development

Start the development server:

```bash
bun run dev
```

The app will be available at `http://localhost:3000`

### Build

Create a production build:

```bash
bun run build
```

The built files will be in the `dist/` directory.

### Preview Production Build

```bash
bun run preview
```

## Project Structure

```
react-app/
├── src/
│   ├── App.tsx         # Main application component
│   ├── main.tsx        # React entry point
│   └── index.css       # Tailwind CSS imports
├── index.html          # HTML entry point
├── vite.config.ts      # Vite configuration
├── tailwind.config.js  # Tailwind CSS configuration
├── postcss.config.js   # PostCSS configuration
└── package.json
```

## SDK Usage

This example demonstrates:

1. **Display Text**: Send text to display on smartglasses
2. **Microphone Control**: Toggle microphone on/off
3. **Transcription**: Subscribe to real-time speech transcriptions

### Import the SDK

```typescript
import { CoreModule, Events } from '@mentra/webview-sdk'
import type { MicState } from '@mentra/webview-sdk'
```

### Display Text

```typescript
CoreModule.displayText('Hello from React!')
```

### Control Microphone

```typescript
CoreModule.setMicState('on')  // 'on' | 'off' | 'muted'
```

### Subscribe to Transcriptions

```typescript
Events.requestTranscriptions(
  { type: 'online', fallback: true },
  (text) => {
    console.log('Transcription:', text)
  }
)
```

## Deployment

To deploy this app as a MentraOS local mini app:

1. Build the production version: `bun run build`
2. Create an `app.json` file in the `dist/` directory:

```json
{
  "name": "My React App",
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

3. Package the `dist/` directory and deploy to MentraOS

## Learn More

- [@mentra/webview-sdk Documentation](../../README.md)
- [MentraOS Discord](https://discord.gg/5ukNvkEAqT)
