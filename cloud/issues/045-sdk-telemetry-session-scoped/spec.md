# Issue 045 — Session-Scoped SDK Telemetry & PR Review Followups

## Background

PR #2194 (`cloud/issues-044`) wired up the full incident telemetry pipeline:

- Cloud sends `REQUEST_TELEMETRY` → SDK's `AppSession.handleTelemetryRequest()` → reads from
  `AppServer.telemetryBuffer` → POSTs to `/api/incidents/:id/logs`

During PR review, the Codex bot and manual review identified four issues with the initial
implementation. This issue documents their status and implements the one real fix.

---

## PR Review Comment Dispositions

### Comment 1 — Telemetry buffer not scoped per user ✅ Fix in this issue

**Bot claim:** `getTelemetryLogs()` returns all entries from a shared buffer, leaking unrelated
users' logs into another user's incident bundle.

**Reality:** The bot's "privacy" framing was wrong — `logTelemetry()` stores developer app logs,
not user data. However the underlying concern points at a real design problem: a server handling
N concurrent users would upload logs from all of them for one user's incident. Better Stack
already has server-wide logs. The value of SDK telemetry is capturing what was happening
**for that specific user's session**. The current design also never gets populated — `logTelemetry()`
is a manual opt-in method that nothing in the SDK calls. The buffer is always empty.

**Fix:** See Implementation section below.

---

### Comment 2 — Cookie name mismatch between auth route and middleware ⚠️ Pre-existing, track separately

**Bot claim:** `createMentraAuthRoutes()` sets the cookie as `${packageName}-session` but
`createAuthMiddleware()` defaults to `"aos_session"`, so the cookie written by `/api/mentra/auth/init`
is never read by the middleware on subsequent requests.

**Reality:** Valid bug. Code inspection confirmed the mismatch:

```
// createMentraAuthRoutes() — line 435 of webview/index.ts
const cookieName = `${packageName}-session`  // e.g. "org.example.myapp-session"

// createAuthMiddleware() — line 237 of webview/index.ts
cookieName = "aos_session"  // default, never matches
```

**Status:** Pre-existing on both `dev` and this branch. Not introduced by PR #2194.
The impact is limited to fullstack apps using both helpers together without explicitly
passing a matching `cookieName` — currently only the example apps. Fix is a one-liner
(make `createAuthMiddleware` default to `${packageName}-session` too, or export a shared
constant). Not blocking merge to dev. Track as a separate small fix.

---

### Comment 3 — Pending audio chunks cleared before async writes complete ✅ Intentional

**Bot claim:** `flushPendingChunks()` clears `stream.pendingChunks` before `writer.write()` promises
resolve. Failed writes are swallowed without re-queuing.

**Reality:** This is correct and intentional. `WritableStreamDefaultWriter.write()` enqueues data
into the stream's internal backpressure queue — it doesn't mean the write is in-flight over the
network. Clearing the pending buffer _before_ iterating is the right pattern: it prevents a race
where a concurrent `writeToStream()` call adds new chunks that then get double-cleared. If the
writer is broken (phone disconnected mid-flush), the next `writeToStream()` call detects the broken
writer state and calls `bufferChunk()` again. No data is silently dropped that wasn't already
acknowledged by the stream's queue.

**No action needed.**

---

### Comment 4 — Stale streams not destroyed after reconnect timeout ✅ Already covered

**Bot claim:** After reconnect timeout, non-ended streams stay in memory indefinitely if the SDK
stops writing.

**Reality:** Already handled by `ABANDON_TIMEOUT_MS` (60s). `resetAbandonTimer()` is called from
`writeToStream()` on every write. If the SDK stops writing after a reconnect timeout, the 60s
abandon timer fires and calls `destroyStream()`. The initial claim timeout (`INITIAL_CLAIM_TIMEOUT_MS`
= 15s) handles the case where the phone never connected at all. All paths covered.

**No action needed.**

---

## The Real Fix: Session-Scoped Telemetry via Pino Transport

### Problem

The current implementation has two flaws:

1. **Buffer lives on `AppServer`** — shared across all concurrent users. Wrong scope.
2. **Nothing feeds the buffer** — `logTelemetry()` is a manual opt-in method. No SDK code calls
   it. Every `REQUEST_TELEMETRY` response currently uploads `logs: []`.

### Solution

Move the ring buffer onto `AppSession` and feed it automatically via a custom pino write stream
hooked into `session.logger`.

The session logger is already correctly scoped:

```typescript
// AppSession constructor
this.logger = this.appServer.logger.child({
  userId: this.config.userId,
  service: "app-session",
})
```

All module loggers (camera, audio, led, etc.) are children of this — so intercepting at the
session logger level captures all per-user activity with zero effort from app developers.

### Architecture

