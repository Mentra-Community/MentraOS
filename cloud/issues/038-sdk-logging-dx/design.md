# Design Doc: SDK Logging & Error DX Implementation

> Implementation guide for [spec.md](./spec.md). Read the spec first.

---

## Architecture

### Before

```
AppServer constructor
  └─ rootLogger = pino(opts, multistream([pino-pretty, betterstack?]))
       ├─ .child({ app, packageName, service }) → AppServer.logger
       │    └─ .child({ userId, service }) → AppSession.logger
       │         ├─ .child({ module: "camera" }) → CameraModule.logger
       │         ├─ .child({ module: "audio" }) → AudioManager.logger
       │         └─ .child({ module: "led" }) → LedModule.logger
       └─ settings.ts imports rootLogger directly (not via DI)

All output → pino-pretty → dev terminal (always, at debug/info level)
           → @logtail/pino → BetterStack (if BETTERSTACK_SOURCE_TOKEN set)
```

### After

```
AppServer constructor(config: AppServerConfig)
  └─ createLogger(config) → rootLogger = pino(opts, multistream([cleanTransport|prettyTransport, betterstack?]))
       ├─ .child({ app, packageName, service }) → AppServer.logger
       │    └─ .child({ userId, service }) → AppSession.logger
       │         ├─ .child({ module: "camera" }) → CameraModule.logger
       │         ├─ .child({ module: "audio" }) → AudioManager.logger
       │         ├─ .child({ module: "led" }) → LedModule.logger
       │         └─ passed to EventManager, SettingsManager
       └─ (no more direct imports of rootLogger anywhere)

Console output → cleanTransport (default) → single-line colored → process.stderr
               OR prettyTransport (verbose) → pino-pretty → process.stdout
BetterStack    → @logtail/pino → always at debug level (unaffected)
```

Key change: the logger is no longer a module-level singleton. It's created per-AppServer with config-driven behavior. A thin default export remains in `logger.ts` for backward compat during migration, but all production paths go through `createLogger()`.

---

## File-by-File Implementation

### 1. `src/logging/errors.ts` (NEW)

Error class hierarchy. All extend `Error` for backward compat.

```typescript
export class MentraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "MentraError"
    // Fix prototype chain for instanceof checks in transpiled code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class MentraAuthError extends MentraError {
  constructor(message: string) {
    super(message, "AUTH_ERROR")
    this.name = "MentraAuthError"
  }
}

export class MentraConnectionError extends MentraError {
  constructor(message: string, code: string = "CONNECTION_ERROR") {
    super(message, code)
    this.name = "MentraConnectionError"
  }
}

export class MentraTimeoutError extends MentraError {
  constructor(message: string) {
    super(message, "TIMEOUT_ERROR")
    this.name = "MentraTimeoutError"
  }
}

export class MentraValidationError extends MentraError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR")
    this.name = "MentraValidationError"
  }
}

export class MentraPermissionError extends MentraError {
  constructor(
    message: string,
    public readonly stream: string,
    public readonly requiredPermission: string,
  ) {
    super(message, "PERMISSION_ERROR")
    this.name = "MentraPermissionError"
  }
}
```

Note the `Object.setPrototypeOf` call — this is required because TypeScript/Bun transpilation can break `instanceof` for subclassed builtins. Without it, `error instanceof MentraAuthError` could return `false` in some environments.

### 2. `src/logging/clean-transport.ts` (NEW)

A custom pino transport that formats single-line colored output.

Pino transports are Node.js writable streams that receive newline-delimited JSON. We use `pino.transport({ target: './clean-transport.ts' })` OR build it inline as a Transform stream.

Given that we're bundling with Bun and want to avoid the worker-thread overhead of `pino.transport()`, the simpler approach is to create a writable stream directly:

```typescript
import {Writable} from "stream"
import chalk from "chalk"

// Pino level numbers → our symbols
const LEVEL_MAP: Record<number, {symbol: string; color: (s: string) => string}> = {
  10: {symbol: "·", color: chalk.dim}, // trace
  20: {symbol: "·", color: chalk.dim}, // debug
  30: {symbol: "✓", color: chalk.green}, // info
  40: {symbol: "⚠", color: chalk.yellow}, // warn
  50: {symbol: "✗", color: chalk.red}, // error
  60: {symbol: "✗", color: chalk.red}, // fatal
}

const PREFIX = chalk.dim("MentraOS")

export function createCleanStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      try {
        const line = chunk.toString().trim()
        if (!line) {
          callback()
          return
        }

        const obj = JSON.parse(line)
        const level = obj.level ?? 30
        const msg = obj.msg ?? ""

        if (!msg) {
          callback()
          return
        }

        const entry = LEVEL_MAP[level] ?? LEVEL_MAP[30]
        const symbol = entry.color(entry.symbol)
        const formatted = `${PREFIX}  ${symbol} ${msg}\n`

        process.stderr.write(formatted)
      } catch {
        // If JSON parse fails, write raw line (shouldn't happen with pino)
        process.stderr.write(chunk)
      }
      callback()
    },
  })
}
```

