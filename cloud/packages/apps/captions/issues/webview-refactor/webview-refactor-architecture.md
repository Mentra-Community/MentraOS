# Webview Refactor Architecture

## Current System

### How Transcription Works Now

```
MentraOS Cloud
    ↓ transcription event
AppSession.events.onTranscription()
    ↓
index.ts (LiveCaptionsApp)
    ↓ process with TranscriptProcessor
    ↓ format for glasses display
session.layouts.showTextWall()
    ↓
Glasses display captions
```

**Key files:**

- `src/app/index.ts` - Main app logic (messy but works)
- `src/app/session/UserSession.ts` - Session wrapper (new, minimal)
- `src/app/session/TranscriptsManager.ts` - Stub, logs transcripts

**Current TranscriptsManager:**

```typescript
// src/app/session/TranscriptsManager.ts (current)
export class TranscriptsManager {
  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "TranscriptsManager"})
    const onTranscription = this.onTranscription.bind(this)
    this.disposables.push(this.userSession.appSession.events.onTranscription(onTranscription))
  }

  private async onTranscription(transcriptData: TranscriptionData) {
    this.logger.info("Received transcription data: " + transcriptData.text)
  }
}
```

Currently just logs - needs to store transcripts.

### Problems

1. Transcripts lost after display - not stored anywhere
2. No API to get transcript history
3. No webview UI
4. Settings in SDK but no SettingsManager abstraction
5. index.ts does everything - no separation of concerns

## Proposed System

### Architecture Overview

```
Browser Webview
    ↓ HTTP GET /api/transcripts (initial load)
    ↓ SSE /api/transcripts/stream (live updates)
    ↓ POST /api/settings/* (change settings)
Bun API Routes (src/api/)
    ↓ auth via x-auth-user-id header
    ↓ get UserSession by userId
UserSession
    ├── TranscriptsManager (stores transcripts[])
    └── SettingsManager (SimpleStorage wrapper)

Parallel:
AppSession.events.onTranscription()
    ↓ both listen to same events
    ├─→ index.ts (displays on glasses)
    └─→ TranscriptsManager (stores + pushes to webview)
```

### Data Flow

**Transcription flow:**

```
1. Transcription event arrives
2. index.ts processes it (unchanged)
3. TranscriptsManager ALSO receives it
4. TranscriptsManager stores in memory
5. TranscriptsManager pushes to SSE clients
6. Browser receives and displays
```

**Settings flow:**

```
1. Browser POSTs to /api/settings/language
2. SettingsManager.set("language", "es")
3. SimpleStorage persists
4. Applies to index.ts via AppSession.settings
5. Future transcripts use new language
```

## Implementation Details

### 1. TranscriptsManager (Enhanced)

**Location:** `src/app/session/TranscriptsManager.ts`

**Responsibilities:**

- Listen to transcription events
- Store transcripts in memory (array)
- Normalize speaker IDs ("Speaker 1", "Speaker 2")
- Track interim vs final state
- Push updates to SSE clients
- Limit to 100 transcripts (circular buffer)

**Data structure:**

```typescript
interface TranscriptEntry {
  id: string // UUID
  speaker: string // "Speaker 1", "Speaker 2"
  text: string
  timestamp: string | null // "2:30 PM" or null
  isFinal: boolean
  receivedAt: number // Unix timestamp
}

class TranscriptsManager {
  private transcripts: TranscriptEntry[] = []
  private maxTranscripts = 100
  private sseClients: Set<SSEClient> = new Set()

  private async onTranscription(data: TranscriptionData) {
    const entry = this.createEntry(data)

    if (data.isFinal) {
      // Replace interim with final
      this.replaceInterim(entry)
    } else {
      // Update or add interim
      this.updateInterim(entry)
    }

    // Push to SSE clients
    this.broadcast(entry)
  }

  public getAll(): TranscriptEntry[] {
    return this.transcripts
  }

  public addSSEClient(client: SSEClient): void {
    this.sseClients.add(client)
  }

  public removeSSEClient(client: SSEClient): void {
    this.sseClients.delete(client)
  }
}
```

**Interim → Final logic:**

