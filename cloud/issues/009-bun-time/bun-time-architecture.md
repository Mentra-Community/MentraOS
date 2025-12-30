# Bun Time Architecture

## Current System

### WebSocket Server Setup

```
HTTP Server (Node.js)
    │
    ├─ Express App (middleware, REST routes)
    │
    └─ WebSocket Upgrade Handler
           │
           ├─ /glasses-ws → GlassesWebSocketService.handleConnection()
           │                      │
           │                      └─ Giant switch (20+ cases)
           │
           └─ /app-ws → AppWebSocketService.handleConnection()
                              │
                              └─ Giant switch (15+ cases)
```

### Key Code Paths

**Entry point** (`packages/cloud/src/index.ts:67-70`):

```typescript
const app = express()
const server = new Server(app) // Node.js http.Server
// ...
websocketService.setupWebSocketServers(server)
```

**WebSocket setup** (`packages/cloud/src/services/websocket/websocket.service.ts:35-40`):

```typescript
this.glassesWss = new WebSocket.Server({noServer: true})
this.appWss = new WebSocket.Server({noServer: true})
```

**Message handling** (`packages/cloud/src/services/websocket/websocket-glasses.service.ts:262-680`):

```typescript
private async handleGlassesMessage(userSession: UserSession, message: GlassesToCloudMessage): Promise<void> {
  switch (message.type) {
    case GlassesToCloudMessageType.CONNECTION_INIT:
      // 50 lines of handling
    case GlassesToCloudMessageType.CORE_STATUS_UPDATE:
      // 80 lines of handling
    case GlassesToCloudMessageType.KEEP_ALIVE:
      // 20 lines
    case GlassesToCloudMessageType.TOUCH_EVENT:
      // 60 lines
    // ... 15 more cases
  }
}
```

### Problems

1. **WebSocket services own business logic they shouldn't**
   - `websocket-glasses.service.ts` handles VAD, head position, touch events, settings updates
   - Should delegate to managers that already exist

2. **No separation between routing and handling**
   - Parsing, routing, and business logic all in same method
   - Can't test message handling without WebSocket

3. **Duplicated patterns**
   - Both services have similar error handling, logging, message parsing
   - Should share infrastructure

4. **Using Node.js compatibility layer**
   - `ws` package works but isn't optimized for Bun
   - Missing native backpressure handling

## Proposed System

### Phase 1: Extract Message Routing

```
HTTP Server
    │
    └─ WebSocket Upgrade Handler (thin)
           │
           ├─ /glasses-ws → GlassesWebSocketService (lifecycle only)
           │                      │
           │                      └─ userSession.handleGlassesMessage(msg)
           │                              │
           │                              ├─ deviceManager.handleHeadPosition()
           │                              ├─ transcriptionManager.handleVad()
           │                              ├─ subscriptionManager.relayTouchEvent()
           │                              └─ etc.
           │
           └─ /app-ws → AppWebSocketService (lifecycle only)
                              │
                              └─ userSession.handleAppMessage(msg)
                                      │
                                      ├─ displayManager.handleDisplayRequest()
                                      ├─ dashboardManager.handleDashboardUpdate()
                                      └─ etc.
```

### Phase 4: Bun Native WebSocket

```
Bun.serve({
  port: 80,
  websocket: {
    open(ws) { /* connection established */ },
    message(ws, message) { /* delegate to userSession */ },
    close(ws, code, reason) { /* cleanup */ },
    drain(ws) { /* backpressure relief */ },
  },
  fetch(req, server) {
    // Handle HTTP routes OR upgrade to WebSocket
    if (url.pathname === "/glasses-ws" || url.pathname === "/app-ws") {
      server.upgrade(req, { data: { userId, path } });
      return;
    }
    // Express handles the rest
  },
})
```

## Implementation Details

### 001: Extract Message Routing

#### Step 1: Add Message Handlers to UserSession