Why `process.stderr`? Convention for log output — keeps `stdout` clean for program output (e.g., if someone pipes an app's stdout). Pino-pretty also writes to stdout by default, but stderr is more correct. This is a minor detail — can be changed if there's a preference.

### 3. `src/logging/logger.ts` (MODIFIED)

Refactor from a module-level singleton to a factory function. Keep a default export for backward compat.

```typescript
import pino, {Logger} from "pino"
import {createCleanStream} from "./clean-transport"

export interface LoggerConfig {
  logLevel?: "none" | "error" | "warn" | "info" | "debug"
  verbose?: boolean
}

// Resolve effective config from env vars + passed config
function resolveConfig(config?: LoggerConfig): {level: string; verbose: boolean} {
  const envVerbose = process.env.MENTRA_VERBOSE === "true" || process.env.MENTRA_VERBOSE === "1"
  const envLevel = process.env.MENTRA_LOG_LEVEL as string | undefined

  // MENTRA_VERBOSE takes highest precedence
  if (envVerbose) {
    return {level: "debug", verbose: true}
  }

  // MENTRA_LOG_LEVEL overrides config
  if (envLevel && ["none", "error", "warn", "info", "debug"].includes(envLevel)) {
    return {level: envLevel === "none" ? "silent" : envLevel, verbose: envLevel === "debug"}
  }

  // Config verbose
  if (config?.verbose) {
    return {level: "debug", verbose: true}
  }

  // Config logLevel
  if (config?.logLevel) {
    const level = config.logLevel === "none" ? "silent" : config.logLevel
    return {level, verbose: config.logLevel === "debug"}
  }

  // Default: warn level, clean mode
  return {level: "warn", verbose: false}
}

export function createLogger(config?: LoggerConfig): Logger {
  const {level, verbose} = resolveConfig(config)

  const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN
  const BETTERSTACK_ENDPOINT = process.env.BETTERSTACK_ENDPOINT || "https://s1311181.eu-nbg-2.betterstackdata.com"
  const NODE_ENV = process.env.NODE_ENV || "development"
  const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local"

  const streams: pino.StreamEntry[] = []

  // Console transport: clean or verbose
  if (level !== "silent") {
    if (verbose) {
      // Verbose mode: try pino-pretty, fall back to JSON stdout
      try {
        const prettyTransport = pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname,env,module,server",
            messageFormat: "{msg}",
            errorProps: "*",
          },
        })
        streams.push({stream: prettyTransport, level})
      } catch {
        // pino-pretty not installed — fall back to stdout JSON
        streams.push({stream: process.stdout, level})
      }
    } else {
      // Clean mode: our custom single-line formatter
      streams.push({stream: createCleanStream(), level})
    }
  }

  // BetterStack transport: always at debug level if token is present
  // This runs regardless of console level/mode — it's for Mentra's internal observability
  if (BETTERSTACK_SOURCE_TOKEN) {
    try {
      const betterStackTransport = pino.transport({
        target: "@logtail/pino",
        options: {
          sourceToken: BETTERSTACK_SOURCE_TOKEN,
          options: {endpoint: BETTERSTACK_ENDPOINT},
        },
      })
      streams.push({stream: betterStackTransport, level: "debug"})
    } catch (error) {
      // Silently skip — don't pollute dev terminal with BetterStack setup errors
    }
  }

  // If no streams (level=silent and no BetterStack), add a no-op to prevent pino from defaulting to stdout
  if (streams.length === 0) {
    streams.push({
      stream: new (require("stream").Writable)({
        write(_chunk: any, _enc: any, cb: () => void) {
          cb()
        },
      }),
      level: "silent",
    })
  }

  const multistream = pino.multistream(streams)

  return pino(
    {
      level: "debug", // Set to lowest — individual streams control their own levels
      base: {
        env: NODE_ENV,
        server: PORTER_APP_NAME,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    multistream,
  )
}

// Default logger instance (backward compat — used by settings.ts until it's migrated)
// This uses the old behavior: NODE_ENV-based level, pino-pretty always on
// After migration, this can be removed.
export const logger = createLogger({
  logLevel: (process.env.NODE_ENV === "production" ? "info" : "debug") as any,
  verbose: true, // Preserve current behavior for anything still using the default import
})

export default logger
```

Important: the pino instance's own `level` is set to `'debug'` (the lowest). Each stream in the multistream controls its own minimum level. This allows BetterStack to receive debug-level logs even when the console transport is at warn level.

### 4. `src/app/server/index.ts` (MODIFIED)

#### 4a. AppServerConfig additions

Add to the interface (after `appInstructions`):

```typescript
export interface AppServerConfig {
  // ... all existing fields unchanged ...

  /**
   * SDK console log level. Default: 'warn'.
   * - 'none':  Suppress all SDK console output
   * - 'error': Only errors
   * - 'warn':  Errors + warnings (default)
   * - 'info':  Errors + warnings + lifecycle events
   * - 'debug': Everything (verbose structured output)
   *
   * Can be overridden with MENTRA_LOG_LEVEL env var.
   */
  logLevel?: "none" | "error" | "warn" | "info" | "debug"

  /**
   * Enable verbose internal logging (full structured output).
   * Useful when debugging SDK issues — Mentra support may ask you to enable this.
   * Can also be enabled with MENTRA_VERBOSE=true env var.
   * Default: false
   */
  verbose?: boolean
}
```

#### 4b. Constructor changes

```typescript
// Before:
import {logger as rootLogger} from "../../logging/logger"
// ...
this.logger = rootLogger.child({
  app: this.config.packageName,
  packageName: this.config.packageName,
  service: "app-server",
})

// After:
import {createLogger} from "../../logging/logger"
// ...
const rootLogger = createLogger({
  logLevel: this.config.logLevel,
  verbose: this.config.verbose,
})
this.logger = rootLogger.child({
  app: this.config.packageName,
  packageName: this.config.packageName,
  service: "app-server",
})
```

#### 4c. Remove internal cleanupError handler

In `handleSessionRequest()`, remove:

```typescript
// REMOVE THIS:
const cleanupError = session.events.onError((error) => {
  this.logger.error(error, `❌ [Session ${sessionId}] Error:`)
})
```

And the corresponding `cleanupError()` call in the catch block.

The EventManager's fallback logging (see section 5) replaces this.

#### 4d. Simplify start() version check

Replace the boxen ASCII banner call with a single-line log:

```typescript
// Before:
if (latest && latest !== currentVersion) {
  this.logger.warn(newSDKUpdate(latest))
}

// After:
if (latest && latest !== currentVersion) {
  this.logger.warn(`SDK update available: ${currentVersion} → ${latest} — bun install @mentra/sdk@latest`)
}
```

This lets us remove the import of `newSDKUpdate` and eventually drop the `boxen` dependency.

### 5. `src/app/session/events.ts` (MODIFIED)

#### 5a. Accept logger in constructor

```typescript
import { Logger } from 'pino';

export class EventManager {
  private emitter: EventEmitter;
  private handlers: Map<EventType, Set<Handler<unknown>>>;
  private logger: Logger;
  // ... other fields ...

  constructor(
    private subscribe: (type: ExtendedStreamType) => void,
    private unsubscribe: (type: ExtendedStreamType) => void,
    private packageName: string,
    private baseUrl: string,
    logger: Logger,  // NEW parameter
  ) {
    this.emitter = new EventEmitter();
    this.handlers = new Map();
    this.logger = logger;
    // ...
  }
```

The `AppSession` constructor already has a logger. Update the `new EventManager(...)` call to pass it:

```typescript
// In AppSession constructor:
this.events = new EventManager(
  this.subscribe.bind(this),
  this.unsubscribe.bind(this),
  this.config.packageName,
  this.getHttpsServerUrl() || "",
  this.logger, // NEW — pass the session logger
)
```

#### 5b. Replace console.error with logger

```typescript
// Before (line 455):
console.error(`Error in handler for event '${String(event)}':`, handlerError)

// After:
this.logger.debug({event: String(event), error: handlerError}, `Error in handler for event '${String(event)}'`)
```

Same for line 469:

```typescript
// Before:
console.error(`Fatal error emitting event '${String(event)}':`, emitError)

// After:
this.logger.debug({event: String(event), error: emitError}, `Fatal error emitting event '${String(event)}'`)
```

#### 5c. Fallback logging for unhandled errors

In the `emit()` method, add fallback logging when emitting an `"error"` event with no registered handlers:

```typescript
emit<T extends EventType>(event: T, data: EventData<T>): void {
  try {
    this.emitter.emit(event, data);

    const handlers = this.handlers.get(event);

    if (handlers) {
      // ... existing handler iteration with isolated try/catch ...
    }

    // Fallback: if this is an error event and nobody is listening, log it
    // This prevents errors from being silently swallowed when dev has no onError handler
    if (event === 'error' && this.emitter.listenerCount('error') === 0 && (!handlers || handlers.size === 0)) {
      const error = data as Error;
      this.logger.error(error?.message ?? String(data));
    }
  } catch (emitError: unknown) {
    // ... existing catch, but use this.logger instead of console.error ...
  }
}
```

### 6. `src/app/session/index.ts` (MODIFIED)

This is the largest change file — many individual edits. Organized by theme.

#### 6a. Error class imports

```typescript
import {
  MentraAuthError,
  MentraConnectionError,
  MentraTimeoutError,
  MentraValidationError,
  MentraError,
} from "../../logging/errors"
```

#### 6b. Constructor — reduce log verbosity

```typescript
// REMOVE these debug lines (lines 269-270):
this.logger.debug(`🚀 [${this.config.packageName}] App Session initialized`)
this.logger.debug(`🚀 [${this.config.packageName}] WebSocket URL: ${this.config.mentraOSWebsocketUrl}`)

// The URL validation block (lines 253-290) has duplicate try/catch blocks.
// Consolidate into one and log at debug level:
if (this.config.mentraOSWebsocketUrl) {
  try {
    const url = new URL(this.config.mentraOSWebsocketUrl)
    if (!["ws:", "wss:"].includes(url.protocol)) {
      const fixedUrl = this.config.mentraOSWebsocketUrl.replace(/^ws:\/\/http:\/\//, "ws://")
      this.config.mentraOSWebsocketUrl = fixedUrl
      this.logger.debug(`Fixed malformed WebSocket URL: ${fixedUrl}`)
    }
  } catch {
    this.logger.error(`Invalid WebSocket URL: ${this.config.mentraOSWebsocketUrl}`)
  }
}
```

#### 6c. connect() — error dedup

**WebSocket URL missing (line 649-653):**

```typescript
// Before:
this.logger.error("WebSocket URL is missing or undefined")
reject(new Error("WebSocket URL is required"))

// After:
reject(new MentraValidationError("WebSocket URL is required"))
// No log — the rejection is the output path.
```

**Connection attempt log (line 654-658):**

```typescript
// Before:
this.logger.info(
  `🔌🔌🔌 [${this.config.packageName}] Attempting to connect to: ${this.config.mentraOSWebsocketUrl} for session ${this.sessionId}`,
)

// After:
this.logger.debug(`Connecting to ${this.config.mentraOSWebsocketUrl}`)
// Connection success is logged at info level in the ACK handler.
```

**Connection init error (line 674-679):**

```typescript
// Before:
this.logger.error(error, "Error during connection initialization")
const errorMessage = error instanceof Error ? error.message : String(error)
this.events.emit("error", new Error(`Connection initialization failed: ${errorMessage}`))
reject(error)

// After — reject only, no log, no emit:
reject(error instanceof Error ? error : new MentraConnectionError(String(error)))
```

**WebSocket error handler (lines 844-866) — the triple-logger:**

```typescript
// Before: Two separate handlers, one logs 2-3x and one emits
const errorHandler = (error: Error) => {
  this.logger.error(error, "WebSocket error")
  this.events.emit("error", error)
}

this.ws.on("error", (error: Error) => {
  this.logger.error(error, `⛔️⛔️⛔️ [${this.config.packageName}] WebSocket connection error: ${error.message}`)
  if (errMsg.includes("ECONNREFUSED")) {
    this.logger.error(`⛔️⛔️⛔️ [${this.config.packageName}] Connection refused - Check if the server is running`)
  }
  // ... etc
  errorHandler(error)
})

// After — single handler, emit only, contextual message:
this.ws.on("error", (error: Error) => {
  const msg = error.message || ""
  let userMessage: string

  if (msg.includes("ECONNREFUSED")) {
    userMessage = "Connection refused — is MentraOS Cloud running?"
  } else if (msg.includes("ETIMEDOUT")) {
    userMessage = "Connection timed out — check network connectivity"
  } else {
    userMessage = error.message
  }

  this.events.emit("error", new MentraConnectionError(userMessage))
})
// No logger.error — the error event is the output path.
// EventManager's fallback handles logging if no onError handler exists.
```

**Connection timeout (lines 886-899):**

```typescript
// Before:
this.logger.error(
  {config, sessionId, timeoutMs},
  `⏱️⏱️⏱️ [${this.config.packageName}] Connection timeout after ${timeoutMs}ms`,
)
this.events.emit("error", new Error(`Connection timeout after ${timeoutMs}ms`))
reject(new Error("Connection timeout"))

// After:
const err = new MentraTimeoutError(`Connection timeout after ${timeoutMs}ms`)
reject(err)
// No log, no emit — rejection is the output path.
```

#### 6d. handleMessage() — error class usage

**Connection error (around line 1323):**

```typescript
// Before:
const errorMessage = message.message || "Unknown connection error"
this.events.emit("error", new Error(errorMessage))

// After:
const errorMessage = message.message || "Unknown connection error"
if (errorMessage.toLowerCase().includes("invalid api key") || errorMessage.toLowerCase().includes("auth")) {
  this.events.emit("error", new MentraAuthError(errorMessage))
} else {
  this.events.emit("error", new MentraConnectionError(errorMessage))
}
```

**CONNECTION_ACK logging (lines 1280-1311):**

```typescript
// Before: ~8 lines of info/debug about mentraosSettings and patch version

// After:
this.logger.debug({mentraosSettings: message.mentraosSettings}, `CONNECTION_ACK received`)
// The patch version log is internal debug — move to debug:
this.logger.debug(`Subscriptions derived from ${handlerCount} handler(s)`)
// The info-level "Connected" message is emitted once from AppServer when the
// connect() promise resolves, not here.
```

**Unrecognized message type (line 1568-1571):**

```typescript
// Before:
this.logger.warn(`Unrecognized message type: ${(message as any).type}`)
this.events.emit("error", new Error(`Unrecognized message type: ${(message as any).type}`))

// After — warn only, not an error:
this.logger.warn(`Unrecognized message type: ${(message as any).type}`)
// Don't emit to error — an unknown message type is unexpected but not an error the dev can act on.
```

#### 6e. handleReconnection() — clean output

```typescript
// Reconnecting (line 1797-1801):
// Before:
this.logger.debug(
  `🔄 [${this.config.packageName}] Reconnection attempt ${this.reconnectAttempts}/${maxAttempts} in ${delay}ms`,
)

// After:
this.logger.warn(`Connection lost, reconnecting (${this.reconnectAttempts}/${maxAttempts})...`)

// Reconnection success (line 1810):
// Before:
this.logger.debug(`✅ [${this.config.packageName}] Reconnection successful!`)

// After:
this.logger.info(`Reconnected — user ${this.userId}`)

// Reconnection failed (line 1814):
// Before:
this.logger.error(error, `❌ [${this.config.packageName}] Reconnection failed for user ${this.userId}`)
this.events.emit("error", new Error(`Reconnection failed: ${errorMessage}`))

// After — only emit:
this.events.emit("error", new MentraConnectionError(`Reconnection failed: ${errorMessage}`))

// Max attempts exhausted (line 1779):
// Before:
this.logger.info(`🔄 Maximum reconnection attempts (${maxAttempts}) reached, giving up`)

// After:
this.logger.error(`Connection lost after ${maxAttempts} attempts`)
```

#### 6f. send() — simplify error path

```typescript
// Before (lines 1896-1903): logs error + emits + throws

// After:
} catch (error: unknown) {
  const isDisconnectError = error instanceof Error && (
    error.message.includes("WebSocket not connected") ||
    error.message.includes("CLOSED") ||
    error.message.includes("CLOSING")
  );

  if (!isDisconnectError) {
    this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
  }
  // Disconnect errors: no log, no emit — expected during session teardown.

  throw error; // Still throw for callers that await send results.
}
```

### 7. `src/app/session/settings.ts` (MODIFIED)

```typescript
// Before (line 10):
import { logger } from "../../logging/logger";

// After: Accept logger via constructor parameter
export class SettingsManager {
  private logger: Logger;

  constructor(
    initialSettings: AppSettings,
    packageName: string,
    serverUrl: string | undefined,
    sessionId: string | undefined,
    subscribeFn: (streams: string[]) => void,
    logger: Logger,  // NEW parameter
  ) {
    this.logger = logger;
    // ... rest of constructor
  }
```

Update the `new SettingsManager(...)` call in `AppSession` constructor to pass `this.logger`.

### 8. Module log level adjustments

These are straightforward level changes across the four module files. The pattern:

**General rule:**

- Request sent / response received → `debug` (not `info`)
- Module lifecycle events (cleanup) → `debug` (not `info`)
- User-actionable events (stream started, photo captured) → `info`
- Timeout / unexpected state → `warn`
- Unrecoverable errors → `error`

**`audio.ts` examples:**

```typescript
// "Audio playback started in non-blocking mode" → debug (was debug, stays)
// "Audio play request timed out" → warn (was warn, stays)
// "Audio stop request sent" → debug (was info)
// "Generating speech from text" → debug (was info)
// "Received audio play response" → debug (was info)
// "Cancelled all pending audio requests" → debug (was info)
```

**`camera.ts` examples:**

```typescript
// "Photo request sent" → debug (was info)
// "RTMP stream request starting" → info (stays — user-initiated action)
// "RTMP stream request sent successfully" → debug (was info)
// "Stream stopped - updating local state" → debug (was info)
// "Received invalid stream status message" → warn (stays)
```

**`camera-managed-extension.ts` examples:**

```typescript
// "Managed stream request starting" → info (stays — user-initiated)
// "Received managed stream status" → debug (was info)
// "Managed streaming extension cleaned up" → debug (was info)
```

**`led.ts` examples:**

```typescript
// "LED turn on/off request sent" → debug (was info)
// "LED module cleaned up" → debug (was info)
```

### 9. `src/constants/log-messages/updates.ts` (MODIFIED)

Replace the entire `createUpdateNotification` function:

```typescript
// Remove imports of chalk, boxen, mentraLogo_1, newUpdateText

export const newSDKUpdate = (currentVersion: string, latestVersion: string): string => {
  return `SDK update available: ${currentVersion} → ${latestVersion} — bun install @mentra/sdk@latest`
}
```

The caller (AppServer.start()) passes this string to `this.logger.warn(...)`, and the clean transport handles the color/prefix formatting.

### 10. `src/constants/log-messages/warning.ts` (MODIFIED)

Replace all boxen banner functions with plain string formatters:

```typescript
// Remove imports of chalk, boxen, warnLog

const createPermissionWarning = (permissionName: string, funcName?: string, packageName?: string): string => {
  const func = funcName ? `${funcName} requires` : "This function requires"
  const url = packageName ? ` — enable at https://console.mentra.glass/apps/${packageName}/edit` : ""
  return `${func} ${permissionName} permission${url}`
}