- Interim transcripts update in place (same speaker, not final yet)
- When final arrives, replace last interim with final version
- Add timestamp to final transcripts

**Speaker normalization:**

- Check if `data.speaker` exists in transcription event
- If not, use "Speaker 1" as default
- Track speaker changes to assign consistent IDs

### 2. SettingsManager (New)

**Location:** `src/app/session/SettingsManager.ts`

**Responsibilities:**

- Wrap SimpleStorage API
- Provide typed getters/setters
- Default values
- Validation

**Implementation:**

```typescript
import {AppSession} from "@mentra/sdk"
import {UserSession} from "./UserSession"

interface CaptionSettings {
  language: string
  languageHints: string[]
  displayLines: number
  displayWidth: number
}

export class SettingsManager {
  private readonly storage: AppSession["storage"]
  private readonly logger: AppSession["logger"]

  constructor(userSession: UserSession) {
    this.storage = userSession.appSession.storage
    this.logger = userSession.logger.child({service: "SettingsManager"})
  }

  async getLanguage(): Promise<string> {
    return (await this.storage.get("language")) || "en"
  }

  async setLanguage(lang: string): Promise<void> {
    await this.storage.set("language", lang)
    // Also update SDK settings for index.ts
    await this.applyToSDKSettings()
  }

  async getLanguageHints(): Promise<string[]> {
    return (await this.storage.get("languageHints")) || []
  }

  async setLanguageHints(hints: string[]): Promise<void> {
    await this.storage.set("languageHints", hints)
  }

  async getDisplayLines(): Promise<number> {
    return (await this.storage.get("displayLines")) || 3
  }

  async setDisplayLines(lines: number): Promise<void> {
    if (lines < 2 || lines > 5) {
      throw new Error("Lines must be 2-5")
    }
    await this.storage.set("displayLines", lines)
    await this.applyToSDKSettings()
  }

  async getAll(): Promise<CaptionSettings> {
    return {
      language: await this.getLanguage(),
      languageHints: await this.getLanguageHints(),
      displayLines: await this.getDisplayLines(),
      displayWidth: await this.getDisplayWidth(),
    }
  }

  private async applyToSDKSettings(): Promise<void> {
    // Update AppSession.settings so index.ts picks up changes
    const language = await this.getLanguage()
    const lines = await this.getDisplayLines()
    const width = await this.getDisplayWidth()

    this.userSession.appSession.settings.set("transcribe_language", language)
    this.userSession.appSession.settings.set("number_of_lines", lines)
    this.userSession.appSession.settings.set("line_width", width)
  }
}
```

**Key insight:** Settings stored in SimpleStorage BUT also synced to `AppSession.settings` so index.ts can use them.

### 3. REST API Routes

**Location:** `src/api/transcripts.ts`, `src/api/settings.ts`

**GET /api/transcripts:**

```typescript
// src/api/transcripts.ts
import {requireAuth} from "./auth-helpers"
import {UserSession} from "../app/session/UserSession"

export const transcriptsRoutes = {
  "/api/transcripts": requireAuth(async (req, userId) => {
    const userSession = UserSession.getUserSession(userId)

    if (!userSession) {
      return Response.json({error: "No active session"}, {status: 404})
    }

    const transcripts = userSession.transcripts.getAll()

    return Response.json({transcripts})
  }),
}
```

**POST /api/settings/language:**

```typescript
// src/api/settings.ts
import {requireAuth} from "./auth-helpers"
import {UserSession} from "../app/session/UserSession"

export const settingsRoutes = {
  "/api/settings": requireAuth(async (req, userId) => {
    const userSession = UserSession.getUserSession(userId)
    if (!userSession) {
      return Response.json({error: "No active session"}, {status: 404})
    }

    const settings = await userSession.settings.getAll()
    return Response.json(settings)
  }),

  "/api/settings/language": {
    POST: requireAuth(async (req, userId) => {
      const userSession = UserSession.getUserSession(userId)
      if (!userSession) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      const body = await req.json()
      const {language} = body

      if (!language || typeof language !== "string") {
        return Response.json({error: "Invalid language"}, {status: 400})
      }

      await userSession.settings.setLanguage(language)

      return Response.json({success: true})
    }),
  },

  "/api/settings/language-hints": {
    POST: requireAuth(async (req, userId) => {
      const userSession = UserSession.getUserSession(userId)
      if (!userSession) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      const body = await req.json()
      const {hints} = body

      if (!Array.isArray(hints)) {
        return Response.json({error: "hints must be array"}, {status: 400})
      }

      await userSession.settings.setLanguageHints(hints)

      return Response.json({success: true})
    }),
  },

  // Similar for display-lines, display-width
}
```