```typescript
// packages/cloud/src/services/session/UserSession.ts

import {GlassesToCloudMessage, GlassesToCloudMessageType} from "@mentra/sdk"

class UserSession {
  /**
   * Route glasses messages to appropriate managers
   */
  async handleGlassesMessage(message: GlassesToCloudMessage): Promise<void> {
    this.logger.debug({type: message.type}, "Handling glasses message")

    switch (message.type) {
      // Device state
      case GlassesToCloudMessageType.GLASSES_CONNECTION_STATE:
        await this.deviceManager.handleGlassesConnectionState(message)
        break

      case GlassesToCloudMessageType.HEAD_POSITION:
        await this.deviceManager.handleHeadPosition(message)
        break

      // Audio/VAD
      case GlassesToCloudMessageType.VAD:
        this.audioManager.handleVad(message)
        break

      case GlassesToCloudMessageType.LOCAL_TRANSCRIPTION:
        await this.transcriptionManager.handleLocalTranscription(message)
        break

      // Settings
      case GlassesToCloudMessageType.REQUEST_SETTINGS:
        await this.userSettingsManager.handleRequestSettings(message)
        break

      case GlassesToCloudMessageType.MENTRAOS_SETTINGS_UPDATE_REQUEST:
        await this.userSettingsManager.handleSettingsUpdate(message)
        break

      // Status
      case GlassesToCloudMessageType.CORE_STATUS_UPDATE:
        await this.deviceManager.handleCoreStatusUpdate(message)
        break

      case GlassesToCloudMessageType.KEEP_ALIVE:
        this.handleKeepAlive(message)
        break

      // Touch/Gestures
      case GlassesToCloudMessageType.TOUCH_EVENT:
        await this.subscriptionManager.relayTouchEvent(message)
        break

      // Streaming responses
      case GlassesToCloudMessageType.RTMP_STREAM_STATUS:
        await this.unmanagedStreamingExtension.handleStreamStatus(message)
        break

      case GlassesToCloudMessageType.PHOTO_RESPONSE:
        await this.photoManager.handlePhotoResponse(message)
        break

      case GlassesToCloudMessageType.AUDIO_PLAY_RESPONSE:
        this.relayAudioPlayResponseToApp(message)
        break

      // Location
      case GlassesToCloudMessageType.LOCATION_UPDATE:
        await this.locationManager.handleLocationUpdate(message)
        break

      default:
        this.logger.warn({type: message.type}, "Unhandled glasses message type")
    }
  }

  /**
   * Route app messages to appropriate managers
   */
  async handleAppMessage(appWebsocket: WebSocket, packageName: string, message: AppToCloudMessage): Promise<void> {
    this.logger.debug({type: message.type, packageName}, "Handling app message")

    switch (message.type) {
      // Subscriptions
      case AppToCloudMessageType.SUBSCRIPTION_UPDATE:
        await this.subscriptionManager.handleSubscriptionUpdate(appWebsocket, packageName, message)
        break

      // Display
      case AppToCloudMessageType.DISPLAY_REQUEST:
        this.displayManager.handleDisplayRequest(message)
        break

      // Dashboard
      case AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE:
      case AppToCloudMessageType.DASHBOARD_MODE_CHANGE:
      case AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE:
        this.dashboardManager.handleAppMessage(message)
        break

      // Hardware control
      case AppToCloudMessageType.RGB_LED_CONTROL:
        await this.deviceManager.handleLedControl(appWebsocket, message)
        break

      // Streaming
      case AppToCloudMessageType.RTMP_STREAM_REQUEST:
        await this.unmanagedStreamingExtension.handleStreamRequest(appWebsocket, message)
        break

      case AppToCloudMessageType.RTMP_STREAM_STOP:
        await this.unmanagedStreamingExtension.handleStreamStop(appWebsocket, message)
        break

      case AppToCloudMessageType.MANAGED_STREAM_REQUEST:
        await this.managedStreamingExtension.handleStreamRequest(appWebsocket, message)
        break

      case AppToCloudMessageType.MANAGED_STREAM_STOP:
        await this.managedStreamingExtension.handleStreamStop(appWebsocket, message)
        break

      case AppToCloudMessageType.STREAM_STATUS_CHECK:
        await this.handleStreamStatusCheck(appWebsocket, message)
        break

      // Media
      case AppToCloudMessageType.PHOTO_REQUEST:
        await this.photoManager.handlePhotoRequest(appWebsocket, message)
        break

      case AppToCloudMessageType.AUDIO_PLAY_REQUEST:
        await this.speakerManager.handleAudioPlayRequest(appWebsocket, message)
        break

      case AppToCloudMessageType.AUDIO_STOP_REQUEST:
        await this.speakerManager.handleAudioStopRequest(appWebsocket, message)
        break

      // Location
      case AppToCloudMessageType.LOCATION_POLL_REQUEST:
        await this.locationManager.handlePollRequestFromApp(
          message.accuracy,
          message.correlationId,
          message.packageName,
        )
        break

      // Ownership
      case AppToCloudMessageType.OWNERSHIP_RELEASE:
        await this.displayManager.handleOwnershipRelease(message)
        break

      // WiFi setup
      case AppToCloudMessageType.WIFI_SETUP_REQUEST:
        await this.deviceManager.handleWifiSetupRequest(appWebsocket, message)
        break

      default:
        this.logger.warn({type: message.type}, "Unhandled app message type")
    }
  }

  private handleKeepAlive(message: any): void {
    const ack = {
      type: CloudToGlassesMessageType.KEEP_ALIVE_ACK,
      sessionId: this.sessionId,
      timestamp: new Date(),
    }
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(ack))
    }
  }
}
```

