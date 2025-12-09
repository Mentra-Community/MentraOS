# Captions App

A real-time live captions app for MentraOS smart glasses. Displays transcriptions from the glasses microphone directly in the user's field of view.

## Project Structure

Clean separation of concerns:

```
captions/
├── src/
│   ├── index.ts           # 🎯 Main entry - coordinates everything
│   ├── server.ts          # 🌐 Bun web server (webview + API)
│   ├── mentra-app.ts      # 📱 MentraOS AppServer integration
│   │
│   ├── api/               # API Routes
│   │   └── routes.ts      # HTTP API endpoints
│   │
│   ├── app/               # MentraOS App Logic
│   │   └── CaptionsApp.ts # AppServer handler (onStart, onStop)
│   │
│   └── webview/           # Frontend (React)
│       ├── index.html
│       ├── frontend.tsx
│       ├── App.tsx
│       ├── components/
│       └── styles/
│
├── package.json
├── tsconfig.json
└── .env
```

## Architecture

**Three independent modules:**

1. **Web Server** (`server.ts`)
   - Pure Bun server
   - Serves React webview
   - Handles API routes
   - No MentraOS dependencies

2. **MentraOS Integration** (`mentra-app.ts`)
   - Pure AppServer logic
   - Handles glasses sessions
   - No web server logic

3. **Coordinator** (`index.ts`)
   - Starts both servers
   - 3 lines of code
   - Can disable MentraOS if needed

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- MentraOS account at [console.mentra.glass](https://console.mentra.glass)
- Smart glasses connected to MentraOS app (optional)

### Installation

```bash
bun install
```

### Configuration

Create `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3333
PACKAGE_NAME=com.mentra.captions
MENTRAOS_API_KEY=your_api_key_here  # Optional: leave empty for webview-only
NODE_ENV=development
```

### Development

**Run everything:**
```bash
bun run dev
```

**Webview only (no MentraOS):**
```bash
# Leave MENTRAOS_API_KEY empty in .env
bun run dev
```

The app will:
- ✅ Always start web server at `http://localhost:3333`
- ✅ Start MentraOS AppServer if API key is present
- ⚠️  Show warning if API key missing (webview still works)

## Usage

### As a Web App

1. Start the server: `bun run dev`
2. Open browser: `http://localhost:3333`
3. See the React webview

### As a MentraOS App

1. Add `MENTRAOS_API_KEY` to `.env`
2. Start the server: `bun run dev`
3. Launch app from MentraOS phone app
4. Captions appear on glasses

### As an Importable Module

```typescript
import { startWebServer } from "./src/server";
import { startMentraApp } from "./src/mentra-app";

// Start just the web server
const server = startWebServer({ port: 3333 });

// Or start MentraOS integration
const app = await startMentraApp({
  packageName: "com.example.app",
  apiKey: "your-key",
  port: 3333
});
```

## How It Works

### Web Server (`server.ts`)

```typescript
import { serve } from "bun";
import index from "./webview/index.html";

export function startWebServer(config) {
  return serve({
    port: config.port,
    routes: {
      ...apiRoutes,
      "/*": index  // Bun handles React/Tailwind automatically
    }
  });
}
```

- Imports HTML from `webview/`
- Bun transpiles JSX/TSX on-the-fly
- HMR enabled for instant updates
- Zero build step needed

### MentraOS Integration (`mentra-app.ts`)

```typescript
import { CaptionsApp } from "./app/CaptionsApp";

export async function startMentraApp(config) {
  const app = new CaptionsApp({
    packageName: config.packageName,
    apiKey: config.apiKey,
    port: config.port
  });
  
  await app.start();
  return app;
}
```

- Wraps AppServer logic
- Handles glasses sessions
- Optional - disable if not needed

### Coordinator (`index.ts`)

```typescript
import { startWebServer } from "./server";
import { startMentraApp } from "./mentra-app";

// Always start web server
const server = startWebServer({ port: 3333 });

// Optionally start MentraOS
if (API_KEY) {
  const app = await startMentraApp({ ... });
}
```

- Thin glue code
- Starts both servers
- Handles shutdown

## Development

### Adding API Routes

Edit `src/api/routes.ts`:

```typescript
export const routes = {
  "/api/my-endpoint": {
    async GET(req) {
      return Response.json({ data: "hello" });
    }
  }
};
```

### Editing Webview

All frontend code is in `src/webview/`:

```typescript
// src/webview/App.tsx
export function App() {
  return <div>My React App</div>;
}
```

Changes reload automatically with HMR!

### Handling Glasses Events

Edit `src/app/CaptionsApp.ts`:

```typescript
private async onStart(session: AppSession) {
  // Subscribe to transcription
  session.subscribe("transcription");
  
  // Handle transcriptions
  session.events.onTranscription((data) => {
    console.log("Caption:", data.text);
    // Display on glasses
    session.layouts.updateText({ text: data.text });
  });
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3333` | Server port |
| `PACKAGE_NAME` | No | `com.mentra.captions` | MentraOS package name |
| `MENTRAOS_API_KEY` | No | - | API key from console (optional) |
| `NODE_ENV` | No | `development` | Environment mode |

## Troubleshooting

**Webview not loading?**
- Check `src/webview/index.html` exists
- Verify `import index from "./webview/index.html"` in `server.ts`
- Restart dev server

**MentraOS not working?**
- Check `MENTRAOS_API_KEY` is set
- Verify package name matches console
- Check app is installed in console

**Port already in use?**
```bash
PORT=4000 bun run dev
```

## Scripts

- `bun run dev` - Start dev server with HMR
- `bun run start` - Production mode

## Resources

- [MentraOS Documentation](https://docs.mentra.glass)
- [Bun Documentation](https://bun.sh/docs)
- [Developer Console](https://console.mentra.glass)
- [Discord Community](https://discord.gg/5ukNvkEAqT)

## License

MIT