**Merge into main routes:**

```typescript
// src/api/routes.ts
import {transcriptsRoutes} from "./transcripts"
import {settingsRoutes} from "./settings"
import {transcriptStreamRoute} from "./transcripts-stream"

export const routes = {
  ...transcriptsRoutes,
  ...settingsRoutes,
  ...transcriptStreamRoute,
  // existing routes
}
```

### 4. SSE Endpoint

**Location:** `src/api/transcripts-stream.ts`

**Implementation:**

```typescript
// src/api/transcripts-stream.ts
import {getAuthUserId} from "./auth-helpers"
import {UserSession} from "../app/session/UserSession"

export const transcriptStreamRoute = {
  "/api/transcripts/stream": {
    async GET(req: Request, server: any) {
      const userId = getAuthUserId(req)

      if (!userId) {
        return new Response("Unauthorized", {status: 401})
      }

      const userSession = UserSession.getUserSession(userId)

      if (!userSession) {
        return new Response("No active session", {status: 404})
      }

      // Create SSE response
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          // Send initial connection message
          const msg = `data: ${JSON.stringify({type: "connected"})}\n\n`
          controller.enqueue(encoder.encode(msg))

          // Register client with TranscriptsManager
          const client = {
            send: (data: any) => {
              const msg = `data: ${JSON.stringify(data)}\n\n`
              try {
                controller.enqueue(encoder.encode(msg))
              } catch (e) {
                // Client disconnected
                userSession.transcripts.removeSSEClient(client)
              }
            },
          }

          userSession.transcripts.addSSEClient(client)

          // Cleanup on disconnect
          req.signal?.addEventListener("abort", () => {
            userSession.transcripts.removeSSEClient(client)
            controller.close()
          })
        },
      })

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      })
    },
  },
}
```

**SSE Client interface:**

```typescript
interface SSEClient {
  send(data: any): void
}
```

**TranscriptsManager broadcasts:**

```typescript
class TranscriptsManager {
  private broadcast(entry: TranscriptEntry): void {
    const message = {
      type: entry.isFinal ? "final" : "interim",
      id: entry.id,
      speaker: entry.speaker,
      text: entry.text,
      timestamp: entry.timestamp,
    }

    for (const client of this.sseClients) {
      client.send(message)
    }
  }
}
```

### 5. Frontend (React)

**Location:** `src/webview/`

**Structure:**

```
src/webview/
├── App.tsx                      # Main component
├── components/
│   ├── TranscriptList.tsx       # Scrollable list
│   ├── TranscriptItem.tsx       # Individual transcript
│   ├── LanguageModal.tsx        # Language picker
│   └── SettingsModal.tsx        # Display settings
├── hooks/
│   ├── useTranscripts.ts        # SSE + state
│   └── useSettings.ts           # Settings API
└── lib/
    └── api.ts                   # API client
```

**useTranscripts hook:**

