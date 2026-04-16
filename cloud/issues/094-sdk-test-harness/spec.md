# Spec: SDK Test Harness — v1 (Get It Working)

**Issue:** 094-sdk-test-harness
**Spike:** [spike.md](./spike.md)
**App:** `examples/stream-test/`
**Date:** April 10, 2026

## Scope

Add Gemini 3.1 Flash Live to the stream-test app so you can talk to Gemini through the glasses and it can call SDK methods. Two-tab webview UI: existing Stream tab + new Live Test tab.

**In scope:** GeminiManager, audio pipeline, 6 starter tools, capability gating, transcript + tool log UI.
**Out of scope:** Provider abstraction, OpenAI, Manager Explorer, automated test runner (`run_test`), the full 20-tool set. All deferred to expand phase.

---

## 1. GeminiManager

Single class on `UserSession`, follows the same pattern as `StreamManager` and `MicTestManager`.

```
backend/session/GeminiManager.ts
```

### Responsibilities

- Owns the `ai.live.connect()` session
- Forwards mic audio to Gemini (PCM16 16kHz → base64)
- Pipes Gemini audio responses to glasses speaker (PCM16 24kHz → output stream)
- Dispatches tool calls to handler functions
- Sends tool responses back via `session.sendToolResponse()`
- Pushes state updates to `StateManager`

### Interface

```ts
class GeminiManager {
  constructor(stateManager: StateManager)

  attachSession(session: MentraSession): void
  detachSession(): void

  start(config: { apiKey: string; systemPrompt?: string; voice?: string }): Promise<void>
  stop(): Promise<void>

  isActive(): boolean
  getSnapshot(): GeminiState
}
```

### Internal structure

```
private session: MentraSession | null
private geminiSession: any           // ai.live.connect() return
private ai: any                      // GoogleGenAI instance
private outputStream: any            // session.speaker.createStream()
private micCleanup: (() => void) | null
private active: boolean
```

### Lifecycle

**start():**
1. Dynamic import `@google/genai`
2. Build tool declarations (capability-gated, see §4)
3. `ai.live.connect()` with model, tools, callbacks
4. Create output stream: `session.speaker.createStream({ format: "pcm16", sampleRate: 24000, channels: 1 })`
5. Start mic forwarding: `session.mic.onChunk()` → base64 → `geminiSession.sendRealtimeInput()`
6. Push state `{ connected: true }`

**stop():**
1. Unsubscribe mic
2. End output stream
3. `geminiSession.close()`
4. Push state `{ connected: false, speaking: false }`

**handleMessage(message):** (callback from `ai.live.connect`)
- `message.serverContent.modelTurn.parts[].inlineData.data` → decode base64 → `outputStream.write(pcmBytes)`, push `speaking: true`
- `message.serverContent.modelTurn.parts[].text` → append to transcript
- `message.serverContent.turnComplete` → push `speaking: false`, append transcript entry
- `message.serverContent.interrupted` → push `speaking: false`
- `message.toolCall` → dispatch to tool handler (§5), log to tool call log, send response
- `message.setupComplete` → log

### Audio pipeline

```
INPUT:  glasses mic → session.mic.onChunk(chunk) → base64(new Uint8Array(chunk.data)) → geminiSession.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } })
OUTPUT: gemini onmessage → Buffer.from(inlineData.data, "base64") → outputStream.write(pcmBytes) → SDK encodes PCM→MP3 via lamejs → cloud relay → glasses speaker
```

Key detail: output stream uses `sampleRate: 24000` because Gemini outputs 24kHz. Input is 16kHz from the mic. The SDK handles the PCM→MP3 encoding internally.

### Gemini config

```ts
const GEMINI_MODEL = "gemini-3.1-flash-live"

await ai.live.connect({
  model: GEMINI_MODEL,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: SYSTEM_PROMPT,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voice || "Puck" },
      },
    },
    tools: [{ functionDeclarations: toolDeclarations }],
  },
  callbacks: { onopen, onmessage, onerror, onclose },
})
```

---

## 2. State

### New types in `shared/state.ts`