export const noMicrophoneWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("microphone", funcName, packageName)

export const locationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("location", funcName, packageName)

export const baackgroundLocationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("background location", funcName, packageName)

export const calendarWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("calendar", funcName, packageName)

export const readNotficationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("read notification", funcName, packageName)

export const postNotficationWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("post notification", funcName, packageName)

export const cameraWarn = (funcName?: string, packageName?: string): string =>
  createPermissionWarning("camera", funcName, packageName)
```

### 11. `src/utils/permissions-utils.ts` (MODIFIED)

The permission util functions currently use `console.log` to print boxen banners. They need to:

1. Accept a logger parameter (or use a module-level logger reference).
2. Use `logger.warn(...)` instead of `console.log(...)`.
3. Replace all 7 duplicated fetch-and-check functions with a single generic one.

```typescript
import {Logger} from "pino"
import {
  noMicrophoneWarn,
  locationWarn,
  // ... all warn message functions
} from "../constants/log-messages/warning"
import {PackagePermissions, Permission} from "../types/messages/cloud-to-app"

// Generic permission checker — replaces 7 copy-pasted functions
function checkPermission(
  cloudServerUrl: string,
  packageName: string,
  permissionType: string,
  warnMessageFn: (funcName?: string, packageName?: string) => string,
  logger: Logger,
  funcName?: string,
): void {
  if (!cloudServerUrl) return

  const permissionsUrl = `${cloudServerUrl}/api/public/permissions/${encodeURIComponent(packageName)}`

  fetch(permissionsUrl)
    .then(async (res) => {
      if (!res.ok) return null
      const contentType = res.headers.get("content-type")
      if (contentType && contentType.includes("application/json")) {
        return (await res.json()) as PackagePermissions
      }
      return null
    })
    .then((data: PackagePermissions | null) => {
      if (data) {
        const hasPermission = data.permissions.some((p: Permission) => p.type === permissionType)
        if (!hasPermission) {
          logger.warn(warnMessageFn(funcName, packageName))
        }
      }
    })
    .catch(() => {
      // Silently fail if endpoint is unreachable — don't block execution
    })
}