```typescript
// src/webview/hooks/useTranscripts.ts
import {useState, useEffect} from "react"

interface Transcript {
  id: string
  speaker: string
  text: string
  timestamp: string | null
  isFinal: boolean
}

export function useTranscripts() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // Load initial history
    fetch("/api/transcripts")
      .then((res) => res.json())
      .then((data) => setTranscripts(data.transcripts))

    // Connect to SSE
    const eventSource = new EventSource("/api/transcripts/stream")

    eventSource.onopen = () => setConnected(true)

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === "interim") {
        // Update or add interim transcript
        setTranscripts((prev) => {
          const existing = prev.findIndex((t) => !t.isFinal && t.speaker === data.speaker)
          if (existing !== -1) {
            const updated = [...prev]
            updated[existing] = {
              id: data.id,
              speaker: data.speaker,
              text: data.text,
              timestamp: null,
              isFinal: false,
            }
            return updated
          }
          return [
            ...prev,
            {
              id: data.id,
              speaker: data.speaker,
              text: data.text,
              timestamp: null,
              isFinal: false,
            },
          ]
        })
      } else if (data.type === "final") {
        // Replace interim with final
        setTranscripts((prev) => {
          const updated = prev.filter((t) => t.isFinal)
          updated.push({
            id: data.id,
            speaker: data.speaker,
            text: data.text,
            timestamp: data.timestamp,
            isFinal: true,
          })
          return updated
        })
      }
    }

    eventSource.onerror = () => setConnected(false)

    return () => eventSource.close()
  }, [])

  return {transcripts, connected}
}
```

**useSettings hook:**

```typescript
// src/webview/hooks/useSettings.ts
import {useState, useEffect} from "react"

interface Settings {
  language: string
  languageHints: string[]
  displayLines: number
  displayWidth: number
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then(setSettings)
  }, [])

  const updateLanguage = async (language: string) => {
    await fetch("/api/settings/language", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({language}),
    })
    setSettings((prev) => (prev ? {...prev, language} : null))
  }

  const updateLanguageHints = async (hints: string[]) => {
    await fetch("/api/settings/language-hints", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({hints}),
    })
    setSettings((prev) => (prev ? {...prev, languageHints: hints} : null))
  }

  // Similar for displayLines, displayWidth

  return {
    settings,
    updateLanguage,
    updateLanguageHints,
    // ...
  }
}
```

**Main App component:**

```typescript
// src/webview/App.tsx
import {useTranscripts} from "./hooks/useTranscripts"
import {useSettings} from "./hooks/useSettings"
import {TranscriptList} from "./components/TranscriptList"
import {LanguageModal} from "./components/LanguageModal"
import {SettingsModal} from "./components/SettingsModal"

export function App() {
  const {transcripts, connected} = useTranscripts()
  const {settings, updateLanguage, updateLanguageHints} = useSettings()

  return (
    <div className="flex flex-col h-screen">
      <header>
        <h1>Live Captions</h1>
        <LanguageModal
          language={settings?.language}
          hints={settings?.languageHints}
          onChangeLanguage={updateLanguage}
          onChangeHints={updateLanguageHints}
        />
        <SettingsModal settings={settings} />
      </header>

      <TranscriptList transcripts={transcripts} />

      {!connected && <div>Disconnected...</div>}
    </div>
  )
}
```

## Migration Strategy

### Phase 1: Backend (No UI impact)

1. Create SettingsManager
2. Enhance TranscriptsManager to store transcripts
3. Add REST endpoints
4. Add SSE endpoint
5. Test with curl

### Phase 2: Frontend

1. Build basic webview UI
2. Connect to REST API for initial load
3. Connect to SSE for live updates
4. Add modals for settings

### Phase 3: Integration

1. Test end-to-end
2. Verify index.ts still works
3. Verify settings apply to both webview and glasses

### Phase 4: Polish

1. Speaker colors
2. Auto-scroll
3. Empty state
4. Error handling

## Key Design Decisions

### Why SSE over WebSocket?

- Simpler (one-way push)
- Auto-reconnect built-in
- Settings changes via REST (not bidirectional)

### Why not modify index.ts?

- It works
- It's messy and risky to change
- New system runs in parallel
- Can eventually deprecate index.ts later

### Why SimpleStorage for settings?

- Persists across sessions
- Built into SDK
- Per-user isolation automatic

### Why circular buffer for transcripts?

- Prevent unbounded memory growth
- 100 transcripts = ~10-20 minute conversation
- Reasonable limit

## Testing Plan

### Unit Tests