#### Step 2: Slim Down WebSocket Services

```typescript
// packages/cloud/src/services/websocket/websocket-glasses.service.ts
// AFTER refactor: ~200 lines instead of ~1250

export class GlassesWebSocketService {
  private static instance: GlassesWebSocketService

  static getInstance(): GlassesWebSocketService {
    if (!GlassesWebSocketService.instance) {
      GlassesWebSocketService.instance = new GlassesWebSocketService()
    }
    return GlassesWebSocketService.instance
  }

  async handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const userId = (request as any).userId
    const livekitRequested = (request as any).livekitRequested || false

    if (!userId) {
      this.sendError(ws, GlassesErrorCode.INVALID_TOKEN, "Authentication failed")
      return
    }

    // Get or create session
    const {userSession, reconnection} = await UserSession.createOrReconnect(ws, userId)
    userSession.livekitRequested = livekitRequested

    // Set up message handler - delegates to UserSession
    ws.on("message", async (data: WebSocket.Data, isBinary) => {
      try {
        if (isBinary) {
          userSession.audioManager.processAudioData(data)
          return
        }

        const message = JSON.parse(data.toString()) as GlassesToCloudMessage

        // CONNECTION_INIT is special - handled here for initial setup
        if (message.type === GlassesToCloudMessageType.CONNECTION_INIT) {
          await this.handleConnectionInit(userSession, reconnection, livekitRequested)
          return
        }

        // All other messages delegated to UserSession
        await userSession.handleGlassesMessage(message)
      } catch (error) {
        userSession.logger.error(error, "Error processing glasses message")
      }
    })

    // Connection lifecycle
    ws.on("close", (code, reason) => this.handleClose(userSession, code, reason))
    ws.on("error", (error) => userSession.logger.error(error, "Glasses WebSocket error"))

    // Initialize if not reconnection
    if (!reconnection) {
      await this.handleConnectionInit(userSession, reconnection, livekitRequested)
    }
  }

  private async handleConnectionInit(
    userSession: UserSession,
    reconnection: boolean,
    livekitRequested: boolean,
  ): Promise<void> {
    // ... existing init logic (already reasonably sized)
  }

  private handleClose(userSession: UserSession, code: number, reason: string): void {
    // ... existing close logic
  }

  private sendError(ws: WebSocket, code: GlassesErrorCode, message: string): void {
    // ... existing error logic
  }
}
```

#### Step 3: Move Handler Logic to Managers

For each message type currently handled inline, move to the appropriate manager:

| Message Type          | Current Location                      | New Location                                      |
| --------------------- | ------------------------------------- | ------------------------------------------------- |
| `HEAD_POSITION`       | websocket-glasses.service.ts:902-949  | DeviceManager.handleHeadPosition()                |
| `VAD`                 | websocket-glasses.service.ts:844-894  | AudioManager.handleVad() (notifies listeners)     |
| `TOUCH_EVENT`         | websocket-glasses.service.ts:565-657  | SubscriptionManager.relayTouchEvent()             |
| `CORE_STATUS_UPDATE`  | websocket-glasses.service.ts:349-500  | DeviceManager.handleCoreStatusUpdate()            |
| `REQUEST_SETTINGS`    | websocket-glasses.service.ts:990-1038 | UserSettingsManager.handleRequestSettings()       |
| `RGB_LED_CONTROL`     | websocket-app.service.ts:263-311      | DeviceManager.handleLedControl()                  |
| `RTMP_STREAM_REQUEST` | websocket-app.service.ts:327-393      | UnmanagedStreamingExtension.handleStreamRequest() |
| `PHOTO_REQUEST`       | websocket-app.service.ts:440-485      | PhotoManager.handlePhotoRequest()                 |

