# Captions App - Project Structure

This document explains how the Captions app is structured as a unified Bun project.

## Overview

The Captions app combines:
1. **MentraOS AppServer** - Handles smart glasses sessions
2. **Bun Web Server** - Serves React webview + API routes
3. **No build step** - Bun serves JSX/Tailwind directly

## Directory Structure

```
captions/
├── package.json           # Single package with all dependencies
├── tsconfig.json          # TypeScript config for both backend & frontend
├── .env.example           # Environment variables template
├── .gitignore
├── README.md
├── STRUCTURE.md          # This file
│
├── src/                   # Backend Code
│   ├── index.ts          # Main entry point (starts both servers)
│   ├── app/              # AppServer logic
│   │   └── CaptionsApp.ts    # Exportable AppServer class
│   └── api/              # API routes
│       └── routes.ts     # Route definitions
│
└── webview/              # Frontend Code
    ├── src/
    │   ├── index.html    # Entry HTML (served by Bun)
    │   ├── frontend.tsx  # React root
    │   ├── App.tsx       # Main React component
    │   └── index.css     # Tailwind imports
    ├── styles/           # Additional styles
    └── components/       # React components
```

## Key Files Explained

### `src/index.ts` - Main Entry Point

**Purpose:** Starts everything
**What it does:**
- Creates `CaptionsApp` instance
- Starts Bun web server (serves webview + API)
- Starts MentraOS AppServer (handles glasses)
- Exports `captionsApp` for programmatic use

```typescript
import { serve } from "bun";
import { CaptionsApp } from "./app/CaptionsApp";

export const captionsApp = new CaptionsApp({...});
const server = serve({ routes: {...} });
await captionsApp.start();
```

### `src/app/CaptionsApp.ts` - Exportable Class

**Purpose:** Wraps AppServer in a reusable class
**What it does:**
- Implements `onStart()` - when user launches app
- Implements `onStop()` - when user closes app
- Implements `onWebhook()` - for custom endpoints
- Manages active sessions
- Can be imported and used programmatically

```typescript
export class CaptionsApp {
  constructor(config) { /* ... */ }
  async start() { /* ... */ }
  async stop() { /* ... */ }
  private async onStart(session) { /* ... */ }
}
```

### `src/api/routes.ts` - API Routes

**Purpose:** Define HTTP API endpoints
**What it does:**
- Express-style route definitions
- Used by Bun server
- Can be extended for new endpoints

```typescript
export const routes = {
  "/api/hello": {
    async GET(req) { return Response.json({...}); }
  }
};
```

### `webview/src/` - React Frontend

**Purpose:** Web dashboard UI
**What it does:**
- React app with Tailwind CSS
- Served directly by Bun (no build step)
- HMR (hot module reloading) enabled

## Data Flow

### User Starts App on Glasses

```
User launches app
    ↓
MentraOS Cloud calls /session-start
    ↓
AppServer.onStart() triggered
    ↓
CaptionsApp.onStart(session) called
    ↓
Subscribe to transcription stream
    ↓
Display initial layout on glasses
```

### Transcription Received

```
Glasses microphone captures speech
    ↓
MentraOS Cloud sends transcription via WebSocket
    ↓
session.events.onTranscription() triggered
    ↓
Process transcription
    ↓
Update layout on glasses
```

### Web Dashboard Access

```
Browser navigates to http://localhost:3333
    ↓
Bun server receives request
    ↓
Serves webview/src/index.html
    ↓
Bun processes JSX + Tailwind on-the-fly
    ↓
React app loads in browser
```

## How Bun Serves Everything

**No build step needed!** Bun handles:

1. **HTML Import:** `import indexHtml from "../webview/src/index.html"`
2. **JSX Processing:** Automatically transpiles `.tsx` files
3. **Tailwind CSS:** Processes on-the-fly via `bun-plugin-tailwind`
4. **Hot Module Reloading:** Changes reload instantly in browser

## Environment Variables

Required in `.env`:

```env
PACKAGE_NAME=com.mentra.captions
MENTRAOS_API_KEY=your_api_key
PORT=3333
NODE_ENV=development
```

## Package.json Scripts

- `bun run dev` - Development mode with hot reloading
- `bun run start` - Production mode

## Why This Structure?

### Single Project Benefits

✅ **One `bun install`** - No duplicate dependencies
✅ **No build step** - Bun serves directly
✅ **Shared types** - Backend & frontend share TypeScript types
✅ **Easy development** - One command to start everything
✅ **Exportable** - Can be imported as a package

### Separation of Concerns

✅ **`src/`** - Backend logic (AppServer, API)
✅ **`webview/`** - Frontend UI (React, Tailwind)
✅ **Clear boundaries** - Easy to understand

## Extending the App

### Add a new API endpoint

Edit `src/api/routes.ts`:

```typescript
"/api/settings": {
  async GET(req) {
    return Response.json({ enabled: true });
  }
}
```

### Add transcription processing

Edit `src/app/CaptionsApp.ts`:

```typescript
session.events.onTranscription((data) => {
  // Custom logic here
  console.log(data.text);
  
  // Update layout
  session.layouts.updateText({ text: data.text });
});
```

### Add React component

Create `webview/src/components/CaptionList.tsx`:

```typescript
export function CaptionList() {
  return <div>Captions go here</div>;
}
```

Import in `webview/src/App.tsx`:

```typescript
import { CaptionList } from './components/CaptionList';
```

## Programmatic Usage

### Import and control from other code

```typescript
import { captionsApp } from "@mentra/captions";

// App is already running
const sessions = captionsApp.getActiveSessions();

// Get specific session
const session = captionsApp.getSession("user@example.com");
```

### Create new instance

```typescript
import { CaptionsApp } from "@mentra/captions";

const app = new CaptionsApp({
  packageName: "com.custom.captions",
  apiKey: "key",
  port: 4000
});

await app.start();
// ... use app
await app.stop();
```

## Development Workflow

1. **Start dev server:** `bun run dev`
2. **Edit code:** Changes reload automatically
3. **Test in browser:** Navigate to `http://localhost:3333`
4. **Test on glasses:** Start app from MentraOS
5. **View logs:** Console shows both servers

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│         Bun Runtime (One Process)       │
├─────────────────────────────────────────┤
│                                         │
│  ┌───────────────┐  ┌───────────────┐  │
│  │   Bun Server  │  │  AppServer    │  │
│  │               │  │               │  │
│  │ Serves:       │  │ Handles:      │  │
│  │ - Webview     │  │ - onStart()   │  │
│  │ - API routes  │  │ - onStop()    │  │
│  │ - Static      │  │ - Sessions    │  │
│  └───────┬───────┘  └───────┬───────┘  │
│          │                  │          │
│          │                  │          │
└──────────┼──────────────────┼──────────┘
           │                  │
           ↓                  ↓
    Browser/Client      MentraOS Cloud
```

## Summary

This structure provides:
- **Simplicity** - One project, one command
- **Performance** - No build step, instant reloads
- **Reusability** - Export as package
- **Clarity** - Clear separation of concerns
- **Developer Experience** - Bun handles everything