```typescript
// TranscriptsManager.test.ts
test("stores final transcript", () => {
  const manager = new TranscriptsManager(userSession)
  manager.onTranscription({text: "hello", isFinal: true, speaker: "Speaker 1"})
  expect(manager.getAll()).toHaveLength(1)
  expect(manager.getAll()[0].isFinal).toBe(true)
})

test("replaces interim with final", () => {
  const manager = new TranscriptsManager(userSession)
  manager.onTranscription({text: "hello", isFinal: false, speaker: "Speaker 1"})
  manager.onTranscription({text: "hello world", isFinal: true, speaker: "Speaker 1"})
  expect(manager.getAll()).toHaveLength(1)
  expect(manager.getAll()[0].text).toBe("hello world")
})
```

### Integration Tests

```bash
# Start app
bun run dev

# Authenticate
curl http://localhost:3333/mentra-auth

# Get transcripts
curl http://localhost:3333/api/transcripts --cookie cookies.txt

# Change language
curl -X POST http://localhost:3333/api/settings/language \
  -H "Content-Type: application/json" \
  -d '{"language":"es"}' \
  --cookie cookies.txt

# Connect to SSE
curl -N http://localhost:3333/api/transcripts/stream --cookie cookies.txt
```

## index.ts Cleanup Plan

### Current Problems

`index.ts` has global state scattered everywhere:

```typescript
// Global maps tracking user-specific state (BAD)
const userTranscriptProcessors: Map<string, TranscriptProcessor> = new Map()
const userActiveLanguages: Map<string, string> = new Map()

// Instance maps (also global state)
private sessionDebouncers = new Map<string, TranscriptDebouncer>()
private activeUserSessions = new Map<string, {session: AppSession; sessionId: string}>()
private inactivityTimers = new Map<string, InactivityTimer>()
```

**Issues:**

1. State not tied to UserSession lifecycle
2. Manual cleanup required (easy to leak)
3. Hard to test
4. Settings logic duplicated
5. No separation of concerns

### Refactor Plan

Move all user-specific state into UserSession managers:

**New managers:**

1. **DisplayManager** (`app/session/DisplayManager.ts`)
   - Owns `TranscriptProcessor` instance
   - Handles debouncing logic
   - Manages inactivity timer (clears after 40s)
   - Shows text on glasses via `session.layouts.showTextWall()`

2. **SettingsManager** (`app/session/SettingsManager.ts`)
   - Replaces direct `session.settings` usage
   - Uses SimpleStorage for persistence
   - Tracks active language
   - Applies settings to both webview and glasses

3. **TranscriptsManager** (existing, already clean)
   - Store transcript history
   - SSE broadcasting

**Updated UserSession:**

```typescript
export class UserSession {
  readonly transcripts: TranscriptsManager
  readonly settings: SettingsManager
  readonly processor: DisplayManager // NEW

  constructor(appSession: AppSession) {
    this.transcripts = new TranscriptsManager(this)
    this.settings = new SettingsManager(this)
    this.processor = new DisplayManager(this)
  }

  dispose() {
    this.transcripts.dispose()
    this.settings.dispose()
    this.processor.dispose() // Cleans up timers
  }
}
```

### DisplayManager Details

**Responsibilities:**

- Create and own `TranscriptProcessor` instance
- Debounce non-final transcripts (400ms)
- Inactivity timer (clear text after 40s)
- Display on glasses

**Implementation:**