### 002: Bun Native WebSocket

#### New Entry Point Structure

```typescript
// packages/cloud/src/index.ts (refactored)

import {serve} from "bun"
import {expressApp} from "./express-app"
import {handleWebSocketUpgrade, websocketHandlers} from "./websocket-server"

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80

const server = serve({
  port: PORT,

  // Native Bun WebSocket handlers
  websocket: websocketHandlers,

  // HTTP request handler
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade
    if (url.pathname === "/glasses-ws" || url.pathname === "/app-ws") {
      const upgraded = handleWebSocketUpgrade(req, server, url.pathname)
      if (upgraded) return undefined
      return new Response("WebSocket upgrade failed", {status: 400})
    }

    // Express handles all other HTTP
    return expressApp.fetch(req)
  },
})

logger.info(`MentraOS Cloud Server running on port ${PORT}`)
```

#### WebSocket Handlers

```typescript
// packages/cloud/src/websocket-server.ts

import type {ServerWebSocket} from "bun"
import jwt from "jsonwebtoken"

interface WebSocketData {
  userId: string
  path: "/glasses-ws" | "/app-ws"
  userSession?: UserSession
  packageName?: string // For app connections
}

export function handleWebSocketUpgrade(req: Request, server: any, path: string): boolean {
  const url = new URL(req.url)

  // Extract and verify JWT
  const token = req.headers.get("authorization")?.split(" ")[1] || url.searchParams.get("token")

  if (!token) {
    return false
  }

  try {
    const payload = jwt.verify(token, process.env.AUGMENTOS_AUTH_JWT_SECRET!) as any
    const userId = payload.email

    if (!userId) {
      return false
    }

    // Upgrade with attached data
    return server.upgrade(req, {
      data: {
        userId,
        path,
        livekitRequested: url.searchParams.get("livekit") === "true",
      } as WebSocketData,
    })
  } catch {
    return false
  }
}

export const websocketHandlers = {
  open(ws: ServerWebSocket<WebSocketData>) {
    const {userId, path} = ws.data

    if (path === "/glasses-ws") {
      handleGlassesOpen(ws)
    } else if (path === "/app-ws") {
      handleAppOpen(ws)
    }
  },

  message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
    const {path, userSession} = ws.data
    if (!userSession) return

    if (path === "/glasses-ws") {
      if (message instanceof Buffer) {
        userSession.audioManager.processAudioData(message)
      } else {
        const parsed = JSON.parse(message)
        userSession.handleGlassesMessage(parsed)
      }
    } else if (path === "/app-ws") {
      const parsed = JSON.parse(message as string)
      userSession.handleAppMessage(ws as any, ws.data.packageName!, parsed)
    }
  },

  close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
    const {path, userSession} = ws.data
    if (!userSession) return

    if (path === "/glasses-ws") {
      handleGlassesClose(userSession, code, reason)
    } else if (path === "/app-ws") {
      handleAppClose(userSession, ws.data.packageName!, code, reason)
    }
  },

  drain(ws: ServerWebSocket<WebSocketData>) {
    // Backpressure relieved - can resume sending
    logger.debug({userId: ws.data.userId}, "WebSocket drain - backpressure relieved")
  },
}

async function handleGlassesOpen(ws: ServerWebSocket<WebSocketData>) {
  const {userId, livekitRequested} = ws.data as any
  const {userSession, reconnection} = await UserSession.createOrReconnect(ws as any, userId)
  ws.data.userSession = userSession
  userSession.livekitRequested = livekitRequested

  if (!reconnection) {
    // Send connection ack, etc.
  }
}

async function handleAppOpen(ws: ServerWebSocket<WebSocketData>) {
  // App init handled via first message (CONNECTION_INIT)
}

function handleGlassesClose(userSession: UserSession, code: number, reason: string) {
  // Existing grace period logic
}

function handleAppClose(userSession: UserSession, packageName: string, code: number, reason: string) {
  // Existing app disconnect logic
}
```