```ts
interface TranscriptEntry {
  role: "user" | "model"
  text: string
  timestamp: string       // ISO 8601
}

interface ToolLogEntry {
  name: string
  args: Record<string, unknown>
  result: unknown
  timestamp: string       // ISO 8601
  durationMs: number
  error?: string
}

interface GeminiState {
  connected: boolean
  speaking: boolean
  transcript: TranscriptEntry[]
  toolLog: ToolLogEntry[]
  error: string | null
}
```

### AppState extension

```ts
interface AppState {
  stream: StreamState       // existing
  micTest: MicTestState     // existing
  gemini: GeminiState       // new
}
```

### Default

```ts
const DEFAULT_GEMINI: GeminiState = {
  connected: false,
  speaking: false,
  transcript: [],
  toolLog: [],
  error: null,
}
```

### State updates from GeminiManager

| Event | State change |
|---|---|
| Connected | `connected: true, error: null` |
| Disconnected / error | `connected: false, speaking: false, error: message` |
| Model starts speaking | `speaking: true` |
| Turn complete / interrupted | `speaking: false` |
| Model text part | Append `{ role: "model", text, timestamp }` to transcript |
| User transcript (if available from API) | Append `{ role: "user", text, timestamp }` to transcript |
| Tool call dispatched + result | Append to toolLog |

---

## 3. API Routes

New file: `backend/api/gemini.api.ts`, mounted at `/api/gemini` in the api index.

```
POST /api/gemini/start   → geminiManager.start({ apiKey })
POST /api/gemini/stop    → geminiManager.stop()
GET  /api/gemini/status  → { connected, speaking, error }
```

All routes resolve the user via `getMentraAuth(c)` → `UserSession.get(userId)`, same pattern as stream and mic-test routes.

**start** reads `GEMINI_API_KEY` from server env (not sent from client). Returns `{ ok: true }` or `{ ok: false, error }`.

**stop** returns `{ ok: true }`.

**status** returns the snapshot from `geminiManager.getSnapshot()`, minus transcript/toolLog (those flow over SSE).

### API index update

```ts
// backend/api/index.ts
import gemini from "./gemini.api"
api.route("/gemini", gemini)
```

---

## 4. Tool Declarations (Starter Set)

Six tools. Enough to prove the pattern across multiple managers and capability gates.

### Always available

```ts
{
  name: "get_device_info",
  description: "Get current device info: battery level, model name, connection state, WiFi status.",
  parameters: { type: "object", properties: {}, required: [] }
}
```

```ts
{
  name: "get_capabilities",
  description: "Get what the connected glasses can do: hasCamera, hasDisplay, hasSpeaker, hasLight, hasMic.",
  parameters: { type: "object", properties: {}, required: [] }
}
```

### Display glasses only (`capabilities.hasDisplay`)

```ts
{
  name: "show_text",
  description: "Show a short text message on the glasses display.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to display on the glasses." }
    },
    required: ["text"]
  }
}
```

```ts
{
  name: "clear_display",
  description: "Clear the glasses display.",
  parameters: { type: "object", properties: {}, required: [] }
}
```

### Camera glasses only (`capabilities.hasCamera`)

```ts
{
  name: "take_photo",
  description: "Take a photo with the glasses camera. Returns a URL to the captured image.",
  parameters: { type: "object", properties: {}, required: [] }
}
```

```ts
{
  name: "start_stream",
  description: "Start a managed video stream from the glasses camera. Returns viewer URLs (HLS, WebRTC).",
  parameters: { type: "object", properties: {}, required: [] }
}
```

### Capability gating

Tool declarations are built dynamically when `GeminiManager.start()` is called:

```ts
function buildToolDeclarations(session: MentraSession): FunctionDeclaration[] {
  const tools = [...ALWAYS_TOOLS]
  const caps = session.capabilities

  if (caps?.hasDisplay) tools.push(...DISPLAY_TOOLS)
  if (caps?.hasCamera)  tools.push(...CAMERA_TOOLS)
  // Future: if (caps?.hasSpeaker) tools.push(...SPEAKER_TOOLS)
  // Future: if (caps?.hasLight)   tools.push(...LED_TOOLS)

  return tools
}
```

