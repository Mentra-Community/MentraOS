# Spec: SDK Logging & Error DX Overhaul

## Status

**Specced** — ready for implementation.

## Summary

Replace the SDK's current pino-pretty firehose with a two-mode logging system: a **clean mode** (default) that prints single-line colored messages, and a **verbose mode** that preserves today's full structured output. Add error classes with `.code` fields. Deduplicate error output paths so every error produces exactly one piece of terminal output.

All changes are additive to `AppServerConfig` — existing apps continue to work without code changes.

---

## Goals

1. A third-party developer running `bun run dev` sees ≤3 SDK lines on a clean startup.
2. Errors are one line with color, not 15-line pino-pretty YAML blocks.
3. Every error has exactly one output path (no triple-logging).
4. Mentra engineers can flip to full verbose output with one env var.
5. BetterStack transport is unaffected (silent, undocumented, stays as-is).
6. Backward compatible — no existing code breaks.

---

## Non-Goals

- Custom logger injection (`logger?: Logger` in config) — deferred to v3.1.
- Removing pino as the underlying logger — we keep it, just change the transport.
- Changing the wire protocol or event names.
- The manager-pattern API surface changes (that's 039).

---

## Design

### 1. Two Logging Modes

#### Clean Mode (default)

Single-line, colored, human-readable. Uses chalk (already a dependency) to write directly to `process.stderr`.

Format:

```
MentraOS  ✓ App server running on port 7010
MentraOS  ✓ Connected — user bob@example.com
MentraOS  ⚠ Connection lost, reconnecting (2/3)...
MentraOS  ✓ Reconnected — user bob@example.com
MentraOS  ✗ Invalid API key
MentraOS  ✗ Connection refused — is MentraOS Cloud running?
MentraOS  ⚠ SDK update available: 2.1.29 → 2.1.30 — bun install @mentra/sdk@latest
```

Color scheme:

- **`MentraOS`** prefix — dim gray. Always present, visually skippable.
- **`✓`** — green. Success events (server start, session connect, reconnect success).
- **`⚠`** — yellow. Warnings (reconnecting, SDK outdated, deprecation, missing permission).
- **`✗`** — red. Errors (auth failure, connection dead, unrecoverable).
- **Message text** — default terminal color (white/light).

Clean mode does NOT use pino-pretty. It uses a lightweight custom pino transport that extracts `msg` and `level` from the pino JSON stream and formats them as the single-line output above. This means:

- pino-pretty becomes an optional dependency (only needed for verbose mode).
- All child logger context (`app`, `packageName`, `service`, `userId`, `module`) is hidden from terminal output but still present in the structured log object (so BetterStack still receives full context).

#### Verbose Mode

Today's pino-pretty structured output, unchanged. Full context objects, stack traces, internal state, emoji-prefixed messages — everything Mentra engineers currently see.

Activated by:

- `verbose: true` in `AppServerConfig`
- `MENTRA_VERBOSE=true` env var (takes precedence over config)

When verbose is active, pino-pretty is loaded as the console transport. If pino-pretty is not installed (e.g., dev removed it), fall back to JSON output to `process.stdout` and log a single warning.

### 2. Log Level Control

Add `logLevel` to `AppServerConfig`:

```typescript
export interface AppServerConfig {
  // ... existing fields unchanged ...

  /**
   * SDK console log level. Default: 'warn'.
   * - 'none':  Suppress all SDK console output
   * - 'error': Only errors
   * - 'warn':  Errors + warnings (default)
   * - 'info':  Errors + warnings + lifecycle events
   * - 'debug': Everything (verbose structured output)
   */
  logLevel?: "none" | "error" | "warn" | "info" | "debug"

  /**
   * Enable verbose internal logging (full pino-pretty structured output).
   * Equivalent to logLevel: 'debug' with structured formatting.
   * Can also be enabled via MENTRA_VERBOSE=true env var.
   * Default: false
   */
  verbose?: boolean
}
```

Env var overrides (checked at logger creation time):

- `MENTRA_LOG_LEVEL` — overrides `logLevel` config. Values: `none`, `error`, `warn`, `info`, `debug`.
- `MENTRA_VERBOSE` — if `"true"` or `"1"`, overrides to verbose mode regardless of other settings.

Resolution order:

1. `MENTRA_VERBOSE=true` → verbose mode, `debug` level, pino-pretty transport.
2. `MENTRA_LOG_LEVEL` → sets level, uses clean transport (unless value is `debug`, which implies verbose).
3. `config.verbose: true` → verbose mode.
4. `config.logLevel` → sets level, uses clean transport.
5. Default → `warn` level, clean transport.

The BetterStack transport **always** runs at the same level as the console transport. If console is suppressed (`none`), BetterStack still receives logs at `debug` level (it has its own stream in the pino multistream, unaffected by the console transport level). This preserves internal observability for Mentra's own apps.

### 3. What Gets Logged at Each Level

#### `error` level — red ✗

Only unrecoverable failures that require developer action:

- Auth failures (invalid API key, token expired)
- Connection permanently lost (all retries exhausted)
- WebSocket URL missing/malformed (config error)
- Unrecoverable message processing errors

#### `warn` level — yellow ⚠ (DEFAULT)

Everything in `error`, plus:

- SDK version outdated (single-line, no ASCII banner)
- Connection lost + reconnecting (with attempt count)
- Deprecated API usage warnings
- Missing permission warnings (single-line, no boxen banner)
- Unrecognized message types from cloud
- Settings-based subscription mismatches

#### `info` level — green ✓

Everything in `warn`, plus:

- Server started (with port)
- Session connected (with userId)
- Session disconnected (with reason, one line)
- Reconnection successful
- Photo request/response lifecycle
- Audio play lifecycle
- RTMP stream start/stop

#### `debug` level

Everything in `info`, plus:

- All current debug output (subscription state, handler maps, WebSocket state machine, URL validation, message routing, internal timers)
- This level auto-enables verbose formatting (structured pino-pretty output)

### 4. Error Classes

New file: `src/logging/errors.ts`

```typescript
/**
 * Base error class for all SDK errors.
 * Extends Error so instanceof Error still works (backward compatible).
 */
export class MentraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
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

These are exported from `src/index.ts` so SDK consumers can import them:

```typescript
import {MentraAuthError, MentraConnectionError} from "@mentra/sdk"

session.events.onError((error) => {
  if (error instanceof MentraAuthError) {
    // handle auth failure
  }
})
```

### 5. Error Path Deduplication

The core rule: **each error has exactly ONE consumer-visible output**.

#### Rule: emit OR log, never both

Today, AppServer registers an internal `onError` handler (line 584 of `server/index.ts`) that logs every emitted error:

```typescript
const cleanupError = session.events.onError((error) => {
  this.logger.error(error, `❌ [Session ${sessionId}] Error:`)
})
```

This means every `events.emit("error", ...)` also produces a log line. The fix:

- **Remove the internal `cleanupError` handler from AppServer.** The SDK should not log errors that it also emits. The dev's `onError` handler (if any) is the consumer.
- **Add fallback logging:** In `EventManager.emit()`, if the event is `"error"` and there are zero registered error handlers (no dev `onError`), then log the error via the SDK logger. This prevents silent swallowing.

Result:

- Dev has `onError` → error goes to their handler. No SDK log.
- Dev has no `onError` → error logged by SDK in clean format. No silent swallowing.

#### Error site audit — new output path for each

| Error site                    | File:Line                     | Current behavior                                                          | New behavior                                                                                                                           |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid API key               | `session/index.ts` L1323      | `events.emit("error", new Error(...))` → also logged by cleanupError      | `events.emit("error", new MentraAuthError(...))` — no internal log                                                                     |
| Connection refused            | `session/index.ts` L850-866   | logger.error (2x) + errorHandler logs + emits + cleanupError logs         | `events.emit("error", new MentraConnectionError("Connection refused — is MentraOS Cloud running?"))` — no logger.error                 |
| Connection timeout            | `session/index.ts` L886-899   | logger.error (with config object) + emit + reject                         | `reject(new MentraTimeoutError("Connection timeout after 5000ms"))` — only reject, no log, no emit                                     |
| WebSocket URL missing         | `session/index.ts` L649-653   | logger.error + reject                                                     | `reject(new MentraValidationError("WebSocket URL is required"))` — only reject                                                         |
| JSON parse failure            | `session/index.ts` L748-752   | logger.error + emit                                                       | `events.emit("error", new MentraError("Failed to parse message", "PARSE_ERROR"))` — no logger.error                                    |
| Binary message error          | `session/index.ts` L706-711   | logger.error + emit                                                       | emit only (debug-level log in verbose)                                                                                                 |
| Connection init error         | `session/index.ts` L674-679   | logger.error + emit + reject                                              | reject only                                                                                                                            |
| WebSocket error event         | `session/index.ts` L850-866   | logger.error (2-3x) + emit via errorHandler                               | emit only via `events.emit("error", new MentraConnectionError(...))`                                                                   |
| Message send failure          | `session/index.ts` L1896-1903 | logger.error/debug + emit + throw                                         | throw only (emit for disconnect-expected cases at debug level)                                                                         |
| Reconnection failed           | `session/index.ts` L1814      | logger.error + emit                                                       | emit only (reconnecting state logged at warn if < max, error if final)                                                                 |
| Permission error from cloud   | `session/index.ts` L1525-1548 | logger.warn (structured) + emit permission_error + emit permission_denied | emit only (both events still emitted, no log)                                                                                          |
| Unrecognized message          | `session/index.ts` L1568-1571 | logger.warn + emit error                                                  | logger.warn only (at warn level in clean mode). No error emit — unknown message types are not errors.                                  |
| Version check failed          | `server/index.ts` L306-308    | logger.error                                                              | logger.debug — this is not actionable for the dev                                                                                      |
| Webhook handling error        | `server/index.ts` L386-392    | logger.error + HTTP 500                                                   | logger.error + HTTP 500 (unchanged — HTTP errors need logging)                                                                         |
| Handler error in EventManager | `events.ts` L455-460          | `console.error(...)` + emit error                                         | Replace `console.error` with `this.logger.error()` at debug level (handler errors should surface via the error event, not raw console) |

### 6. ASCII Banner Removal

#### SDK Update Notification

Current (`src/constants/log-messages/updates.ts`): 20+ line boxen-bordered ASCII art banner with the MENTRA logo.

New: Single-line warning.

```
MentraOS  ⚠ SDK update available: 2.1.29 → 2.1.30 — bun install @mentra/sdk@latest
```

Implementation: Replace `createUpdateNotification()` with a function that returns a plain string (no boxen, no ASCII art). The clean logger formats it with color. In verbose mode, the old banner can still render (but honestly, even in verbose mode the single line is better — leaving this as an implementation detail).

### 6a. Dist-Tag-Aware Version Checking

#### The bug

The SDK has multiple npm dist-tags (release tracks):

| Tag      | Current version | Purpose                                    |
| -------- | --------------- | ------------------------------------------ |
| `latest` | `2.1.29`        | Stable release                             |
| `beta`   | `2.1.31-beta.5` | Beta track (ahead of latest)               |
| `hono`   | `3.0.0-hono.4`  | Hono branch (major version bump, diverged) |
| `alpha`  | `2.1.2-alpha.0` | Old alpha (stale)                          |

The version check always compares against the `latest` dist-tag, regardless of which track the developer is on. A developer on `hono` (`3.0.0-hono.4`) is told to "update" to `2.1.29` — which is actually a downgrade to a completely different branch that bricks their app. Same issue for `beta` users.

**Cloud side** (`api/hono/sdk/sdk-version.api.ts`): hardcoded `fetch("https://registry.npmjs.org/@mentra/sdk/latest")` — always checks the `latest` tag.

**SDK side** (`app/server/index.ts`): always recommends `bun install @mentra/sdk@latest` in the warning message.

#### The fix

**1. SDK determines its own track from its version string:**

The prerelease tag in the version tells you which track it's on:

- `2.1.29` → no prerelease → `latest`
- `2.1.31-beta.5` → contains `beta` → `beta`
- `3.0.0-hono.4` → contains `hono` → `hono`
- `2.1.2-alpha.0` → contains `alpha` → `alpha`

New utility function `getDistTag(version: string): string`:

```typescript
function getDistTag(version: string): string {
  // Match the prerelease identifier: "3.0.0-hono.4" → "hono"
  const match = version.match(/-(alpha|beta|hono|rc|canary|next)/)
  return match ? match[1] : "latest"
}
```

**2. SDK sends its track to the cloud API:**

```
GET /api/sdk/version?tag=hono
```

**3. Cloud fetches the correct dist-tag from npm:**

```typescript
const tag = c.req.query("tag") || "latest"
// Validate tag against known dist-tags to prevent abuse
const allowedTags = ["latest", "beta", "alpha", "hono", "rc", "canary", "next"]
const safeTag = allowedTags.includes(tag) ? tag : "latest"
const response = await fetch(`https://registry.npmjs.org/@mentra/sdk/${safeTag}`)
```

**4. SDK uses the correct install command:**

```
// Before (always @latest):
MentraOS  ⚠ SDK update available: 3.0.0-hono.4 → 2.1.29 — bun install @mentra/sdk@latest

// After (matches the dev's track):
MentraOS  ⚠ SDK update available: 3.0.0-hono.4 → 3.0.0-hono.5 — bun install @mentra/sdk@hono
```

For the `latest` track, the install command stays `bun install @mentra/sdk@latest` (same as before).

#### Files changed

| File                                        | Change                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sdk/src/app/server/index.ts`               | Parse current version to get dist-tag, send `?tag=` to cloud API, use correct tag in install command |
| `sdk/src/constants/log-messages/updates.ts` | Accept `tag` parameter, use it in the install command string                                         |
| `cloud/src/api/hono/sdk/sdk-version.api.ts` | Accept `tag` query param, fetch correct dist-tag from npm, validate against allowed list             |
| `cloud/src/api/sdk/sdk-version.api.ts`      | Same change (Express version — delete after Express removal)                                         |

#### Permission Warnings

Current (`src/constants/log-messages/warning.ts`): Boxen-bordered side-by-side layout with ASCII art logo per permission type.

New: Single-line warning.

```
MentraOS  ⚠ camera permission required for requestPhoto — enable at https://console.mentra.glass/apps/org.example.myapp/edit
```

Implementation: Replace the boxen banner functions with plain string formatters. The `permissions-utils.ts` functions should use the SDK logger instead of `console.log()` so they respect log level settings.

### 7. Console.error Cleanup in EventManager

`EventManager.emit()` (lines 455 and 469 of `events.ts`) uses raw `console.error()` for handler errors. These bypass pino entirely, so `logLevel: 'none'` doesn't silence them.

Fix: The EventManager needs access to the logger. Pass it via constructor (the EventManager is created in the AppSession constructor, which already has a logger).

Change:

```typescript
// Before
console.error(`Error in handler for event '${String(event)}':`, handlerError)

// After
this.logger.debug({event: String(event), error: handlerError}, `Error in handler for event '${event}'`)
```

This becomes a debug-level log because:

- The error is also emitted via the `"error"` event (already happening on line 462).
- If the dev has an `onError` handler, they'll get it there.
- If not, the fallback logger catches it.
- Raw `console.error` should never fire from within the SDK.

### 8. Settings Manager Logger Fix

`src/app/session/settings.ts` line 10 imports the root logger directly:

```typescript
import {logger} from "../../logging/logger"
```

This is the only module that does this (all others receive a child logger via DI). Fix: pass the logger through the constructor so it inherits the session's child logger context and respects the configured log level.

---

## File Changes

### New Files

| File                             | Purpose                                              |
| -------------------------------- | ---------------------------------------------------- |
| `src/logging/errors.ts`          | MentraError class hierarchy                          |
| `src/logging/clean-transport.ts` | Custom pino transport for single-line colored output |

### Modified Files

| File                                                  | Changes                                                                                                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/logging/logger.ts`                               | Refactor to factory function `createLogger(config)` that returns clean or verbose logger. Keep the default export as a no-config fallback (backward compat for settings.ts during migration).                                          |
| `src/app/server/index.ts`                             | Add `logLevel`/`verbose` to `AppServerConfig`. Pass config to logger factory. Remove internal `cleanupError` handler. Add fallback logging in its place (or rely on EventManager's fallback). Simplify `start()` version check output. |
| `src/app/session/index.ts`                            | Use error classes for all `new Error(...)` sites. Remove redundant `this.logger.error()` calls where errors are also emitted/thrown. Adjust log levels per the audit table above.                                                      |
| `src/app/session/events.ts`                           | Accept logger in constructor. Replace `console.error` with logger calls. Add fallback: if emitting `"error"` and no handlers registered, log via SDK logger.                                                                           |
| `src/app/session/settings.ts`                         | Accept logger via constructor instead of importing root logger directly.                                                                                                                                                               |
| `src/app/session/modules/audio.ts`                    | Adjust log levels: most `info` → `debug`, keep lifecycle events at `info`.                                                                                                                                                             |
| `src/app/session/modules/camera.ts`                   | Adjust log levels: most `info` → `debug`, keep lifecycle events at `info`.                                                                                                                                                             |
| `src/app/session/modules/camera-managed-extension.ts` | Adjust log levels: most `info` → `debug`.                                                                                                                                                                                              |
| `src/app/session/modules/led.ts`                      | Adjust log levels: `info` → `debug` for request details.                                                                                                                                                                               |
| `src/constants/log-messages/updates.ts`               | Replace boxen ASCII banner with plain single-line string.                                                                                                                                                                              |
| `src/constants/log-messages/warning.ts`               | Replace boxen banners with plain single-line strings.                                                                                                                                                                                  |
| `src/utils/permissions-utils.ts`                      | Accept logger parameter. Use logger instead of `console.log`/`console.warn`. Log at `warn` level.                                                                                                                                      |
| `src/index.ts`                                        | Export error classes from `src/logging/errors.ts`.                                                                                                                                                                                     |
| `package.json`                                        | Move `pino-pretty` from `dependencies` to `optionalDependencies` (or `peerDependencies` with `optional: true`). Remove `boxen` from dependencies (no longer needed in clean mode).                                                     |

---

## Clean Transport Implementation

The clean transport is a pino transport (a writable stream that receives newline-delimited JSON from pino). It:

1. Parses each JSON line from pino.
2. Extracts `level` (number) and `msg` (string).
3. Maps pino level numbers to symbols: 60=`✗` red, 50=`✗` red, 40=`⚠` yellow, 30=`✓`/no-symbol green/default, 20=dim.
4. Formats as: `${dim("MentraOS")}  ${symbol} ${msg}\n`
5. Writes to `process.stderr`.

It ignores all structured context fields (`app`, `packageName`, `service`, `userId`, `err`, etc.) — those are only visible in verbose mode or in BetterStack. The message string (`msg`) is the only thing that reaches the developer's terminal in clean mode.

This means **every log call must have a self-contained, human-readable `msg`**. The structured context object (first argument to pino methods) is for machine consumption only.

Example:

```typescript
// Good — msg is self-contained
this.logger.info(`Connected — user ${userId}`)

// Also good — context for BetterStack, msg for humans
this.logger.info({userId, sessionId}, `Connected — user ${userId}`)

// Bad — msg is not readable without context
this.logger.info({userId}, `Session connected`) // "Session connected" alone isn't useful
```

---

## Backward Compatibility

| Concern                                       | Impact                                     | Mitigation                                                    |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| New `AppServerConfig` fields                  | None — additive optional fields            | Existing configs work unchanged                               |
| Error classes extend `Error`                  | `instanceof Error` still true              | `catch (e) { if (e instanceof Error) }` still works           |
| `events.onError` callback                     | Same signature: `(error: Error) => void`   | `MentraError extends Error`, so type is compatible            |
| Default log level changes from `debug`→`warn` | Devs see less output                       | This is the goal. `verbose: true` restores old behavior.      |
| pino-pretty becomes optional                  | Only needed for verbose mode               | Auto-detected; falls back to JSON if missing                  |
| `boxen` removed from output                   | Permission/update warnings are single-line | Same information, less visual noise                           |
| BetterStack transport                         | Unchanged                                  | Runs at debug level regardless of console level               |
| `BETTERSTACK_SOURCE_TOKEN`                    | Unchanged                                  | Still activates BetterStack transport silently                |
| Internal `cleanupError` handler removed       | Errors no longer double-logged             | Fallback logging in EventManager ensures no silent swallowing |

### Migration for Mentra's own apps

Mentra's internal apps (captions, etc.) that rely on verbose logging should add either:

- `MENTRA_VERBOSE=true` in their `.env` / Docker config, OR
- `verbose: true` in their `AppServerConfig`

This is a one-line change per app. Without it, they'll get the new clean output (which is fine for production, but engineers may want verbose during development).

---

## Decisions (from spike)

### BetterStack transport stays as-is (silent, undocumented)

Rationale documented in spike. No changes to BetterStack behavior.

### Default log level: `warn`

`warn` catches deprecation warnings, permission issues, and reconnection attempts — things a dev should know about but doesn't need to act on immediately. `error` would hide reconnection state which is useful context. `info` would show lifecycle events that most devs don't care about.

### pino stays as the underlying logger

We're not replacing pino. We're replacing the _transport_ (how logs reach the terminal). Pino's JSON-based multistream architecture makes it easy to have one stream for clean console output and another for BetterStack, at different levels, from the same logger instance.

### Error classes are the only "breaking" change

`MentraAuthError` replaces `new Error("Invalid API key")`. Since `MentraAuthError extends Error`, `catch (e) { if (e instanceof Error) }` still works. The only break would be code that checks `e.constructor === Error` (exact match, not instanceof). This is extremely uncommon in practice. Since we're bundling this with SDK v3, it's acceptable.

---

## Open Questions (remaining from spike)

1. **Custom logger injection?** — Deferred to v3.1. Not in scope for this spec.
2. **Dist-tag allowlist maintenance** — when a new dist-tag is added to npm (e.g., `rc`, `next`), the cloud's allowlist needs updating. Keep the list generous (include common tag names) or fetch the actual dist-tags from npm and validate dynamically?

---

## Implementation Order

1. Create `src/logging/errors.ts` (error classes) — no dependencies on other changes.
2. Create `src/logging/clean-transport.ts` (clean formatter) — standalone.
3. Refactor `src/logging/logger.ts` to factory function with config support.
4. Update `src/app/server/index.ts` — new config fields, logger factory wiring, remove `cleanupError`.
5. Update `src/app/session/events.ts` — accept logger, replace console.error, add fallback.
6. Update `src/app/session/index.ts` — error classes, dedup error paths, adjust log levels.
7. Update `src/app/session/settings.ts` — logger DI.
8. Update modules (`audio.ts`, `camera.ts`, `camera-managed-extension.ts`, `led.ts`) — adjust log levels.
9. Update `src/constants/log-messages/updates.ts` and `warning.ts` — single-line messages.
10. Update `src/utils/permissions-utils.ts` — use logger.
11. Update `src/index.ts` — export error classes.
12. Update `package.json` — pino-pretty optional, remove boxen.
13. Fix dist-tag-aware version checking (§6a) — SDK side (`server/index.ts`, `updates.ts`) + cloud side (`sdk-version.api.ts`).
14. Test: verify clean output, verbose output, error dedup, BetterStack still works, backward compat, version check on each dist-tag track.

---

## Date

2026-02-16