```
appServer.logger  (pino, shared)
    └── session.logger  (child, userId bound)
            ├── camera logger   (child)
            ├── audio logger    (child)
            ├── led logger      (child)
            └── [developer app code]

                    ↓ all writes flow through here

         TelemetryBufferStream  (custom pino Writable)
            └── session.telemetryBuffer: TelemetryLogEntry[]
                    ↓
         handleTelemetryRequest() reads this
                    ↓
         POST /api/incidents/:id/logs  →  R2 storage
```

### Implementation Plan

#### 1. New file: `sdk/src/logging/telemetry-transport.ts`

A pino-compatible `Writable` stream (same pattern as `clean-transport.ts`) that:

- Parses each JSON log line from pino
- Pushes a `TelemetryLogEntry` into a ring buffer provided at construction time
- Respects a configurable `bufferSize` (default 500 — session logs are denser than server logs)
- Trims oldest entries when full

```typescript
export function createTelemetryStream(buffer: TelemetryLogEntry[], bufferSize: number): Writable
```

#### 2. `AppSession` — add `telemetryBuffer`, rebuild `session.logger` with the transport

In the `AppSession` constructor, after `this.logger` is created as a child of `appServer.logger`:

- Create `this.telemetryBuffer: TelemetryLogEntry[]`
- Create a telemetry stream pointing at the buffer
- Rebuild `this.logger` as a new pino instance using `pino.multistream` combining:
  - The parent logger's existing streams (so BetterStack + console still work)
  - The new telemetry stream at `info` level (debug is too noisy for incident bundles)

Actually simpler: pino child loggers share the parent's transport. Instead, we use
`this.logger = appServer.logger.child(...)` as today but **also** add a destination to the
parent logger's multistream that is session-specific. This is awkward.

**Better approach:** make `session.logger` a fresh pino instance (not a child) that:

1. Writes to a telemetry `Writable` pointing at `this.telemetryBuffer`
2. Also delegates to `appServer.logger` for BetterStack + console

This can be done cleanly with a passthrough: the telemetry stream captures entries into the
buffer AND forwards them to the parent logger, preserving all existing behavior.

#### 3. `handleTelemetryRequest` — read from `this.telemetryBuffer`

Replace the current `this.appServer.getTelemetryLogs(windowMs)` call with a direct read from
`this.telemetryBuffer`, filtered by `windowMs`.

#### 4. Remove `AppServer` telemetry buffer entirely

Remove from `AppServer`:

- `telemetryBuffer` private field
- `telemetryBufferSize` private field
- `enableTelemetry` / `telemetryBufferSize` config options
- `logTelemetry()` method
- `getTelemetryLogs()` method
- `clearTelemetryBuffer()` method
- The `clearTelemetryBuffer()` call in the disconnect handler

The buffer cleanup on disconnect is now free — `AppSession` is garbage collected when the
session ends, taking the buffer with it.

#### 5. Update exports

Remove `TelemetryLogEntry` etc. from `AppServer`-related exports. They remain exported from
`app-to-cloud.ts` for anyone who wants to type-check what they receive.

### Buffer Size Decision

500 entries at `info` level. At typical app verbosity (a few log lines per transcription event),
500 entries ≈ several minutes of session activity — more than enough for a bug report window.
`windowMs` from the cloud (currently 10 minutes / `600_000ms`) filters this further.

Debug-level entries are excluded from the telemetry buffer (too noisy, not useful for incident
debugging). BetterStack captures those separately.

### What Developers Get For Free

An app developer who writes:

```typescript
protected async onSession(session: AppSession) {
  session.events.onTranscription((data) => {
    session.logger.info({ words: data.text }, "Transcription received")
    // ... app logic
  })
}
```

Automatically gets that log line captured in the session's telemetry buffer and uploaded when
a user files a bug report. No `logTelemetry()` calls, no extra setup.

---

## Files to Change

| File                                     | Change                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `sdk/src/logging/telemetry-transport.ts` | **New** — pino Writable stream that fills a ring buffer                         |
| `sdk/src/app/session/index.ts`           | Add `telemetryBuffer`, rewire `session.logger`, update `handleTelemetryRequest` |
| `sdk/src/app/server/index.ts`            | Remove all telemetry buffer code                                                |
| `sdk/src/types/messages/cloud-to-app.ts` | No change needed                                                                |
| `sdk/src/index.ts`                       | Remove `AppServer` telemetry exports (types stay via `app-to-cloud.ts`)         |
| `sdk/src/types/index.ts`                 | Same cleanup                                                                    |

---

## Non-Goals

- This issue does NOT fix Comment 2 (cookie name mismatch) — that's a separate one-liner.
- This issue does NOT add telemetry to `AppServer`-level logs (startup, webhook handling).
  Those are server-wide events, already in Better Stack. Session logs are the right scope.

```

Now implement it — starting with the transport file, then the session changes, then stripping AppServer:
```
