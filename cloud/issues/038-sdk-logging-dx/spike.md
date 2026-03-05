# Spike: SDK Logging & Error DX

## Status

**Specced** — see [spec.md](./spec.md) for implementation plan.

## Problem

Third-party developers using `@mentra/sdk` are overwhelmed by internal debug output. The SDK currently logs at a level designed for Mentra engineers debugging cloud↔SDK interactions. External devs just need clean, actionable messages.

Screenshot from a developer's terminal (an "Invalid API key" error):

```
[2026-02-15 21:04:17.599 -0800] ERROR: ✗ [Session xxx.assistant] Error:
    app: "xxx.assistant"
    packageName: "xxx.assistant"
    service: "app-server"
    err: {
        "type": "Error",
        "message": "Invalid API key",
        "stack":
            Error: Invalid API key
                at handleMessage (/Users/.../node_modules/@mentra/sdk/dist/index.js:4266:41)
                at messageHandler (/Users/.../node_modules/@mentra/sdk/dist/index.js:3962:20)
                at emit (node:events:98:22)
                at <anonymous> (ws:192:22)
    }
```

The developer needed `Error: Invalid API key`. They got 15 lines of internal state.

---

## Audit: Current State

### Logger setup (`src/logging/logger.ts`)

- Uses **pino** with **pino-pretty** transport for console + optional **@logtail/pino** for BetterStack
- Log level: `"debug"` in development, `"info"` in production
- Always uses pino-pretty (even in production — the `if` is commented out)
- BetterStack transport only activates if `BETTERSTACK_SOURCE_TOKEN` env var is set
- No user-facing configuration — the SDK consumer cannot control log level or format

### Log volume

168 `this.logger.*` calls across `src/app/`:

| Level   | Count | Examples                                                                |
| ------- | ----- | ----------------------------------------------------------------------- |
| `info`  | 58    | Session lifecycle, connection attempts, tool calls, settings updates    |
| `error` | 52    | Auth failures, WebSocket errors, handler errors, webhook failures       |
| `debug` | 36    | Subscription updates, URL validation, reconnect state, internal routing |
| `warn`  | 22    | SDK version mismatches, missing config, deprecated usage                |

### What devs see vs what they need

| Scenario            | Current output                                         | What dev needs                           |
| ------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Invalid API key     | 15-line structured error with stack into SDK internals | `Error: Invalid API key`                 |
| Connection lost     | Full reconnect state machine logs                      | `Connection lost, reconnecting (2/5)...` |
| Session start       | 5+ info lines with internal IDs                        | Nothing (or one clean line)              |
| Subscription update | Debug dump of handler maps                             | Nothing                                  |
| App stopped         | Multi-line disconnect info with close codes            | `Session ended`                          |

### Error handling patterns

**Errors that are logged but should be thrown (or emitted):**

- `"Invalid API key"` — logged as error, should be a thrown/emitted auth error
- `"WebSocket URL is missing"` — logged AND thrown (redundant)
- Connection init failures — logged, then emitted via `events.emit("error", ...)`, then rejected

**Errors that are thrown correctly:**

- Layout validation (`"Layout must have a layoutType property"`)
- Settings API client (`"API client is not configured"`)
- Language validation (`"Invalid language code: ..."`)

**Errors that are just logged and swallowed:**

- `"Version check failed"` — caught, logged, never surfaces to dev
- `"Failed to disconnect old session"` — warned, continued past

### AppServerConfig has no logging options

```typescript
export interface AppServerConfig {
  packageName: string
  apiKey: string
  port?: number
  cloudApiUrl?: string
  webhookPath?: string // deprecated
  publicDir?: string | false
  healthCheck?: boolean
  cookieSecret?: string
  appInstructions?: string
  // ← no logging config
}
```

---

## Problems

### P1: No log level control

Devs cannot turn off debug/info noise. The SDK decides for them based on `NODE_ENV`. Setting `NODE_ENV=production` changes behavior beyond just logging (e.g., error verbosity, BetterStack routing). There is no SDK-specific log level control.

### P2: Structured objects in error output

Pino logs errors as structured JSON objects with `type`, `message`, `stack`, plus context fields (`app`, `packageName`, `service`). Pino-pretty formats these as indented YAML-like blocks. A developer scanning their terminal for what went wrong has to parse this structure mentally.

### P3: Internal context leaks into dev-facing logs

Fields like `service: "app-server"`, `sessionId`, `packageName` (redundant — the dev knows their own package name), internal WebSocket URLs, and reconnect state machine details are all visible. These are useful for Mentra engineers but noise for SDK consumers.

### P4: No error taxonomy

All errors are `new Error("message string")`. There are no error classes, no `.code` fields, no programmatic way to distinguish auth errors from connection errors from validation errors. Devs can only pattern-match on `.message` strings.

### P5: Duplicate error reporting

Some errors are logged AND thrown AND emitted, creating 2-3x output for a single failure. Example: connection failure logs an error, emits to `"error"` event, and rejects the connect promise.

### P6: pino-pretty is a required dependency for SDK consumers

The SDK always initializes pino-pretty transport. This adds a dependency that SDK consumers didn't ask for and may conflict with their own logging setup.