// Public API — each function takes a logger now
export const microPhoneWarnLog = (cloudServerUrl: string, packageName: string, funcName?: string, logger?: Logger) => {
  if (logger) checkPermission(cloudServerUrl, packageName, "MICROPHONE", noMicrophoneWarn, logger, funcName)
}

export const locationWarnLog = (cloudServerUrl: string, packageName: string, funcName?: string, logger?: Logger) => {
  if (logger) checkPermission(cloudServerUrl, packageName, "LOCATION", locationWarn, logger, funcName)
}

export const backgroundLocationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
) => {
  if (logger)
    checkPermission(cloudServerUrl, packageName, "BACKGROUND_LOCATION", baackgroundLocationWarn, logger, funcName)
}

export const calendarWarnLog = (cloudServerUrl: string, packageName: string, funcName?: string, logger?: Logger) => {
  if (logger) checkPermission(cloudServerUrl, packageName, "CALENDAR", calendarWarn, logger, funcName)
}

export const readNotificationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
) => {
  if (logger) checkPermission(cloudServerUrl, packageName, "READ_NOTIFICATIONS", readNotficationWarn, logger, funcName)
}

export const postNotificationWarnLog = (
  cloudServerUrl: string,
  packageName: string,
  funcName?: string,
  logger?: Logger,
) => {
  if (logger) checkPermission(cloudServerUrl, packageName, "POST_NOTIFICATIONS", postNotficationWarn, logger, funcName)
}