If capabilities aren't available yet (no glasses connected), only the always-available tools are declared. If glasses connect/disconnect mid-session, we'd need to restart the Gemini session with updated tools — but for v1, we just build once at start time.

---

## 5. Tool Dispatch

Single function that maps tool name → SDK call:

```ts
// backend/session/tool-handlers.ts

async function handleToolCall(
  session: MentraSession,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_device_info":
      return {
        battery: session.device.battery.value,
        model: session.device.model.value,
        connectionState: session.device.connectionState.value,
      }

    case "get_capabilities":
      return session.capabilities ?? { error: "No glasses connected" }

    case "show_text":
      session.display.showText(args.text as string)
      return { ok: true }

    case "clear_display":
      session.display.clear()
      return { ok: true }

    case "take_photo": {
      const photo = await session.camera.takePhoto()
      return { url: photo.url, width: photo.width, height: photo.height }
    }

    case "start_stream": {
      const stream = await session.camera.startStream()
      return { hlsUrl: stream.hlsUrl, webrtcUrl: stream.webrtcUrl }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}
```

### Tool call flow in GeminiManager.handleMessage

```ts
if (message.toolCall) {
  const responses = []

  for (const call of message.toolCall.functionCalls) {
    const startTime = Date.now()
    let result: unknown
    let error: string | undefined

    try {
      result = await handleToolCall(this.session!, call.name, call.args ?? {})
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      result = { error }
    }

    const durationMs = Date.now() - startTime

    // Log to state
    this.appendToolLog({
      name: call.name,
      args: call.args ?? {},
      result,
      timestamp: new Date().toISOString(),
      durationMs,
      error,
    })

    responses.push({
      id: call.id,
      response: { output: result },
    })
  }

  // Send all tool responses back to Gemini
  this.geminiSession.sendToolResponse({ functionResponses: responses })
}
```

---

## 6. System Prompt

```
You are a test assistant for MentraOS smart glasses. You are speaking to a developer who is testing the SDK.

You have tools that control the glasses hardware. When the user asks you to do something with the glasses (show text, take a photo, start streaming, etc.), use the appropriate tool.

After calling a tool, briefly confirm what happened. For example: "Done, I showed 'Hello world' on the display" or "Photo taken, the image is 1920x1080."

If a tool call fails, tell the user what went wrong.

Keep responses short and conversational. You're a testing buddy, not a lecture bot.

Available tools depend on what glasses are connected. If the user asks for something the glasses can't do, explain which glasses support that feature.
```

---

## 7. UserSession Changes

```ts
class UserSession {
  readonly stream: StreamManager
  readonly micTest: MicTestManager
  readonly gemini: GeminiManager    // new

  private constructor(userId: string) {
    this.state = new StateManager()
    this.stream = new StreamManager(this.state)
    this.micTest = new MicTestManager(this.state)
    this.gemini = new GeminiManager(this.state)  // new
  }

  attachSession(session: MentraSession): void {
    this.session = session
    this.stream.attachSession(session)
    this.micTest.attachSession(session)
    this.gemini.attachSession(session)            // new
  }

  detachSession(): void {
    this.stream.detachSession()
    this.micTest.detachSession()
    this.gemini.detachSession()                   // new
    this.session = null
  }
}
```

---

## 8. Frontend — Two-Tab UI

### Tab structure

Replace the current single-page layout with a tab bar at the top:

```
┌──────────────────────────────┐
│  [Stream]  [Live Test]       │
├──────────────────────────────┤
│                              │
│  (tab content)               │
│                              │
└──────────────────────────────┘
```

**Stream tab** — everything that exists today (video player, start/stop stream, mic test, status row). No changes.

**Live Test tab** — new:

```
┌──────────────────────────────┐
│  Gemini 3.1 Flash Live       │
│  ● Connected  ○ Speaking     │
│  [Start] [Stop]              │
├──────────────────────────────┤
│  Transcript                  │
│  ┌────────────────────────┐  │
│  │ You: Show hello world  │  │
│  │ Gemini: Done, I showed │  │
│  │ "hello world" on the   │  │
│  │ display.               │  │
│  │ You: Take a photo      │  │
│  │ Gemini: Photo taken,   │  │
│  │ 1920x1080.             │  │
│  └────────────────────────┘  │
├──────────────────────────────┤
│  Tool Calls                  │
│  ┌────────────────────────┐  │
│  │ show_text("hello...")  │  │
│  │  → { ok: true } 12ms  │  │
│  │ take_photo()           │  │
│  │  → { url: "...",       │  │
│  │    width: 1920 } 850ms │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

### Components

```
frontend/
  App.tsx                    — tab bar + tab routing (state: activeTab)
  tabs/
    StreamTab.tsx            — extract current App.tsx content into this
    LiveTestTab.tsx           — new: Gemini controls, transcript, tool log
  components/
    WebRTCPlayer.tsx         — existing, no changes
    Transcript.tsx           — scrolling list of TranscriptEntry
    ToolLog.tsx              — scrolling list of ToolLogEntry
  hooks/
    use-app-state.ts         — existing, no changes (already gets full AppState including gemini slice)
```

### LiveTestTab behavior

- Reads `state.gemini` from `useAppState()` — transcript and tool log arrive over SSE automatically.
- Start button: `POST /api/gemini/start` — disabled when already connected.
- Stop button: `POST /api/gemini/stop` — disabled when not connected.
- Transcript auto-scrolls to bottom on new entries.
- Tool log shows name, args (collapsed if long), result, duration, and error state (red if failed).

---

## 9. Environment

Add to `.env`:

```
GEMINI_API_KEY=your_google_ai_key
```

Read in `GeminiManager.start()` via `process.env.GEMINI_API_KEY`. Never sent to the frontend.

---

## 10. Build Order

Each step is independently testable:

| Step | What | Test |
|---|---|---|
| 1 | `GeminiState` + `AppState` extension + defaults | App compiles, SSE sends gemini slice |
| 2 | `GeminiManager` — connect/disconnect, audio round-trip only (no tools) | Talk to Gemini through glasses, hear response |
| 3 | API routes (`/api/gemini/*`) | curl start/stop/status |
| 4 | `tool-handlers.ts` + tool declarations + dispatch in handleMessage | Ask Gemini to get device info, see tool log |
| 5 | Two-tab UI: tab bar + StreamTab extraction | Webview shows tabs, Stream tab works as before |
| 6 | LiveTestTab: transcript + tool log + start/stop | Full loop: voice → Gemini → tool → result in UI |

Steps 1-4 are backend. Steps 5-6 are frontend. Backend can be tested with glasses before any UI work.

---

## 11. Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `src/backend/session/GeminiManager.ts` | Gemini Live session, audio pipeline, tool dispatch |
| `src/backend/session/tool-handlers.ts` | Tool name → SDK method mapping |
| `src/backend/api/gemini.api.ts` | REST routes for Gemini lifecycle |
| `src/frontend/tabs/StreamTab.tsx` | Extracted from current App.tsx |
| `src/frontend/tabs/LiveTestTab.tsx` | Gemini controls, transcript, tool log |
| `src/frontend/components/Transcript.tsx` | Transcript display component |
| `src/frontend/components/ToolLog.tsx` | Tool call log display component |

### Modified files

| File | Change |
|---|---|
| `src/shared/state.ts` | Add `GeminiState`, `TranscriptEntry`, `ToolLogEntry`, extend `AppState` |
| `src/backend/session/UserSession.ts` | Add `gemini: GeminiManager`, wire attach/detach |
| `src/backend/api/index.ts` | Mount `/api/gemini` route |
| `src/frontend/App.tsx` | Tab bar, route to StreamTab / LiveTestTab |
| `package.json` | Add `@google/genai` dependency |

---

## 12. What comes after v1

Once this works end to end (voice → Gemini → tool call → result on glasses → log in webview):

- **More tools:** speaker (TTS, play audio), LED, transcription, location, storage, phone — the remaining ~15 from the spike
- **Manager Explorer tab:** list of managers, tap to open, manual controls + live state per manager
- **`run_test(manager)`:** automated test runner that executes checklist items and reports pass/fail
- **Provider abstraction:** if we ever want OpenAI Realtime as an alternative provider
- **Reconnect handling:** restart Gemini session with updated tools if glasses change mid-session
- **Audio visualization:** waveform or level meter in the Live Test tab