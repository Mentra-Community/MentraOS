# Captions App

A real-time live captions app for MentraOS smart glasses. Displays transcriptions from the glasses microphone directly in the user's field of view.

## 📚 Documentation

- **[Authentication Guide](./AUTH-GUIDE.md)** - Complete guide for authentication in local development
- **[Project Structure](#project-structure)** - See below

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
│   │   ├── routes.ts      # HTTP API endpoints (Bun)
│   │   └── auth-helpers.ts # Auth utilities for Bun routes
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
├── AUTH-GUIDE.md          # 📖 Authentication documentation
└── .env
```

## Architecture

**Two-Server Hybrid Architecture:**

1. **Express Server (Port 3333)** - "Front Door"
   - MentraOS AppServer integration
   - Authentication middleware
   - Session/webhook endpoints
   - Proxies to Bun for unmatched routes

2. **Bun Server (Port 3334)** - "Backend"
   - React webview with hot reload
   - API routes with auth forwarding
   - JSX/Tailwind processing

**Authentication Flow:**

- Auth middleware runs in Express
- User info forwarded to Bun via headers (`x-auth-user-id`)
- Developers can build routes in either Express or Bun
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
MENTRAOS_API_KEY=your_api_key_here  # Required
NODE_ENV=development
```

### Authentication Setup

For local development, authenticate by visiting:

```
http://localhost:3333/mentra-auth
```

This will:

1. Redirect you to the MentraOS login page
2. Ask you to authorize the app
3. Redirect back with authentication
4. Set a session cookie

See **[AUTH-GUIDE.md](./AUTH-GUIDE.md)** for complete authentication documentation.

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

The app will start:

- ✅ Express server at `http://localhost:3333` (with auth middleware)
- ✅ Bun server at `http://localhost:3334` (webview + API routes)
- ✅ Express proxies requests to Bun

## Usage

### Testing the Webview

1. Start the server: `bun run dev`
2. Authenticate: Visit `http://localhost:3333/mentra-auth`
3. Open browser: `http://localhost:3333`
4. Check auth status: `http://localhost:3333/api/me`

### Testing with Glasses

1. Ensure `MENTRAOS_API_KEY` is set in `.env`
2. Start the server: `bun run dev`
3. Launch app from MentraOS phone app
4. Captions appear on glasses

### As an Importable Module

```typescript
import {startWebServer} from "./src/server"
import {startMentraApp} from "./src/mentra-app"

// Start just the web server
const server = startWebServer({port: 3333})

// Or start MentraOS integration
const app = await startMentraApp({
  packageName: "com.example.app",
  apiKey: "your-key",
  port: 3333,
})
```

## How It Works

### Web Server (`server.ts`)

```typescript
import {serve} from "bun"
import index from "./webview/index.html"

export function startWebServer(config) {
  return serve({
    port: config.port,
    routes: {
      ...apiRoutes,
      "/*": index, // Bun handles React/Tailwind automatically
    },
  })
}
```

- Imports HTML from `webview/`
- Bun transpiles JSX/TSX on-the-fly
- HMR enabled for instant updates
- Zero build step needed

### MentraOS Integration (`mentra-app.ts`)

```typescript
import {CaptionsApp} from "./app/CaptionsApp"

export async function startMentraApp(config) {
  const app = new CaptionsApp({
    packageName: config.packageName,
    apiKey: config.apiKey,
    port: config.port,
  })

  await app.start()
  return app
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

You can add routes in **either Express or Bun**:

#### Option 1: Bun Routes (Recommended - Hot Reload)

Edit `src/api/routes.ts`:

```typescript
import {requireAuth} from "./auth-helpers"

export const routes = {
  // Public route
  "/api/hello": {
    async GET(req) {
      return Response.json({message: "Hello!"})
    },
  },

  // Protected route
  "/api/profile": requireAuth(async (req, userId) => {
    return Response.json({userId, data: "secret"})
  }),
}
```

#### Option 2: Express Routes (Traditional)

Edit `src/index.ts` (before the proxy):

```typescript
expressApp.get("/api/express-example", (req, res) => {
  const authReq = req as any
  if (!authReq.authUserId) {
    return res.status(401).json({error: "Not authenticated"})
  }
  res.json({message: "Hello from Express!", userId: authReq.authUserId})
})
```

**See [AUTH-GUIDE.md](./AUTH-GUIDE.md) for complete authentication patterns.**

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

| Variable           | Required | Default               | Description                     |
| ------------------ | -------- | --------------------- | ------------------------------- |
| `PORT`             | No       | `3333`                | Server port                     |
| `PACKAGE_NAME`     | No       | `com.mentra.captions` | MentraOS package name           |
| `MENTRAOS_API_KEY` | No       | -                     | API key from console (optional) |
| `NODE_ENV`         | No       | `development`         | Environment mode                |

## Troubleshooting

**Authentication not working?**

- Visit `http://localhost:3333/mentra-auth` to authenticate
- Check `/api/me` returns `authenticated: true`
- See [AUTH-GUIDE.md](./AUTH-GUIDE.md#troubleshooting)

**Webview not loading?**

- Always use port 3333 (Express), not 3334 (Bun)
- Check `src/webview/index.html` exists
- Restart dev server

**API routes returning 401?**

- Authenticate first via `/mentra-auth`
- Use `getAuthUserId(req)` in Bun routes
- Use `req.authUserId` in Express routes
- See [AUTH-GUIDE.md](./AUTH-GUIDE.md)

**Changes not reflecting?**

- Bun routes: Auto-reload (refresh browser)
- Express routes: Restart required

**Port already in use?**

```bash
PORT=4000 bun run dev  # Uses 4000 and 4001
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