### 003: Config Extraction

```typescript
// packages/cloud/src/config/index.ts

export interface CloudConfig {
  server: {
    port: number
    corsOrigins: string[]
  }
  websocket: {
    glassesHeartbeatIntervalMs: number
    pongTimeoutMs: number
    pongTimeoutEnabled: boolean
  }
  session: {
    gracePeriodMs: number
    gracePeriodCleanupEnabled: boolean
  }
  app: {
    sessionTimeoutMs: number
    gracePeriodMs: number
    subscriptionGraceMs: number
  }
}

// Load from environment with defaults
export const config: CloudConfig = {
  server: {
    port: parseInt(process.env.PORT || "80"),
    corsOrigins: process.env.CORS_ORIGINS?.split(",") || ["*"],
  },
  websocket: {
    glassesHeartbeatIntervalMs: parseInt(process.env.GLASSES_HEARTBEAT_MS || "10000"),
    pongTimeoutMs: parseInt(process.env.PONG_TIMEOUT_MS || "30000"),
    pongTimeoutEnabled: process.env.PONG_TIMEOUT_ENABLED !== "false",
  },
  session: {
    gracePeriodMs: parseInt(process.env.SESSION_GRACE_PERIOD_MS || "60000"),
    gracePeriodCleanupEnabled: process.env.SESSION_GRACE_CLEANUP_ENABLED !== "false",
  },
  app: {
    sessionTimeoutMs: parseInt(process.env.APP_SESSION_TIMEOUT_MS || "5000"),
    gracePeriodMs: parseInt(process.env.APP_GRACE_PERIOD_MS || "5000"),
    subscriptionGraceMs: parseInt(process.env.APP_SUBSCRIPTION_GRACE_MS || "8000"),
  },
}
```

### 004: Metrics & Observability

```typescript
// packages/cloud/src/services/metrics/MetricsService.ts

export interface ConnectionMetrics {
  glassesConnections: number
  appConnections: number
  totalSessions: number
}

export interface MessageMetrics {
  glassesMessagesReceived: Map<string, number> // type -> count
  appMessagesReceived: Map<string, number>
  messagesProcessed: number
  messageErrors: number
}

class MetricsService {
  private connectionMetrics: ConnectionMetrics = {
    glassesConnections: 0,
    appConnections: 0,
    totalSessions: 0,
  }

  private messageMetrics: MessageMetrics = {
    glassesMessagesReceived: new Map(),
    appMessagesReceived: new Map(),
    messagesProcessed: 0,
    messageErrors: 0,
  }

  // Connection tracking
  onGlassesConnect() {
    this.connectionMetrics.glassesConnections++
    this.connectionMetrics.totalSessions = UserSession.getAllSessions().length
  }

  onGlassesDisconnect() {
    this.connectionMetrics.glassesConnections--
    this.connectionMetrics.totalSessions = UserSession.getAllSessions().length
  }

  onAppConnect() {
    this.connectionMetrics.appConnections++
  }

  onAppDisconnect() {
    this.connectionMetrics.appConnections--
  }

  // Message tracking
  onGlassesMessage(type: string) {
    const count = this.messageMetrics.glassesMessagesReceived.get(type) || 0
    this.messageMetrics.glassesMessagesReceived.set(type, count + 1)
    this.messageMetrics.messagesProcessed++
  }

  onAppMessage(type: string) {
    const count = this.messageMetrics.appMessagesReceived.get(type) || 0
    this.messageMetrics.appMessagesReceived.set(type, count + 1)
    this.messageMetrics.messagesProcessed++
  }

  onMessageError() {
    this.messageMetrics.messageErrors++
  }

  // Expose for /health endpoint
  getMetrics() {
    return {
      connections: {...this.connectionMetrics},
      messages: {
        glassesTypes: Object.fromEntries(this.messageMetrics.glassesMessagesReceived),
        appTypes: Object.fromEntries(this.messageMetrics.appMessagesReceived),
        processed: this.messageMetrics.messagesProcessed,
        errors: this.messageMetrics.messageErrors,
      },
    }
  }
}

export const metricsService = new MetricsService()
```