---

## Proposed Direction

### Log levels for SDK consumers

Add `logLevel` and `verbose` to `AppServerConfig`:

```typescript
export interface AppServerConfig {
  // ... existing fields ...

  /**
   * Log level for SDK output. Defaults to 'warn'.
   * - 'error': Only errors
   * - 'warn': Errors + warnings (default)
   * - 'info': Errors + warnings + lifecycle events
   * - 'debug': Everything (equivalent to verbose: true)
   * - 'none': Suppress all SDK logging
   */
  logLevel?: "error" | "warn" | "info" | "debug" | "none"

  /**
   * Enable verbose internal logging. Useful for debugging SDK issues.
   * Equivalent to logLevel: 'debug' with full structured output.
   * Can also be enabled via MENTRA_VERBOSE=true env var.
   * Default: false
   */
  verbose?: boolean
}
```

Env var overrides: `MENTRA_LOG_LEVEL`, `MENTRA_VERBOSE`. This lets Mentra support tell a developer "set `MENTRA_VERBOSE=true` and send us the output" without code changes.

### Two formatting modes

**Default (clean):** Single-line, human-readable, no structured objects.

```
[MentraOS] ✗ Invalid API key
[MentraOS] ⚠ Connection lost, reconnecting (attempt 2/5)
[MentraOS] ✓ Connected to MentraOS Cloud
```

**Verbose:** Current pino-pretty structured output (what Mentra engineers see today). Full context objects, stack traces, internal state.

Implementation: swap the pino transport based on verbose flag. Clean mode uses a minimal custom transport that formats single-line messages. Verbose mode uses pino-pretty as today.

### Error classes

```typescript
export class MentraError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
    this.name = "MentraError"
  }
}

export class MentraAuthError extends MentraError {
  constructor(message: string) {
    super(message, "AUTH_ERROR")
    this.name = "MentraAuthError"
  }
}

export class MentraConnectionError extends MentraError {
  constructor(
    message: string,
    public code: string = "CONNECTION_ERROR",
  ) {
    super(message, code)
    this.name = "MentraConnectionError"
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
    public stream: string,
    public requiredPermission: string,
  ) {
    super(message, "PERMISSION_ERROR")
    this.name = "MentraPermissionError"
  }
}
```

Devs can then:

```typescript
session.events.onError((error) => {
  if (error instanceof MentraAuthError) {
    console.log("Bad API key, check your config")
  } else if (error instanceof MentraConnectionError) {
    console.log("Connection issue, will retry")
  }
})
```

### Deduplicate error paths

Audit each error site. Each error should have ONE output path:

| Error type           | Path                                                         | Notes                                                  |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Auth failure         | Emitted via `events.emit("error", new MentraAuthError(...))` | Don't also log it — let the dev's error handler decide |
| Connection failure   | Reject the `connect()` promise with `MentraConnectionError`  | Don't also log + emit                                  |
| Validation errors    | Throw synchronously                                          | Already correct for most layout/settings validation    |
| Internal retries     | Log at `debug` level only                                    | Dev doesn't need to know about retry #3 of 5           |
| Permanent disconnect | Emit `"disconnected"` event with clean info                  | Already mostly correct                                 |

### Decouple from pino-pretty

Make pino-pretty an optional peer dependency. In clean mode, use a lightweight formatter that doesn't need pino-pretty. In verbose mode, attempt to load pino-pretty and fall back to JSON if not installed.

This reduces the SDK's dependency footprint for devs who don't need verbose logging (the majority).

---

## Decisions

### BetterStack transport stays as-is (silent, undocumented)

The SDK activates the BetterStack pino transport when `BETTERSTACK_SOURCE_TOKEN` is set. This stays. Rationale:

- **Mentra's own apps** set this env var to route logs to Mentra's BetterStack instance for internal observability. We want this to keep working.
- **Third-party devs** don't know about it — it's undocumented and hidden. They never see it, so it's zero DX burden.
- **If a third-party dev did set it**, their logs would go to _their_ BetterStack account, not Mentra's. No data leak, no confusion. It's a benign hidden feature.
- The **clean logging mode** (default) must not produce any output that references or hints at BetterStack. The transport runs silently in the background if the env var is present.

No changes needed here. Not a DX concern.

## Open Questions

1. **Should `logLevel` default to `'warn'` or `'error'`?** — `'warn'` catches deprecation warnings and non-fatal issues. `'error'` is quieter. Leaning `'warn'`.

2. **Custom logger injection?** — Some devs may want to pipe SDK logs into their own logging system (winston, bunyan, etc.). Do we support `logger?: Logger` in config? This is a nice-to-have but adds complexity. Could defer to v3.1.

3. **Breaking change or additive?** — Adding `logLevel`/`verbose` to config is additive (non-breaking). Changing error classes from `Error` to `MentraAuthError` etc. could break `catch` blocks that check `error.constructor === Error`. In practice this is unlikely but worth noting. Since we're targeting SDK v3, we can make this breaking.

---

## Next Steps

1. Get feedback on proposed direction
2. Write spec with exact changes per file
3. Implement as part of SDK v3 branch (alongside 039-sdk-v3-api-surface changes)

## Date

2026-02-16