```typescript
// app/session/DisplayManager.ts
import {TranscriptProcessor} from "../utils"
import {UserSession} from "./UserSession"
import {ViewType} from "@mentra/sdk"

interface TranscriptDebouncer {
  lastSentTime: number
  timer: NodeJS.Timeout | null
}

export class DisplayManager {
  private processor: TranscriptProcessor
  private debouncer: TranscriptDebouncer
  private inactivityTimer: NodeJS.Timeout | null = null
  private readonly userSession: UserSession

  constructor(userSession: UserSession) {
    this.userSession = userSession

    // Initialize with defaults (will be updated by SettingsManager)
    this.processor = new TranscriptProcessor(30, 3, 30)
    this.debouncer = {lastSentTime: 0, timer: null}
  }

  updateSettings(lineWidth: number, numberOfLines: number, isChineseLanguage: boolean): void {
    // Create new processor with settings
    this.processor = new TranscriptProcessor(lineWidth, numberOfLines, 30, isChineseLanguage)
  }

  processAndDisplay(text: string, isFinal: boolean): void {
    const formatted = this.processor.processString(text, isFinal)
    this.debounceAndShow(formatted, isFinal)
    this.resetInactivityTimer()
  }

  private debounceAndShow(text: string, isFinal: boolean): void {
    const debounceDelay = 400

    if (this.debouncer.timer) {
      clearTimeout(this.debouncer.timer)
      this.debouncer.timer = null
    }

    const now = Date.now()

    if (isFinal) {
      this.showOnGlasses(text, true)
      this.debouncer.lastSentTime = now
      return
    }

    if (now - this.debouncer.lastSentTime >= debounceDelay) {
      this.showOnGlasses(text, false)
      this.debouncer.lastSentTime = now
    } else {
      this.debouncer.timer = setTimeout(() => {
        this.showOnGlasses(text, false)
        this.debouncer.lastSentTime = Date.now()
      }, debounceDelay)
    }
  }

  private showOnGlasses(text: string, isFinal: boolean): void {
    const cleaned = text.replace(/^[.,;:!?。，；：！？]+/, "").trim()

    this.userSession.appSession.layouts.showTextWall(cleaned, {
      view: ViewType.MAIN,
      durationMs: isFinal ? 20000 : undefined,
    })
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
    }

    this.inactivityTimer = setTimeout(() => {
      this.processor.clear()
      this.userSession.appSession.layouts.showTextWall("", {
        view: ViewType.MAIN,
        durationMs: 1000,
      })
    }, 40000)
  }

  dispose(): void {
    if (this.debouncer.timer) {
      clearTimeout(this.debouncer.timer)
    }
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
    }
  }
}
```

### Simplified index.ts

**Before (100+ lines of logic):**

```typescript
protected async onSession(session: AppSession, sessionId: string, userId: string) {
  // Initialize transcript processor and debouncer for this session
  this.sessionDebouncers.set(sessionId, {lastSentTime: 0, timer: null})
  this.inactivityTimers.set(sessionId, {timer: null, lastActivityTime: Date.now()})
  // ... 50+ more lines of setup
}
```

**After (clean delegation):**

```typescript
protected async onSession(session: AppSession, sessionId: string, userId: string) {
  const userSession = new UserSession(session)

  // All logic now in managers
  userSession.settings.initialize()

  // Listen to transcriptions
  const cleanup = session.events.onTranscription((data) => {
    userSession.processor.processAndDisplay(data.text, data.isFinal)
  })

  this.addCleanupHandler(cleanup)
}

protected async onStop(sessionId: string, userId: string, reason: string) {
  UserSession.getUserSession(userId)?.dispose()  // Auto-cleans everything
}
```

### Migration Steps

1. **Create DisplayManager**
   - Extract debouncing logic from index.ts
   - Extract inactivity timer logic
   - Extract showTranscriptsToUser logic

2. **Update SettingsManager**
   - Move setupSettingsHandlers logic
   - Move applySettings logic
   - Sync with DisplayManager

3. **Update index.ts**
   - Remove global maps
   - Remove instance maps
   - Delegate to managers
   - Keep only session lifecycle

4. **Test**
   - Verify captions still work on glasses
   - Verify settings changes apply
   - Verify cleanup happens

### Benefits

- ✅ No global state (everything in UserSession)
- ✅ Automatic cleanup (dispose() handles it)
- ✅ Easier to test (mock UserSession)
- ✅ Separation of concerns
- ✅ Reusable managers

## Open Questions

1. **Speaker ID format**: Need to check what Soniox sends - do we get speaker IDs or need to detect changes?
2. **Reconnection strategy**: Send full history on SSE reconnect or just new transcripts?
3. **Max transcript limit**: 100 enough? Test with real usage
4. **Settings sync timing**: When settings change, do we clear transcript history?
5. **index.ts refactor timing**: Do this before or after webview implementation?

## Performance Targets

- SSE message latency: <50ms
- REST API response: <100ms
- Memory per session: <10MB (100 transcripts ~= 50KB + overhead)
- SSE connection count: Support 5+ concurrent clients per user