#### Correlation IDs

```typescript
// Add to message handling

interface MessageContext {
  correlationId: string;
  userId: string;
  messageType: string;
  receivedAt: Date;
}

function createMessageContext(userId: string, messageType: string): MessageContext {
  return {
    correlationId: `${userId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    userId,
    messageType,
    receivedAt: new Date(),
  };
}

// In UserSession.handleGlassesMessage()
async handleGlassesMessage(message: GlassesToCloudMessage): Promise<void> {
  const ctx = createMessageContext(this.userId, message.type);
  this.logger.debug({ correlationId: ctx.correlationId, type: message.type }, "Handling glasses message");

  metricsService.onGlassesMessage(message.type);

  try {
    switch (message.type) {
      // ... handlers receive ctx for logging
    }
  } catch (error) {
    metricsService.onMessageError();
    this.logger.error({ correlationId: ctx.correlationId, error }, "Error handling message");
    throw error;
  }
}
```

## Migration Strategy

### Phase 1: Extract Message Routing (Safe, No Runtime Changes)

1. Add `handleGlassesMessage()` and `handleAppMessage()` to UserSession
2. Move handler methods to managers (copy-paste, then call from UserSession)
3. Update WebSocket services to delegate instead of handle inline
4. Test thoroughly in staging
5. Deploy with feature flag (old path vs new path)
6. Remove old inline handlers once stable

### Phase 2: Config Extraction (Safe)

1. Create config module
2. Replace hardcoded values one file at a time
3. Add environment variable documentation
4. Deploy (no behavior change)

### Phase 3: Metrics (Safe, Additive)

1. Add MetricsService
2. Instrument connection lifecycle
3. Instrument message handling
4. Update /health endpoint
5. Add Better Stack dashboard for new metrics

### Phase 4: Bun Native WebSocket (More Invasive)

1. Create parallel implementation (`websocket-server.ts`)
2. Add feature flag to route between old/new
3. Test extensively in staging
4. Gradual rollout by percentage
5. Remove old implementation once 100%

## File Changes Summary

| File                           | Change                                                   | Lines |
| ------------------------------ | -------------------------------------------------------- | ----- |
| `UserSession.ts`               | Add handleGlassesMessage(), handleAppMessage()           | +200  |
| `websocket-glasses.service.ts` | Remove inline handlers, delegate to UserSession          | -950  |
| `websocket-app.service.ts`     | Remove inline handlers, delegate to UserSession          | -750  |
| `DeviceManager.ts`             | Add handleHeadPosition(), handleCoreStatusUpdate(), etc. | +150  |
| `TranscriptionManager.ts`      | Add handleVad(), handleLocalTranscription()              | +50   |
| `UserSettingsManager.ts`       | Add handleRequestSettings(), handleSettingsUpdate()      | +50   |
| `config/index.ts`              | New file                                                 | +50   |
| `MetricsService.ts`            | New file                                                 | +100  |
| `websocket-server.ts`          | New file (Bun native)                                    | +150  |
| `index.ts`                     | Simplify, use config                                     | -30   |

**Net: ~1500 lines removed, code distributed to appropriate modules**

## Related Issues

- **010-audio-manager-consolidation** - VAD moves to AudioManager here, full consolidation with MicrophoneManager is separate (requires mobile client changes)

## Open Questions

1. **Express + Bun native WS compatibility?**
   - Can we run Express for HTTP AND Bun native WS in same process?
   - Need to verify `expressApp.fetch()` works with Bun's fetch interface
   - Fallback: Keep current setup, just extract message routing

2. **TypeScript exhaustiveness with handler registry?**
   - Switch gives exhaustiveness checking
   - Registry pattern needs explicit type safety
   - Could use both: registry for extensibility, compile-time check for completeness

3. **Manager method signatures?**
   - Should handlers receive `WebSocket` for responses?
   - Or return response and let UserSession send?
   - Leaning: Pass WebSocket, keeps handlers self-contained

4. **Backward compatibility for CONNECTION_INIT?**
   - Old apps send CONNECTION_INIT as first message
   - New SDK sends JWT in headers
   - Need to support both during transition