export const cameraWarnLog = (cloudServerUrl: string, packageName: string, funcName?: string, logger?: Logger) => {
  if (logger) checkPermission(cloudServerUrl, packageName, "CAMERA", cameraWarn, logger, funcName)
}
```

The logger parameter is optional for backward compat — existing call sites that don't pass a logger will silently no-op (the `if (logger)` guard). As call sites are updated to pass the session logger, the permission warnings start flowing through the SDK logger and respecting log level settings.

### 12. `src/index.ts` (MODIFIED)

Add error class exports:

```typescript
// After the existing "// Logging exports" section:
export * from "./logging/logger"

// Add:
// Error classes
export {
  MentraError,
  MentraAuthError,
  MentraConnectionError,
  MentraTimeoutError,
  MentraValidationError,
  MentraPermissionError,
} from "./logging/errors"
```

### 13. `package.json` (MODIFIED)

```jsonc
{
  "dependencies": {
    // REMOVE:
    // "boxen": "^8.0.1",
    // "pino-pretty": "^13.0.0",

    // KEEP everything else unchanged:
    "@logtail/pino": "^0.5.4",
    "chalk": "^5.6.2",
    "pino": "^9.6.0",
    // ... etc
  },
  "optionalDependencies": {
    // ADD:
    "pino-pretty": "^13.0.0",
  },
  // boxen is removed entirely — no longer used
}
```

Moving `pino-pretty` to `optionalDependencies` means:

- `bun install` / `npm install` will still install it by default (optional deps are installed unless there's a platform/arch mismatch or the install fails).
- But it's not a hard requirement — if it fails to install or a user explicitly excludes it, the SDK falls back to JSON output in verbose mode.
- This is a signal to SDK consumers that pino-pretty is not core functionality.

Removing `boxen` is safe because the warning and update messages no longer use it. The `logos.ts` file with ASCII art can also be cleaned up but isn't critical — it just becomes dead code if nothing imports it.

Also update the `build:js` script to remove `boxen` from the `--external` list:

```
"build:js": "bun build src/index.ts src/display-utils.ts --outdir dist --target node --format esm --sourcemap=external --external @logtail/pino --external axios --external chalk --external cookie-parser --external dotenv --external express --external jimp --external jsonwebtoken --external jsrsasign --external multer --external pino --external pino-pretty --external strip-ansi --external ws",
```

Remove `--external boxen` (it was between `--external axios` and `--external chalk`).

---

## Testing Plan

### Manual Smoke Tests

#### Test 1: Clean mode (default)

```bash
# No env vars, no config changes — just run an existing app
cd packages/apps/captions
bun run dev
```

Expected terminal output:

```
MentraOS  ✓ App server running on port 3333
```

Then connect a glasses session. Expected:

```
MentraOS  ✓ Connected — user test@example.com
```

Then disconnect. Expected:

```
MentraOS  ⚠ Connection lost, reconnecting (1/3)...
```

Or if clean disconnect:

```
(nothing — clean disconnects are silent at warn level)
```

#### Test 2: Invalid API key

Set an invalid API key and start. Expected:

```
MentraOS  ✗ Invalid API key
```

One line. No stack trace. No structured object.

#### Test 3: Connection refused

Stop MentraOS Cloud, then start an app. Expected:

```
MentraOS  ✗ Connection refused — is MentraOS Cloud running?
```

#### Test 4: Verbose mode via env var

```bash
MENTRA_VERBOSE=true bun run dev
```

Expected: Full pino-pretty output — same as today's behavior. All debug/info lines visible with structured context objects.

#### Test 5: Verbose mode via config

```typescript
const app = new AppServer({
  packageName: "org.example.test",
  apiKey: "test-key",
  verbose: true,
})
```

Expected: Same as Test 4.

#### Test 6: Log level override

```bash
MENTRA_LOG_LEVEL=info bun run dev
```

Expected: Lifecycle events visible (session connect/disconnect), but still in clean single-line format.

```bash
MENTRA_LOG_LEVEL=none bun run dev
```

Expected: Complete silence from the SDK. Only the dev's own `console.log` output visible.

#### Test 7: Error class instanceof

```typescript
session.events.onError((error) => {
  console.log(error instanceof Error) // true
  console.log(error instanceof MentraError) // true (for SDK errors)
  console.log(error instanceof MentraAuthError) // true (for auth errors)
  console.log(error.code) // "AUTH_ERROR"
})
```

#### Test 8: No onError handler (fallback logging)

Don't register any `onError` handler. Trigger an error (invalid API key). Expected:

```
MentraOS  ✗ Invalid API key
```

The error is logged by the EventManager's fallback, not silently swallowed.

#### Test 9: BetterStack still works

```bash
BETTERSTACK_SOURCE_TOKEN=test-token bun run dev
```

Expected: Console output is still clean mode. BetterStack transport receives full structured logs at debug level (verify via BetterStack dashboard or by checking that the transport was initialized without errors).

#### Test 10: SDK update notification

Start an app with an outdated SDK version. Expected:

```
MentraOS  ⚠ SDK update available: 2.1.29 → 2.1.30 — bun install @mentra/sdk@latest
```

No ASCII art. No boxen border. One line.

#### Test 11: Permission warning

Call `session.camera.requestPhoto()` without camera permission declared. Expected:

```
MentraOS  ⚠ requestPhoto requires camera permission — enable at https://console.mentra.glass/apps/org.example.myapp/edit
```

No boxen border. No ASCII art logo. One line.

### Automated Tests

These can be added to the existing test suite in `cloud/tests/`:

1. **Logger factory tests** — verify `createLogger()` produces correct stream configuration for each config combination (clean/verbose/none, env var overrides).
2. **Error class tests** — verify `instanceof` chains work correctly (`MentraAuthError instanceof MentraError`, `MentraAuthError instanceof Error`).
3. **Clean transport tests** — feed JSON lines into `createCleanStream()` and verify output format.
4. **Error dedup tests** — verify that each error scenario produces exactly one output (either emit or log, not both).

---

## Migration Checklist

After implementation, before merging:

- [x] All 168 log call sites have been reviewed and assigned correct levels
- [x] No `console.error` or `console.log` calls remain in SDK src (except in dead/deprecated code paths and out-of-scope files like layouts.ts, simple-storage.ts, api-client.ts)
- [x] All `new Error(...)` in error-path code use appropriate `Mentra*Error` class (session/index.ts connect, handleMessage, handleReconnection, send)
- [x] `boxen` removed from dependencies and build script
- [x] `pino-pretty` moved to optionalDependencies
- [x] Error classes exported from `src/index.ts`
- [x] `settings.ts` no longer imports root logger directly
- [x] EventManager accepts and uses logger (no raw console calls)
- [x] Permission utils accept logger parameter
- [ ] Captions app tested with default config (clean output)
- [ ] Captions app tested with `MENTRA_VERBOSE=true` (verbose output)
- [ ] BetterStack transport verified with `BETTERSTACK_SOURCE_TOKEN`
- [x] No TypeScript compilation errors
- [x] Build succeeds: `bun run build`

---

## Risks & Mitigations

| Risk                                                                      | Likelihood | Mitigation                                                                                              |
| ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `Object.setPrototypeOf` in error classes doesn't work in some Bun version | Low        | Test instanceof in Bun specifically; remove if unnecessary for our target                               |
| Removing `cleanupError` handler causes silent error swallowing            | Medium     | EventManager fallback logging catches this; test explicitly                                             |
| pino multistream with mixed levels behaves unexpectedly                   | Low        | pino multistream is well-documented for this use case; test with BetterStack at debug + console at warn |
| `chalk` doesn't work in all terminal environments (e.g., CI, Docker)      | Low        | chalk auto-detects color support and falls back to plain text; no action needed                         |
| Existing apps that parse SDK log output (regex on pino-pretty format)     | Very Low   | No known apps do this; the format was never a public API                                                |

---

## Date

2026-02-16
