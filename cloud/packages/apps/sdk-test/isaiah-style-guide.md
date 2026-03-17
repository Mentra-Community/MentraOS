# Isaiah's Style Guide

Conventions for MentraOS mini apps. If it's not in here, do whatever makes sense — but if it IS in here, follow it.

## Folder Structure

```
src/
  index.ts                          ← entry point
  backend/                          ← not "server/"
    <AppName>.ts                    ← AppServer subclass
    UserSession.ts                  ← per-user state + static session store
    api/
      index.ts                      ← mounts sub-apps, nothing else
      <feature>.api.ts              ← self-contained Hono sub-app
    managers/
      <feature>.manager.ts          ← per-user manager class
  frontend/
    ...
```

### Naming

| Thing | Convention | Example |
|---|---|---|
| Folder for backend | `backend/` | NOT `server/` |
| API route files | `<feature>.api.ts` | `audio.api.ts`, `photo.api.ts` |
| Manager files | `<feature>.manager.ts` | `audio.manager.ts`, `photo.manager.ts` |
| App class | Context-specific name | `SdkTestApp`, NOT `CameraApp` if it's not a camera app |
| Per-user state class | `UserSession` | NOT `User`, NOT `Session` |

## API Files (`<feature>.api.ts`)

Each file is a **self-contained Hono sub-app**. It owns its own routes. The `index.ts` mounts it under a namespace.

### Routes at top, handlers at bottom

```typescript
import {Hono} from "hono"
import type {Context} from "hono"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/speak", speak)
app.post("/stop", stopAudio)

// ─── Handlers ────────────────────────────────────────────────────────────────

async function speak(c: Context) {
  // ...
}

async function stopAudio(c: Context) {
  // ...
}

export default app
```

**Why:** You can glance at the top 10 lines and see every route, method, and path. Handler implementation is below — read it when you need to, skip it when you don't.

### index.ts is just a mount table

```typescript
import {Hono} from "hono"
import audio from "./audio.api"
import photo from "./photo.api"

const api = new Hono()

api.get("/health", (c) => c.json({status: "ok"}))
api.route("/audio", audio)
api.route("/photo", photo)

export {api}
```

**Why:** Each feature is namespaced (`/api/audio/speak`, `/api/photo/latest`). No route conflicts possible. Adding a new feature = new file + one line in index.

## Variable Naming

**Variables match the class name.** If the class is `UserSession`, the variable is `userSession`. Not `user`, not `session`, not `u`.

```typescript
// ✅ Good
const userSession = UserSession.get(userId)
if (!userSession?.appSession) { ... }
await userSession.audio.speak(text)

// ❌ Bad
const user = UserSession.get(userId)
if (!user?.appSession) { ... }
await user.audio.speak(text)
```

Same in managers:

```typescript
// ✅ Good
export class AudioManager {
  constructor(private userSession: UserSession) {}

  async speak(text: string): Promise<void> {
    const session = this.userSession.appSession
    ...
  }
}

// ❌ Bad
export class AudioManager {
  constructor(private user: UserSession) {}
  ...
}
```

## UserSession Static Methods

No `SessionManager` class. Session store lives as static methods on `UserSession` itself.

```typescript
// ✅ Good
UserSession.getOrCreate(userId)
UserSession.get(userId)
UserSession.remove(userId)

// ❌ Bad
sessions.getOrCreate(userId)
sessionManager.get(userId)
import { sessions } from "../UserSession"
```

### Duplicate Module Bug Prevention

If the same file gets imported via different paths (`"../UserSession"` vs `"@/backend/UserSession"`), Bun treats them as separate modules — each with its own static fields. Use `globalThis` with `Symbol.for()` to guarantee a single store:

```typescript
const SESSIONS_KEY = Symbol.for("mentra.my-app.sessions")
;(globalThis as any)[SESSIONS_KEY] ??= new Map<string, UserSession>()

export class UserSession {
  private static get sessions(): Map<string, UserSession> {
    return (globalThis as any)[SESSIONS_KEY]
  }
  // ...
}
```

## Logging

### No emoji in log messages

The clean transport adds visual symbols (`✓`, `⚠`, `✗`). Emojis in the message itself are redundant noise.

```typescript
// ✅ Good
this.logger.info("App server running on port 3000")
this.logger.warn("Connection lost, reconnecting (1/3)...")
this.logger.error("Failed to connect session")

// ❌ Bad
this.logger.info("🎯 App initialized: com.example.myapp")
this.logger.warn("⚠️ SDK update available")
this.logger.error("⛔️⛔️⛔️ WebSocket connection error")
```

### No `[packageName]` prefixes

The package name is already in the logger's structured context (set once in the constructor). Don't repeat it in every message.

```typescript
// ✅ Good
this.logger.debug("Connecting to WebSocket")

// ❌ Bad
this.logger.debug(`🔌🔌🔌 [${this.config.packageName}] Attempting to connect to: ${url}`)
```

### No `\n\n` padding

```typescript
// ✅ Good
this.logger.debug({sessionId, userId, reason}, "Stop request received")

// ❌ Bad
this.logger.info(`\n\n🛑 Received stop request for user ${userId}\n\n`)
```

### Log levels

| Level | Use for |
|---|---|
| `error` | Actual failures requiring action |
| `warn` | SDK updates, abnormal closures, missing config — things the dev should see |
| `info` | Server started. That's about it. |
| `debug` | Everything else — session lifecycle, internal routing, cleanup, connection details |

**Default log level is `warn`.** Developers only see warnings and errors unless they opt in to more with `MENTRA_LOG_LEVEL=debug` or `MENTRA_VERBOSE=true`.

## Frontend

### API paths must match backend routes

If you rename backend routes, update the frontend. Every `fetch()` call and `EventSource` URL must match.

```typescript
// Backend mounts: app.route("/api/audio", audio)
// audio.api.ts has: app.post("/speak", speak)
// Full path: /api/audio/speak

// ✅ Frontend
fetch("/api/audio/speak", { method: "POST", ... })

// ❌ Stale frontend
fetch("/api/speak", { method: "POST", ... })
```

## General

- **Semicolons:** No. (Prettier/lint will enforce this.)
- **Bracket spacing:** `{thing}` not `{ thing }`.
- **Trailing commas:** Yes, everywhere.
- **Imports:** `import {Foo} from "bar"` not `import { Foo } from "bar"`.
- **Quotes:** Double quotes in TypeScript.
- **Don't over-abstract.** A `Map` is fine. You don't need a `SessionManager` class wrapping a `Map`. Static methods on the class that owns the data are enough.
- **Don't split routing from handling into separate folders.** One `api/` folder. Each file has its own routes AND handlers.