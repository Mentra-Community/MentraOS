# SDK v2 → v3 Full API Surface Map

> **Status**: Draft — decisions captured from brainstorming, not yet specced.
> **Date**: 2025-07-17
> **Related**: [spike.md](./spike.md), 038-sdk-logging-dx

This document maps **every public API** on the v2 SDK to its v3 equivalent. It serves as the single source of truth for what changes, what moves, what's removed, and what's new.

Legend:

- ✅ **Keep** — same or trivially renamed
- 🔀 **Move** — relocated to a different manager/namespace
- 🔄 **Redesign** — same concept, new API shape
- 🆕 **New** — does not exist in v2
- ❌ **Remove** — dropped entirely
- ⚠️ **Deprecate** — still works in v3 with a warning, removed in v4

---

## Table of Contents

1. [MentraApp (HTTP server)](#1-mentraapp)
2. [MentraApp Config](#2-mentraapp-config)
3. [AppSession — Top-Level Properties](#3-appsession--top-level-properties)
4. [Transcription](#4-transcription)
5. [Translation](#5-translation)
6. [Display / Canvas](#6-display--canvas)
7. [Camera](#7-camera)
8. [Audio (output)](#8-audio-output)
9. [Mic (input)](#9-mic-input)
10. [Location](#10-location)
11. [Device](#11-device)
12. [Permissions](#12-permissions)
13. [LED](#13-led)
14. [Settings (deprecated) → Storage](#14-settings-deprecated--storage)
15. [Storage](#15-storage)
16. [Dashboard](#16-dashboard)
17. [System Events](#17-system-events)
18. [Hardware / Input Events](#18-hardware--input-events)
19. [Phone](#19-phone)
20. [App-to-App Communication](#20-app-to-app-communication)
21. [Connection / Lifecycle](#21-connection--lifecycle)
22. [Low-Level / Escape Hatch](#22-low-level--escape-hatch)
23. [Types & Language Codes](#23-types--language-codes)
24. [Route Namespacing](#24-route-namespacing)
25. [Decisions Log](#25-decisions-log)
26. [Open Questions](#26-open-questions)

---

## 1. MentraApp

### Key decision: callback pattern, not class inheritance

TypeScript devs don't extend classes. Express, Hono, Discord.js, Socket.io — they all use callbacks. The v3 SDK follows this convention.

| v2                                      | v3                                                                         | Status          |
| --------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| `class MyApp extends AppServer { ... }` | `const app = new MentraApp(config)`                                        | 🔄 **Redesign** |
| `new MyApp(config)`                     | `new MentraApp(config)`                                                    | 🔄 Rename       |
| `server.start()`                        | `app.start()`                                                              | ✅ Keep         |
| `server.stop()`                         | `app.stop()`                                                               | ✅ Keep         |
| `server.getExpressApp()`                | ❌ Removed — `MentraApp` IS a Hono app under the hood, add routes directly | ❌ Remove       |

### Hooks: override → callback

| v2                                                     | v3                                      | Status      |
| ------------------------------------------------------ | --------------------------------------- | ----------- |
| `protected onSession(session, sessionId, userId)`      | `app.onSession((session) => { ... })`   | 🔄 Redesign |
| `protected onStop(session, sessionId, userId, reason)` | `app.onStop((session) => { ... })`      | 🔄 Redesign |
| `protected onToolCall(toolCall)`                       | `app.onToolCall((toolCall) => { ... })` | 🔄 Redesign |

All hooks are **single handler** (last registration wins). `session.userId` and `session.getSessionId()` are already on the session object — no need for extra params.

### v2 vs v3 full example

```typescript
// ─── v2 (class inheritance) ──────────────────────
class MyApp extends AppServer {
  protected async onSession(session: AppSession, sessionId: string, userId: string) {
    session.events.onTranscription((data) => {
      session.layouts.showTextWall(data.text)
    })
  }
  protected async onStop(session: AppSession, sessionId: string, userId: string) {
    console.log("bye")
  }
}
const server = new MyApp({packageName: "com.example.app", apiKey: "xxx"})
await server.start()

// ─── v3 (callback composition) ───────────────────
import {MentraApp} from "@mentra/sdk"

const app = new MentraApp({packageName: "com.example.app", apiKey: "xxx"})

app.onSession((session) => {
  session.transcription.on((data) => {
    session.display.showText(data.text)
  })
})

app.onStop((session) => {
  console.log("bye")
})

await app.start()
```

### Custom routes

`MentraApp` extends Hono internally — devs add routes directly on the app instance:

```typescript
const app = new MentraApp({ ... });

// Custom routes — MentraApp IS a Hono app under the hood
app.get('/status', (c) => c.json({ ok: true }));
app.use('/public/*', serveStatic({ root: './public' }));

await app.start();
```

---

## 2. MentraApp Config

| Field             | v2                                        | v3                                   | Status    |
| ----------------- | ----------------------------------------- | ------------------------------------ | --------- |
| `packageName`     | `string` (required)                       | `string` (required)                  | ✅ Keep   |
| `apiKey`          | `string` (required)                       | `string` (required)                  | ✅ Keep   |
| `port`            | `number` (default 7010)                   | `number` (default 7010)              | ✅ Keep   |
| `logLevel`        | `MentraLogLevel`                          | `MentraLogLevel` (from 038)          | ✅ Keep   |
| `verbose`         | `boolean`                                 | `boolean` (from 038)                 | ✅ Keep   |
| `cloudApiUrl`     | `string` (deprecated)                     | —                                    | ❌ Remove |
| `webhookPath`     | `string` (deprecated, default '/webhook') | —                                    | ❌ Remove |
| `publicDir`       | `string \| false`                         | — (one-line Hono middleware instead) | ❌ Remove |
| `healthCheck`     | `boolean`                                 | — (one-line Hono route instead)      | ❌ Remove |
| `cookieSecret`    | `string`                                  | — (webview concern, not core SDK)    | ❌ Remove |
| `appInstructions` | `string` (deprecated)                     | —                                    | ❌ Remove |

**v3 config is minimal:**

```typescript
const app = new MentraApp({
  packageName: "com.example.app",
  apiKey: "xxx",
  port: 7010, // optional, default 7010
  logLevel: "warn", // optional, from 038
  verbose: false, // optional, from 038
})
```

---

## 3. AppSession — Top-Level Properties

| v2 accessor             | v3 accessor                                               | Status                               |
| ----------------------- | --------------------------------------------------------- | ------------------------------------ |
| `session.events`        | ⚠️ `session.events` (deprecated escape hatch, see §22)    | ⚠️ Deprecate                         |
| `session.layouts`       | `session.display`                                         | 🔀 Rename                            |
| `session.settings`      | ⚠️ `session.settings` (deprecated, use `session.storage`) | ⚠️ Deprecate                         |
| `session.dashboard`     | `session.dashboard` (redesigned — see §16)                | 🔄 Redesign                          |
| `session.location`      | `session.location`                                        | ✅ Keep                              |
| `session.camera`        | `session.camera`                                          | ✅ Keep                              |
| `session.led`           | `session.led`                                             | ✅ Keep                              |
| `session.audio`         | `session.audio` (OUTPUT only — playback, TTS)             | ✅ Keep                              |
| `session.simpleStorage` | `session.storage`                                         | 🔀 Rename                            |
| `session.device`        | `session.device`                                          | ✅ Keep                              |
| `session.userId`        | `session.userId`                                          | ✅ Keep                              |
| `session.logger`        | `session.logger`                                          | ✅ Keep                              |
| `session.capabilities`  | `session.device.capabilities`                             | 🔀 Move                              |
| —                       | `session.transcription`                                   | 🆕 New manager                       |
| —                       | `session.translation`                                     | 🆕 New manager (v3.1)                |
| —                       | `session.mic`                                             | 🆕 New manager (audio INPUT)         |
| —                       | `session.phone`                                           | 🆕 New manager                       |
| —                       | `session.permissions`                                     | 🆕 New manager                       |
| —                       | `session.time`                                            | 🆕 New (timezone + formatting utils) |

---

## 3a. session.time — Timezone & Formatting Utils

🆕 **New in v3.** Lightweight namespace for timezone access and date/time formatting. Not a full manager — no lifecycle, no events, no cleanup. Just stateless utils bound to the user's timezone.

### Why

Currently the Dashboard mini app does 12 lines of boilerplate every time it needs to format a time:

```typescript
// v2 — painful
const userTimezone = session.settings.getMentraOS<string>("userTimezone")
const timezone = userTimezone || sessionInfo.latestLocation?.timezone
if (timezone) {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }
  let formatted = new Date().toLocaleString("en-US", options)
}
```

Every app that needs time does this. The session already knows the user's timezone — just expose it.

### v3 API

```typescript
// The IANA timezone string
session.time.zone // 'America/New_York'

// Current time in user's timezone
session.time.now() // Date

// Convert any UTC date to user's local
session.time.toLocal(date) // Date

// Format a date in user's timezone (wraps Intl.DateTimeFormat)
session.time.format(date) // '3:45 PM'
session.time.format(date, {dateStyle: "short"}) // '7/17/25'
session.time.format(date, {
  hour: "2-digit",
  minute: "2-digit",
  month: "numeric",
  day: "numeric",
  hour12: true,
}) // '7/17, 3:45 PM'
```

### Usage

```typescript
// Show a meeting time in user's local time
const meetingUtc = new Date("2025-07-17T20:00:00Z")
const localTime = session.time.format(meetingUtc, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
})
session.display.showText(`Meeting at ${localTime}`)
// → "Meeting at 4:00 PM" (if user is in EDT)
```

Timezone is resolved from: user setting (`userTimezone`) → GPS-derived timezone → fallback.

---

## 3b. session.display — Text Formatting Integration

`session.display` integrates with `@mentra/display-utils` automatically. The session knows the device profile (G1, Nex, etc.) — developers don't need to manually create toolkits or pick profiles.

### showText accepts `string | string[]`

```typescript
// Simple string — auto-wraps for current device
session.display.showText("Very long text that will be wrapped automatically")

// Pre-wrapped array — sends as-is
session.display.showText(["Line 1", "Line 2", "Line 3"])
```

### wrap() — pure formatting, returns string[]

```typescript
// Wrap text for current device (doesn't display, just returns lines)
const lines = session.display.wrap("Long text...")
// → ["Long text that has been", "wrapped to fit the screen"]

// Pass results to showText:
session.display.showText(session.display.wrap(longText))

// Manipulate first:
const lines = session.display.wrap(longText)
session.display.showText(lines.slice(-3)) // show last 3 lines only

// Options:
session.display.wrap(text, {maxLines: 5}) // cap at 5 lines
session.display.wrap(text, {maxLines: 1}) // single line (truncate)
session.display.wrap(text, {breakMode: "word"}) // word-break
session.display.wrap(text, {width: 0.5}) // 50% of screen width
```

### Device info (read-only)

```typescript
session.display.maxLines // 5 (G1), varies per device
session.display.widthPx // 576 (G1), varies per device
session.display.profile // full DisplayProfile object
```

### ScrollView

```typescript
const scroll = session.display.createScrollView()
scroll.setContent("Very long scrollable content...")

// On gesture:
scroll.scrollDown()
session.display.showText(scroll.getViewport().lines)
```

### Architecture

`@mentra/display-utils` stays as a standalone package (cloud and mobile use it directly). `session.display` wraps it with session context so SDK developers don't need to import it or pick profiles manually.

---

## 4. Transcription

### Key decisions

- **Auto-detect is the default** — no language required. Soniox handles it.
- **Language codes are ISO 639-1** (`en`, `ja`, `es`) — not BCP-47 (`en-US`, `ja-JP`). Azure-era `en-US` format is dropped from the SDK API.
- **`languageHints`** replaces `hints` / `preferredLanguages` / `disableLanguageIdentification` — one clear concept: advisory input to improve accuracy, not a filter.
- **`vocabulary`** for custom domain terms — currently hardcoded in Soniox config, should be configurable per-app.
- **API is provider-agnostic** — same interface works for cloud (Soniox), future local SDK (Whisper, etc.).

### v2 → v3

| v2                                                                                | v3                                                                           | Status      |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| `session.events.onTranscription(handler)`                                         | `session.transcription.on(handler)`                                          | 🔄 Redesign |
| `session.events.onTranscriptionForLanguage(lang, handler, opts)`                  | `session.transcription.on(handler)` + `session.transcription.configure(...)` | 🔄 Redesign |
| `session.events.onStream("transcription:en-US?hints=ja", handler)`                | `session.transcription.on(handler)` + `session.transcription.configure(...)` | 🔄 Redesign |
| `session.subscribe("transcription:en-US")` + `session.events.addHandler(...)`     | `session.transcription.on(handler)` (managed internally)                     | 🔄 Redesign |
| `session.onTranscription(handler)` (deprecated wrapper)                           | `session.transcription.on(handler)`                                          | 🔄 Redesign |
| `session.onTranscriptionForLanguage(lang, handler, disable)` (deprecated wrapper) | `session.transcription.on(handler)`                                          | 🔄 Redesign |
| —                                                                                 | `session.transcription.onLanguage(lang, handler)`                            | 🆕 New      |
| —                                                                                 | `session.transcription.configure(opts)`                                      | 🆕 New      |
| —                                                                                 | `session.transcription.stop()`                                               | 🆕 New      |

### v3 TranscriptionManager API

```typescript
interface TranscriptionConfig {
  /** Language hints — advisory input for accuracy, NOT filters.
   *  Uses ISO 639-1 codes: 'en', 'ja', 'es', etc.
   *  Default: auto-detect (no hints). */
  languageHints?: string[]

  /** Custom vocabulary for better recognition of domain-specific terms.
   *  e.g., ['MentraOS', 'HIPAA', 'kubectl'] */
  vocabulary?: string[]

  /** Enable/disable speaker diarization.
   *  Default: true (Soniox gives it for free). */
  diarization?: boolean
}

interface TranscriptionEvent {
  text: string
  isFinal: boolean
  language: string // ISO 639-1 detected language ('en', 'ja', etc.)
  speakerId?: string // '1', '2', etc. (from diarization)
  utteranceId?: string // groups interim + final for same utterance
  confidence?: number // 0-1
  startTime: number // ms
  endTime: number // ms
  duration?: number // ms
  metadata?: TranscriptionMetadata // provider-specific token-level data
}

class TranscriptionManager {
  /** Subscribe to all transcription events (auto-detect mode by default). */
  on(handler: (data: TranscriptionEvent) => void): () => void

  /** Subscribe to transcription events for a specific language only.
   *  Filters on detectedLanguage (best-effort, not a hard guarantee).
   *  Matches on base language: onLanguage('en') matches 'en', 'en-US', etc. */
  onLanguage(lang: string, handler: (data: TranscriptionEvent) => void): () => void

  /** Configure transcription preferences. Can be called mid-session.
   *  Internally re-subscribes with new options — transparent to handlers. */
  configure(config: TranscriptionConfig): void

  /** Stop transcription and unsubscribe all handlers. */
  stop(): void
}
```

### Usage examples

```typescript
// Simplest — zero config, auto-detect, diarization included
session.transcription.on((data) => {
  console.log(`[${data.language}] ${data.speakerId}: ${data.text}`)
})

// Language-specific handlers (composable)
session.transcription.onLanguage("ja", (data) => {
  showOnRightPanel(data.text)
})
session.transcription.onLanguage("en", (data) => {
  showOnLeftPanel(data.text)
})

// Configure hints (all optional)
session.transcription.configure({
  languageHints: ["en", "ja"],
  vocabulary: ["MentraOS", "Soniox"],
})

// Change hints mid-session (handler keeps working)
session.transcription.configure({languageHints: ["fr", "de"]})

// Stop
session.transcription.stop()
```

---

## 5. Translation

### Key decisions

- **Translation stays a separate manager** from transcription — different enough concept, different provider paths, future local SDK may handle translation differently.
- **Needs its own spike** — Soniox has two-way pairs, one-way universal, and one-to-many is multiple streams. Too many unknowns to design the full API now.
- **Do not ship translation manager redesign in v3.0** — ship it in v3.1 after a dedicated spike.

### v2 → v3 (interim)

| v2                                                                 | v3.0 (interim)                   | v3.1+ (after spike)                              | Status       |
| ------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------ | ------------ |
| `session.events.ontranslationForLanguage(src, tgt, handler, opts)` | ⚠️ Kept with deprecation warning | `session.translation.to(lang).on(handler)` (TBD) | ⚠️ Deprecate |
| `session.onTranslationForLanguage(src, tgt, handler)`              | ⚠️ Kept with deprecation warning | `session.translation.to(lang).on(handler)` (TBD) | ⚠️ Deprecate |

### v3.1+ Translation spike topics

- [ ] Soniox two-way pairs vs. one-way: accuracy/cost tradeoffs
- [ ] One-to-many (en→[es,ja,fr]) — single stream or multiple?
- [ ] Bidirectional conversation UI pattern
- [ ] `session.translation.to(lang)` vs `session.translation.between(langA, langB)` vs `session.translation.configure({...})`
- [ ] ISO 639-1 codes for translation
- [ ] Provider-agnostic design for future local translation

---

## 6. Display / Canvas

`session.layouts` → `session.display`

### High-level convenience methods (work on all glasses including G1)

| v2                                                                     | v3                                                      | Status      |
| ---------------------------------------------------------------------- | ------------------------------------------------------- | ----------- |
| `session.layouts.showTextWall(text, opts?)`                            | `session.display.showText(text, opts?)`                 | 🔄 Rename   |
| `session.layouts.showDoubleTextWall(top, bottom, opts?)`               | `session.display.showDoubleText(top, bottom, opts?)`    | 🔄 Rename   |
| `session.layouts.showReferenceCard(title, text, opts?)`                | `session.display.showCard({ title, body }, opts?)`      | 🔄 Redesign |
| `session.layouts.showDashboardCard(left, right, opts?)`                | `session.display.showDashboardCard(left, right, opts?)` | ✅ Keep     |
| `session.layouts.showBitmapView(data, opts?)`                          | `session.display.showBitmap(data, opts?)`               | 🔄 Rename   |
| `session.layouts.showBitmapAnimation(frames, interval, repeat, opts?)` | `session.display.showAnimation(frames, opts?)`          | 🔄 Redesign |
| `session.layouts.clearView(opts?)`                                     | `session.display.clear(opts?)`                          | 🔄 Rename   |

### v3 Canvas system (future glasses — NOT G1)

The key innovation: **double buffering over a network** to hide cloud→glasses latency.

| Concept                                       | What it does                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `createCanvas()`                              | Allocate an offscreen buffer                                         |
| Draw calls (`.text()`, `.rect()`, `.image()`) | Modify the buffer in memory                                          |
| `prepare(canvas)`                             | Send buffer to glasses memory — pre-render, NOT visible yet          |
| `show(canvas)`                                | Flip — make this buffer the active display (instant if pre-rendered) |
| `update(canvas, region)`                      | Partial update — only re-send a dirty rectangle                      |

```typescript
// ─── High-level convenience (all glasses) ─────────────
session.display.showText("Hello world")
session.display.showCard({title: "Weather", body: "72°F"})
session.display.clear()

// ─── Canvas system (future glasses) ──────────────────
const canvas = session.display.createCanvas()

// Draw to offscreen buffer (nothing visible yet)
canvas.text(10, 20, "Hello world", {font: "mono", size: 16})
canvas.rect(0, 0, 200, 50, {stroke: "white"})
canvas.image(myBitmap, 50, 50)

// Pre-render: send to glasses memory without displaying
await session.display.prepare(canvas)

// ... later, when ready to show ...
session.display.show(canvas) // instant flip — data already on glasses

// Partial update — only re-send dirty region
canvas.text(10, 20, "Updated!", {font: "mono", size: 16})
await session.display.update(canvas, {x: 0, y: 10, w: 200, h: 30})

// Multiple buffers for instant switching
const screenA = session.display.createCanvas()
const screenB = session.display.createCanvas()
// ... draw to both ...
await session.display.prepare(screenA)
await session.display.prepare(screenB)
session.display.show(screenA) // instant
// later...
session.display.show(screenB) // instant
```

### G1 compatibility

High-level methods (`showText`, `showCard`, etc.) continue to work on G1 — they use the existing text wall protocol internally. Canvas API either falls back to bitmap rendering on G1 or warns that canvas isn't supported.

### Canvas API scope

Keep it minimal: `text`, `rect`, `line`, `image`, `circle`. If devs need complex rendering, they render to a bitmap externally and use `canvas.image()`.

> **Note**: Canvas API depends on firmware capabilities of MentraOS glasses (in development). The exact draw call API will be specced alongside firmware.

---

## 7. Camera

Camera module stays at `session.camera`. The API is already reasonably clean.

| v2                                              | v3                                                                         | Status                |
| ----------------------------------------------- | -------------------------------------------------------------------------- | --------------------- |
| `session.camera.requestPhoto(opts?)`            | `session.camera.takePhoto(opts?)`                                          | 🔄 Rename             |
| `session.camera.startStream(rtmpOpts)`          | `session.camera.startStream(rtmpOpts)`                                     | ✅ Keep               |
| `session.camera.stopStream()`                   | `session.camera.stopStream()`                                              | ✅ Keep               |
| `session.camera.isCurrentlyStreaming()`         | `session.camera.isStreaming()`                                             | 🔄 Rename             |
| `session.camera.getCurrentStreamUrl()`          | `session.camera.getStreamUrl()`                                            | 🔄 Rename             |
| `session.camera.getStreamStatus()`              | `session.camera.getStreamStatus()`                                         | ✅ Keep               |
| `session.camera.onStreamStatus(handler)`        | `session.camera.onStreamStatus(handler)`                                   | ✅ Keep               |
| `session.camera.startManagedStream(opts?)`      | `session.camera.startManagedStream(opts?)`                                 | ✅ Keep               |
| `session.camera.stopManagedStream()`            | `session.camera.stopManagedStream()`                                       | ✅ Keep               |
| `session.camera.onManagedStreamStatus(handler)` | `session.camera.onManagedStreamStatus(handler)`                            | ✅ Keep               |
| `session.camera.isManagedStreamActive()`        | `session.camera.isManagedStreamActive()`                                   | ✅ Keep               |
| `session.camera.getManagedStreamUrls()`         | `session.camera.getManagedStreamUrls()`                                    | ✅ Keep               |
| `session.camera.checkExistingStream()`          | `session.camera.checkExistingStream()`                                     | ✅ Keep               |
| `session.events.onPhotoTaken(handler)`          | `session.camera.onPhotoTaken(handler)`                                     | 🔀 Move               |
| `session.camera.hasPhotoPendingRequest(id?)`    | (internal — not public API)                                                | ❌ Remove from public |
| `session.camera.cancelPhotoRequest(id)`         | (internal — not public API)                                                | ❌ Remove from public |
| `session.camera.cancelAllPhotoRequests()`       | (internal — not public API)                                                | ❌ Remove from public |
| —                                               | `session.camera.hasPermission` → reads `session.permissions.has('camera')` | 🆕 New                |

---

## 8. Audio (output)

`session.audio` is OUTPUT only — playing audio on glasses speakers.

| v2                                       | v3                                 | Status                |
| ---------------------------------------- | ---------------------------------- | --------------------- |
| `session.audio.playAudio(opts)`          | `session.audio.play(opts)`         | 🔄 Rename             |
| `session.audio.stopAudio(trackId?)`      | `session.audio.stop(trackId?)`     | 🔄 Rename             |
| `session.audio.speak(text, opts?)`       | `session.audio.speak(text, opts?)` | ✅ Keep               |
| `session.audio.hasPendingRequest(id?)`   | (internal)                         | ❌ Remove from public |
| `session.audio.getPendingRequestCount()` | (internal)                         | ❌ Remove from public |
| `session.audio.getPendingRequestIds()`   | (internal)                         | ❌ Remove from public |
| `session.audio.cancelAudioRequest(id)`   | (internal)                         | ❌ Remove from public |
| `session.audio.cancelAllAudioRequests()` | (internal)                         | ❌ Remove from public |

---

## 9. Mic (input)

🆕 **New in v3.** Separates audio INPUT (microphone) from audio OUTPUT (speakers).

| v2                                        | v3                                                                          | Status                               |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| `session.events.onAudioChunk(handler)`    | `session.mic.onChunk(handler)`                                              | 🔀 Move                              |
| `session.events.onVoiceActivity(handler)` | `session.mic.onVoiceActivity(handler)`                                      | 🔀 Move                              |
| —                                         | `session.mic.isSpeaking`                                                    | 🆕 New (boolean — VAD state)         |
| —                                         | `session.mic.isActive`                                                      | 🆕 New (boolean — is mic streaming?) |
| —                                         | `session.mic.hasPermission` → reads `session.permissions.has('microphone')` | 🆕 New                               |

### v3 MicManager API

```typescript
class MicManager {
  /** Raw audio chunk subscription. */
  onChunk(handler: (chunk: AudioChunk) => void): () => void

  /** Voice activity detection events. */
  onVoiceActivity(handler: (vad: Vad) => void): () => void

  /** Is someone currently speaking? (from VAD) */
  readonly isSpeaking: boolean

  /** Is the microphone actively streaming? */
  readonly isActive: boolean

  /** Does this app have microphone permission? */
  readonly hasPermission: boolean // reads from session.permissions
}
```

### Rationale

- `session.audio` = OUTPUT (play audio, TTS) — speakers
- `session.mic` = INPUT (audio chunks, VAD) — microphone
- `session.transcription` is a higher-level consumer of mic data — mic captures audio → cloud processes → transcription events

---

## 10. Location

`session.location` is a **top-level manager** — not under `session.phone`.

### Key decisions

- **Cached read-only values** — `session.location.lat` / `.lng` are always available (last known value or `null`). No async `getLatest()` needed.
- **`onUpdate()` for reactive subscription** — get notified when location changes.
- **`hasPermission`** reads from `session.permissions`.
- Accuracy tiers stay (they map to platform capabilities).

| v2                                                          | v3                                                                                         | Status                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| `session.location.subscribeToStream({ accuracy }, handler)` | `session.location.onUpdate(handler)` or `session.location.onUpdate({ accuracy }, handler)` | 🔄 Redesign               |
| `session.location.unsubscribeFromStream()`                  | `session.location.stop()`                                                                  | 🔄 Rename                 |
| `session.location.getLatestLocation({ accuracy })`          | `session.location.lat` / `.lng` (cached) or `session.location.requestUpdate({ accuracy })` | 🔄 Redesign               |
| `session.events.onLocation(handler)`                        | `session.location.onUpdate(handler)`                                                       | 🔀 Move                   |
| —                                                           | `session.location.lat`                                                                     | 🆕 New (cached read-only) |
| —                                                           | `session.location.lng`                                                                     | 🆕 New (cached read-only) |
| —                                                           | `session.location.accuracy`                                                                | 🆕 New (cached read-only) |
| —                                                           | `session.location.timestamp`                                                               | 🆕 New (cached read-only) |
| —                                                           | `session.location.hasPermission` → reads `session.permissions.has('location')`             | 🆕 New                    |

### v3 LocationManager API

```typescript
type LocationAccuracy =
  | "standard"
  | "high"
  | "realtime"
  | "tenMeters"
  | "hundredMeters"
  | "kilometer"
  | "threeKilometers"
  | "reduced"

class LocationManager {
  /** Last known latitude (null if no location received yet). */
  readonly lat: number | null

  /** Last known longitude (null if no location received yet). */
  readonly lng: number | null

  /** Last known accuracy in meters (null if unknown). */
  readonly accuracy: number | null

  /** Timestamp of last location update (null if none). */
  readonly timestamp: number | null

  /** Does this app have location permission? */
  readonly hasPermission: boolean // reads from session.permissions

  /** Subscribe to continuous location updates. */
  onUpdate(handler: (loc: LocationUpdate) => void): () => void
  onUpdate(opts: {accuracy: LocationAccuracy}, handler: (loc: LocationUpdate) => void): () => void

  /** Request a fresh location fix (one-shot). Updates cached values on response. */
  requestUpdate(opts?: {accuracy?: LocationAccuracy}): Promise<LocationUpdate>

  /** Stop location updates and unsubscribe all handlers. */
  stop(): void
}
```

---

## 11. Device

`session.device` stays. Gains `capabilities` (moved from session-level). The reactive Observable pattern is kept.

### Key decisions

- **Flattened** — `session.device.state.X` → `session.device.X` (remove `.state.` nesting).
- **`session.capabilities`** → `session.device.capabilities` (it's a property of the device).

| v2                                                 | v3                                                           | Status                     |
| -------------------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| `session.device.state.wifiConnected`               | `session.device.wifiConnected`                               | 🔀 Flatten                 |
| `session.device.state.wifiSsid`                    | `session.device.wifiSsid`                                    | 🔀 Flatten                 |
| `session.device.state.batteryLevel`                | `session.device.batteryLevel`                                | 🔀 Flatten                 |
| `session.device.state.charging`                    | `session.device.charging`                                    | 🔀 Flatten                 |
| `session.device.state.caseBatteryLevel`            | `session.device.caseBatteryLevel`                            | 🔀 Flatten                 |
| `session.device.state.caseCharging`                | `session.device.caseCharging`                                | 🔀 Flatten                 |
| `session.device.state.caseOpen`                    | `session.device.caseOpen`                                    | 🔀 Flatten                 |
| `session.device.state.caseRemoved`                 | `session.device.caseRemoved`                                 | 🔀 Flatten                 |
| `session.device.state.hotspotEnabled`              | `session.device.hotspotEnabled`                              | 🔀 Flatten                 |
| `session.device.state.hotspotSsid`                 | `session.device.hotspotSsid`                                 | 🔀 Flatten                 |
| `session.device.state.connected`                   | `session.device.connected`                                   | 🔀 Flatten                 |
| `session.device.state.modelName`                   | `session.device.modelName`                                   | 🔀 Flatten                 |
| `session.device.state.getSnapshot()`               | `session.device.getSnapshot()`                               | 🔀 Flatten                 |
| `session.capabilities`                             | `session.device.capabilities`                                | 🔀 Move                    |
| `session.events.onGlassesBattery(handler)`         | `session.device.batteryLevel.onChange(handler)` (Observable) | 🔀 Move                    |
| `session.events.onGlassesConnectionState(handler)` | `session.device.connected.onChange(handler)` (Observable)    | 🔀 Move                    |
| `session.getWifiStatus()`                          | `session.device.wifiConnected.value`                         | ❌ Remove (use Observable) |
| `session.isWifiConnected()`                        | `session.device.wifiConnected.value`                         | ❌ Remove (use Observable) |
| `session.requestWifiSetup(ssid, pass)`             | `session.device.requestWifiSetup(ssid, pass)`                | 🔀 Move                    |

### Rationale for flattening

`session.device.state.batteryLevel` is one `.state.` too deep. DeviceState IS the device manager — no reason for the extra nesting:

```typescript
// v2
session.device.state.batteryLevel.onChange((level) => { ... });

// v3
session.device.batteryLevel.onChange((level) => { ... });
```

---

## 12. Permissions

🆕 **New in v3.** Centralized permissions manager — single source of truth for all app permissions.

### Key decisions

- **One central place** to check all permissions instead of scattered `.hasPermission` booleans.
- Individual managers expose `.hasPermission` as a **convenience getter** that reads from `session.permissions`.
- Single-capability managers (mic, camera, location) → `.hasPermission` on the manager itself.
- Multi-capability managers (phone) → `.hasPermission` on the sub-scope (e.g., `session.phone.notifications.hasPermission`).

### v3 PermissionsManager API

```typescript
class PermissionsManager {
  /** Check if the app has a specific permission. */
  has(permission: PermissionType): boolean

  /** Get all permissions as a map. */
  getAll(): Record<PermissionType, boolean>

  /** Subscribe to permission changes. */
  onUpdate(handler: (permissions: Record<PermissionType, boolean>) => void): () => void
}

type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar"
```

### Usage

```typescript
// Central check
if (session.permissions.has('location')) {
  session.location.onUpdate((loc) => { ... });
}

// Convenience — same thing via manager
if (session.location.hasPermission) {
  session.location.onUpdate((loc) => { ... });
}

// React to permission changes
session.permissions.onUpdate((perms) => {
  if (!perms.location) {
    session.display.showText('Please enable location in MentraOS settings');
  }
});

// Check everything at once
const perms = session.permissions.getAll();
// { location: true, microphone: true, camera: false, notifications: true, calendar: false }
```

---

## 13. LED

`session.led` stays unchanged. The API is already clean.

| v2                                         | v3                                         | Status  |
| ------------------------------------------ | ------------------------------------------ | ------- |
| `session.led.turnOn(opts)`                 | `session.led.turnOn(opts)`                 | ✅ Keep |
| `session.led.turnOff()`                    | `session.led.turnOff()`                    | ✅ Keep |
| `session.led.blink(color, on, off, count)` | `session.led.blink(color, on, off, count)` | ✅ Keep |
| `session.led.solid(color, duration)`       | `session.led.solid(color, duration)`       | ✅ Keep |
| `session.led.getCapabilities()`            | `session.led.getCapabilities()`            | ✅ Keep |

---

## 14. Settings (deprecated) → Storage

### Key decision: Settings is deprecated in favor of Storage

The app settings system (dev-defined schemas in dev console, user-configured values) is deprecated. Devs should use `session.storage` for any metadata they want to persist.

| v2                                                                     | v3                                                          | Status              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------- |
| `session.settings.get(key, default?)`                                  | ⚠️ Deprecated — use `session.storage.get(key)`              | ⚠️ Deprecate        |
| `session.settings.getAll()`                                            | ⚠️ Deprecated — use `session.storage.getAll()`              | ⚠️ Deprecate        |
| `session.settings.has(key)`                                            | ⚠️ Deprecated — use `session.storage.has(key)`              | ⚠️ Deprecate        |
| `session.settings.getSetting(key)`                                     | ⚠️ Deprecated                                               | ⚠️ Deprecate        |
| `session.settings.onChange(handler)`                                   | ⚠️ Deprecated                                               | ⚠️ Deprecate        |
| `session.settings.onValueChange(key, handler)`                         | ⚠️ Deprecated                                               | ⚠️ Deprecate        |
| `session.settings.fetch()`                                             | ⚠️ Deprecated                                               | ⚠️ Deprecate        |
| `session.settings.getMentraOS(key, default?)`                          | TBD — MentraOS system settings may move to `session.device` | ❓ Open             |
| `session.settings.onMentraosChange(key, handler)`                      | TBD — same as above                                         | ❓ Open             |
| `session.settings.onMentraosSettingsChange(key, handler)` (deprecated) | —                                                           | ❌ Remove           |
| `session.settings.getMentraosSetting(key, default?)` (duplicate)       | —                                                           | ❌ Remove           |
| `session.events.onSettingsUpdate(handler)`                             | —                                                           | ❌ Remove duplicate |
| `session.events.onSettingChange(key, handler)`                         | —                                                           | ❌ Remove duplicate |
| `session.getSettings()` (deprecated)                                   | —                                                           | ❌ Remove           |
| `session.getSetting(key)` (deprecated)                                 | —                                                           | ❌ Remove           |

> **Open question**: MentraOS system settings (`metricSystemEnabled`, `brightness`, etc.) are OS-level, not app-defined. Do they move to `session.device`? Or stay accessible somewhere else?

---

## 15. Storage

`session.simpleStorage` → `session.storage`. Now also replaces app settings for dev-stored metadata.

| v2                                        | v3                                  | Status           |
| ----------------------------------------- | ----------------------------------- | ---------------- |
| `session.simpleStorage.get(key)`          | `session.storage.get(key)`          | 🔀 Rename parent |
| `session.simpleStorage.set(key, value)`   | `session.storage.set(key, value)`   | 🔀 Rename parent |
| `session.simpleStorage.delete(key)`       | `session.storage.delete(key)`       | 🔀 Rename parent |
| `session.simpleStorage.clear()`           | `session.storage.clear()`           | 🔀 Rename parent |
| `session.simpleStorage.keys()`            | `session.storage.keys()`            | 🔀 Rename parent |
| `session.simpleStorage.size()`            | `session.storage.size()`            | 🔀 Rename parent |
| `session.simpleStorage.hasKey(key)`       | `session.storage.has(key)`          | 🔀 Rename        |
| `session.simpleStorage.getAllData()`      | `session.storage.getAll()`          | 🔀 Rename        |
| `session.simpleStorage.setMultiple(data)` | `session.storage.setMultiple(data)` | 🔀 Rename parent |
| `session.simpleStorage.flush()`           | `session.storage.flush()`           | 🔀 Rename parent |

---

## 16. Dashboard

### Key decision: Dashboard is an OS service, not a mini app

The Dashboard mini app is killed. Dashboard becomes a first-class OS service on `UserSession` in the cloud. The cloud already has all the data it needs — there's no reason for a separate deployed service to round-trip through the SDK.

### What dies

- **The entire Dashboard mini app** (~1200 lines, separate repo/deploy)
- **`session.dashboard.system?.setTopLeft()` / `setTopRight()` / etc.** — the 4-quadrant system section API
- **`SYSTEM_DASHBOARD_PACKAGE_NAME`** — no more privileged system app concept
- **`DashboardMode` (main/expanded/alwaysOn)** — no modes for now, just one dashboard
- **`session.dashboard.content.write(content, targets)`** — replaced with simpler API
- **`session.dashboard.content.writeToMain()` / `writeToExpanded()`** — no modes
- **`session.dashboard.content.getCurrentMode()` / `onModeChange()`** — no modes

### What moves into the cloud OS

The cloud already has all this data. No mini app needed to fetch/format it:

| Data                       | Was fetched by Dashboard mini app                | Now owned by                                     |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Time / timezone            | Mini app formatted with `userTimezone` setting   | Cloud `UserSession` (already has `userTimezone`) |
| Battery                    | Mini app subscribed to `GLASSES_BATTERY_UPDATE`  | Cloud `DeviceState` (already has it)             |
| Weather                    | Mini app called OpenWeatherMap API               | Cloud-level weather service (new)                |
| Notifications              | Mini app subscribed to phone notification events | Cloud already routes phone events                |
| Calendar                   | Mini app subscribed to calendar events           | Cloud already routes calendar events             |
| Location                   | Mini app subscribed to location stream           | Cloud `LocationManager` (already has it)         |
| Notification summarization | LLM agent in mini app                            | Cloud-level OS capability (new)                  |

### Cloud renders the dashboard directly

The cloud's `DashboardManager` (on `UserSession`) composes the dashboard layout using display utils and sends it as a `TextWall` to `ViewType.DASHBOARD`. The glasses just render what they're told.

```
Event arrives (battery update, notification, calendar, etc.)
  → DashboardManager on UserSession updates internal state
  → DashboardManager uses display utils to compose a TextWall
  → Sends DisplayRequest { view: ViewType.DASHBOARD, layout: TextWall }
  → Glasses render it
```

#### Dashboard layout on G1

System info in a 1-line header (split left/right), full-width body below for notifications + app content:

```
┌─────────────────────────────────────────────┐
│ ◌ 7/17, 3:45  🔋82%     │    Clear, 75°F   │  ← system bar (OS-owned)
│─────────────────────────────────────────────│
│ Mom: Can you pick up milk on the way home?  │  ← full width (OS notifications)
│ John: Hey running late to dinner tonight    │  ← full width (OS notifications)
│ Route 42 arriving in 5 min                  │  ← full width (app content)
│ AAPL +2.3%                                  │  ← full width (app content)
└─────────────────────────────────────────────┘
```

- Top right: calendar event takes priority over weather when present
- Body: OS decides ordering/priority — notifications + app content share the space
- Cloud composes this as a single `TextWall` using display utils, sends to `ViewType.DASHBOARD`
- No more `DoubleTextWall` quadrant bugs (character overflow between sides)

### v2 → v3

| v2                                                   | v3                                 | Status      |
| ---------------------------------------------------- | ---------------------------------- | ----------- |
| `session.dashboard.content.write(content, targets)`  | `session.dashboard.showText(text)` | 🔄 Redesign |
| `session.dashboard.content.writeToMain(content)`     | `session.dashboard.showText(text)` | 🔄 Redesign |
| `session.dashboard.content.writeToExpanded(content)` | — (no modes)                       | ❌ Remove   |
| `session.dashboard.content.getCurrentMode()`         | — (no modes)                       | ❌ Remove   |
| `session.dashboard.content.onModeChange(handler)`    | — (no modes)                       | ❌ Remove   |
| `session.dashboard.system?.setTopLeft(content)`      | — (OS owns system sections)        | ❌ Remove   |
| `session.dashboard.system?.setTopRight(content)`     | — (OS owns system sections)        | ❌ Remove   |
| `session.dashboard.system?.setBottomLeft(content)`   | — (OS owns system sections)        | ❌ Remove   |
| `session.dashboard.system?.setBottomRight(content)`  | — (OS owns system sections)        | ❌ Remove   |
| `session.dashboard.system?.setViewMode(mode)`        | — (no modes)                       | ❌ Remove   |
| `session.events.onDashboardModeChange(handler)`      | — (no modes)                       | ❌ Remove   |
| `session.events.onDashboardAlwaysOnChange(handler)`  | —                                  | ❌ Remove   |

### v3 SDK API — dead simple

```typescript
// Show your app's content on the dashboard (one slot per app, replaces previous)
session.dashboard.showText("Next bus: Route 42 in 5 min")

// Update it
session.dashboard.showText("Next bus: Route 42 in 2 min")

// Accepts string[] too (consistent with session.display.showText)
session.dashboard.showText(["Route 42: 5 min", "Route 15: 12 min"])

// Clear your app's dashboard slot
session.dashboard.clear()
```

That's the whole API. Two methods. One slot per app. OS handles layout, priority, and rendering. Naming follows the same convention as `session.display.showText()` / `.clear()`.

### Cloud-side implementation scope

The rewritten `DashboardManager` on `UserSession` needs to:

1. **Own system data rendering** — time, battery, weather, calendar, notifications. Use data already on `UserSession` / `DeviceState` / event streams.
2. **Accept app content** — mini apps call `session.dashboard.showText(text)`, cloud stores one slot per `packageName`.
3. **Compose layout** — use display utils to build a `TextWall` combining system bar + body content.
4. **Send to glasses** — `DisplayRequest` with `ViewType.DASHBOARD`.
5. **React to events** — re-render when battery changes, notification arrives, app writes content, etc.
6. **Weather service** — new cloud-level service (OpenWeatherMap). API key becomes a cloud env var.
7. **Notification summarization** — LLM agent moves into cloud as an OS capability.

---

## 17. System Events

System-level events move to `session.on(event, handler)` — a thin event emitter on the session itself.

| v2                                             | v3                                              | Status            |
| ---------------------------------------------- | ----------------------------------------------- | ----------------- |
| `session.events.onConnected(handler)`          | `session.on('connected', handler)`              | 🔄 Redesign       |
| `session.events.onDisconnected(handler)`       | `session.on('disconnected', handler)`           | 🔄 Redesign       |
| `session.events.onError(handler)`              | `session.on('error', handler)`                  | 🔄 Redesign       |
| `session.events.onPermissionError(handler)`    | `session.on('permissionError', handler)`        | 🔄 Redesign       |
| `session.events.onPermissionDenied(handler)`   | `session.on('permissionDenied', handler)`       | 🔄 Redesign       |
| `session.events.onCapabilitiesUpdate(handler)` | `session.device.capabilities.onChange(handler)` | 🔀 Move to device |

---

## 18. Hardware / Input Events

Hardware events move to `session.device` manager.

| v2                                                           | v3                                               | Status         |
| ------------------------------------------------------------ | ------------------------------------------------ | -------------- |
| `session.events.onButtonPress(handler)`                      | `session.device.onButtonPress(handler)`          | 🔀 Move        |
| `session.events.onHeadPosition(handler)`                     | `session.device.onHeadPosition(handler)`         | 🔀 Move        |
| `session.events.onTouchEvent(gesture?, handler)`             | `session.device.onTouchEvent(gesture?, handler)` | 🔀 Move        |
| `session.events.onVoiceActivity(handler)`                    | `session.mic.onVoiceActivity(handler)`           | 🔀 Move to mic |
| `session.events.onVpsCoordinates(handler)`                   | `session.device.onVpsCoordinates(handler)`       | 🔀 Move        |
| `session.events.onPhotoTaken(handler)`                       | `session.camera.onPhotoTaken(handler)`           | 🔀 Move        |
| `session.onButtonPress(handler)` (deprecated)                | —                                                | ❌ Remove      |
| `session.onHeadPosition(handler)` (deprecated)               | —                                                | ❌ Remove      |
| `session.onTouchEvent(handler)` (deprecated)                 | —                                                | ❌ Remove      |
| `session.onPhoneNotifications(handler)` (deprecated)         | —                                                | ❌ Remove      |
| `session.onPhoneNotificationDismissed(handler)` (deprecated) | —                                                | ❌ Remove      |
| `session.onVpsCoordinates(handler)` (deprecated)             | —                                                | ❌ Remove      |
| `session.onPhotoTaken(handler)` (deprecated)                 | —                                                | ❌ Remove      |
| `session.onGlassesConnectionState(handler)` (deprecated)     | —                                                | ❌ Remove      |
| `session.subscribeToGestures(gestures)`                      | `session.device.subscribeToGestures(gestures)`   | 🔀 Move        |

---

## 19. Phone

🆕 **New in v3.** Phone-specific events grouped under `session.phone` with sub-scoped capabilities.

### Key decisions

- **Sub-scoping** — `session.phone.notifications`, `session.phone.calendar` are namespaces, not flat methods.
- **Permissions on sub-scopes** — `session.phone.notifications.hasPermission`, not `session.phone.hasPermission` (too vague).
- **Battery** stays flat — it's a single value, not a sub-capability.

| v2                                                     | v3                                                                                             | Status             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------ |
| `session.events.onPhoneNotifications(handler)`         | `session.phone.notifications.on(handler)`                                                      | 🔀 Move / redesign |
| `session.events.onPhoneNotificationDismissed(handler)` | `session.phone.notifications.onDismissed(handler)`                                             | 🔀 Move / redesign |
| `session.events.onPhoneBattery(handler)`               | `session.phone.onBatteryUpdate(handler)`                                                       | 🔀 Move / rename   |
| `session.events.onCalendarEvent(handler)`              | `session.phone.calendar.on(handler)`                                                           | 🔀 Move / redesign |
| —                                                      | `session.phone.notifications.hasPermission` → reads `session.permissions.has('notifications')` | 🆕 New             |
| —                                                      | `session.phone.calendar.hasPermission` → reads `session.permissions.has('calendar')`           | 🆕 New             |
| —                                                      | `session.phone.battery` (cached read-only, `number \| null`)                                   | 🆕 New             |

### v3 PhoneManager API

```typescript
class PhoneManager {
  /** Phone battery level (cached, null if unknown). */
  readonly battery: number | null

  /** Battery update subscription. */
  onBatteryUpdate(handler: (data: PhoneBatteryUpdate) => void): () => void

  /** Notification sub-scope. */
  readonly notifications: {
    on(handler: (notif: PhoneNotification) => void): () => void
    onDismissed(handler: (data: PhoneNotificationDismissed) => void): () => void
    readonly hasPermission: boolean // reads from session.permissions
  }

  /** Calendar sub-scope. */
  readonly calendar: {
    on(handler: (data: CalendarEvent) => void): () => void
    readonly hasPermission: boolean // reads from session.permissions
  }
}
```

### Permission pattern

```typescript
// Single-capability managers — permission on the manager itself
session.location.hasPermission
session.mic.hasPermission
session.camera.hasPermission

// Multi-capability managers — permission on the sub-scope
session.phone.notifications.hasPermission
session.phone.calendar.hasPermission

// All of these read from the central permissions manager
session.permissions.has("location") // same as session.location.hasPermission
session.permissions.has("notifications") // same as session.phone.notifications.hasPermission
```

---

## 20. App-to-App Communication — REMOVED

**Deprecated and removed entirely.** The multi-user app communication backend is broken (commented out in cloud), and the feature is not used. All app-to-app APIs are removed in v3.

| v2                                                   | v3  | Status    |
| ---------------------------------------------------- | --- | --------- |
| `session.discoverAppUsers(domain, includeProfiles?)` | —   | ❌ Remove |
| `session.isUserActive(userId)`                       | —   | ❌ Remove |
| `session.getUserCount(domain)`                       | —   | ❌ Remove |
| `session.broadcastToAppUsers(payload, roomId?)`      | —   | ❌ Remove |
| `session.sendDirectMessage(targetUserId, payload)`   | —   | ❌ Remove |
| `session.joinAppRoom(roomId, config?)`               | —   | ❌ Remove |
| `session.leaveAppRoom(roomId)`                       | —   | ❌ Remove |
| `session.onAppMessage(handler)`                      | —   | ❌ Remove |
| `session.onAppUserJoined(handler)`                   | —   | ❌ Remove |
| `session.onAppUserLeft(handler)`                     | —   | ❌ Remove |
| `session.onAppRoomUpdated(handler)`                  | —   | ❌ Remove |
| `session.events.onCustomMessage(handler)`            | —   | ❌ Remove |

Cloud-side: delete `app-communication.routes.ts` (both Express and Hono versions). See [040 §9](../040-cloud-v3-cleanup/maintainability.md).

---

## 21. Connection / Lifecycle

| v2                                           | v3                                              | Status                |
| -------------------------------------------- | ----------------------------------------------- | --------------------- |
| `session.connect(sessionId)`                 | (internal — called by MentraApp, not developer) | ❌ Remove from public |
| `session.disconnect(opts?)`                  | (internal — called by MentraApp, not developer) | ❌ Remove from public |
| `session.releaseOwnership(reason)`           | (internal — called by MentraApp, not developer) | ❌ Remove from public |
| `session.getSessionId()`                     | `session.getSessionId()`                        | ✅ Keep               |
| `session.getPackageName()`                   | `session.getPackageName()`                      | ✅ Keep               |
| `session.getSettings()` (deprecated)         | — (use `session.storage.getAll()`)              | ❌ Remove             |
| `session.getSetting(key)` (deprecated)       | — (use `session.storage.get(key)`)              | ❌ Remove             |
| `session.setSubscriptionSettings(opts)`      | `session.setSubscriptionSettings(opts)`         | ✅ Keep               |
| `session.loadConfigFromJson(path)`           | `session.loadConfigFromJson(path)`              | ✅ Keep               |
| `session.getConfig()`                        | `session.getConfig()`                           | ✅ Keep               |
| `session.getInstructions()`                  | `session.getInstructions()`                     | ✅ Keep               |
| `session.getWifiStatus()`                    | — (use `session.device.wifiConnected.value`)    | ❌ Remove             |
| `session.isWifiConnected()`                  | — (use `session.device.wifiConnected.value`)    | ❌ Remove             |
| `session.requestWifiSetup(ssid, pass)`       | `session.device.requestWifiSetup(ssid, pass)`   | 🔀 Move               |
| `session.getDefaultSettings()`               | — (settings deprecated)                         | ❌ Remove             |
| `session.getSettingSchema(key)`              | — (settings deprecated)                         | ❌ Remove             |
| `session.getServerUrl()`                     | (internal)                                      | ❌ Remove from public |
| `session.getHttpsServerUrl()`                | (internal)                                      | ❌ Remove from public |
| `session.sendMessage(msg)`                   | (internal)                                      | ❌ Remove from public |
| `session.updateSettingsForTesting(settings)` | (internal / test-only)                          | ❌ Remove from public |

---

## 22. Low-Level / Escape Hatch

### Decision: Keep `session.events` as a deprecated escape hatch

`session.events` remains accessible in v3 for power users who need raw stream access. It carries a deprecation warning. It is removed in v4.

| v2                                              | v3                                                                         | Status                |
| ----------------------------------------------- | -------------------------------------------------------------------------- | --------------------- |
| `session.events.on(streamType, handler)`        | ⚠️ `session.events.on(streamType, handler)` (deprecated)                   | ⚠️ Deprecate          |
| `session.events.onCustomMessage(type, handler)` | ⚠️ `session.events.onCustomMessage(type, handler)` (deprecated)            | ⚠️ Deprecate          |
| `session.events.getRegisteredStreams()`         | (internal)                                                                 | ❌ Remove from public |
| `session.events.emit(event, data)`              | (internal)                                                                 | ❌ Remove from public |
| `session.subscribe(stream)`                     | ⚠️ Deprecated — managers handle subscriptions internally                   | ⚠️ Deprecate          |
| `session.unsubscribe(stream)`                   | ⚠️ Deprecated — managers handle subscriptions internally                   | ⚠️ Deprecate          |
| `session.on(event, handler)` (generic)          | `session.on(event, handler)` — repurposed for system events only (see §17) | 🔄 Redesign           |

---

## 23. Types & Language Codes

### Key decisions

- **ISO 639-1 language codes** (`en`, `ja`, `es`) replace BCP-47 (`en-US`, `ja-JP`) in the SDK API.
- **Azure is dead code** — all Azure-specific types, provider references, and `en-US` defaults are removed from the SDK.
- **Wire protocol**: v3 SDK sends `transcription:en` (not `transcription:en-US`). Cloud accepts both for backwards compat with v2 SDK apps.
- **`TranscriptionData` type** is cleaned up — `provider` and `metadata` remain for advanced use but the primary fields are provider-agnostic.

| v2 type / pattern                                       | v3                                                                                         | Status             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------ |
| `"en-US"`, `"ja-JP"` etc. in SDK API                    | `"en"`, `"ja"` etc. (ISO 639-1)                                                            | 🔄 Redesign        |
| `createTranscriptionStream("en-US")` default            | Auto-detect (no language required)                                                         | 🔄 Redesign        |
| `"transcription:en-US?hints=ja"` wire format            | `"transcription:en"` or `"transcription:auto"` (wire) — devs never see this                | 🔄 Redesign        |
| `TranscriptionData.transcribeLanguage`                  | `TranscriptionEvent.language` (detected, not subscribed)                                   | 🔄 Rename          |
| `TranscriptionData.detectedLanguage`                    | `TranscriptionEvent.language` (merged — always detected)                                   | 🔄 Merge           |
| `TranscriptionData.provider`                            | `TranscriptionEvent.metadata?.provider` (moved to metadata)                                | 🔀 Move            |
| `TranscriptionMetadata.soniox` / `.azure` / `.alibaba`  | `TranscriptionEvent.metadata` (provider-agnostic shape, provider-specific in nested field) | ✅ Keep            |
| `SonioxToken` type                                      | Kept in metadata — not in primary event surface                                            | ✅ Keep (internal) |
| `TpaServer` / `TpaSession` (legacy aliases)             | —                                                                                          | ❌ Remove          |
| `TpaServerConfig` / `TpaSessionConfig` (legacy aliases) | —                                                                                          | ❌ Remove          |

---

## 24. Route Namespacing

### Problem

SDK mounts HTTP endpoints at root level (`/webhook`, `/tool`, `/health`, `/settings`, `/photo-upload`, `/mentra-auth`). With `MentraApp extends Hono`, dev's web app shares the same server — route collisions are invisible and fragile.

### Solution

All SDK internal endpoints move behind a prefix: `/api/_mentraos/`

| v2 path              | v3 path                            |
| -------------------- | ---------------------------------- |
| `POST /webhook`      | `POST /api/_mentraos/webhook`      |
| `POST /tool`         | `POST /api/_mentraos/tool`         |
| `GET /health`        | `GET /api/_mentraos/health`        |
| `POST /settings`     | `POST /api/_mentraos/settings`     |
| `POST /photo-upload` | `POST /api/_mentraos/photo-upload` |
| `GET /mentra-auth`   | `GET /api/_mentraos/auth`          |

### Why `/api/_mentraos/`

- `/api/*` is the conventional namespace for API endpoints.
- The dev's own API routes live at `/api/whatever` (their convention).
- The dev's website/frontend stays at `/` (no collision).
- The `_` prefix signals "internal/framework" — a well-understood Node convention.
- Underscores in URL paths are perfectly valid. No proxy, CDN, or HTTP library will choke on them.

### Cloud coordination required

The cloud hardcodes these paths (`${publicUrl}/webhook`, `${publicUrl}/tool`, etc.) in:

- `AppManager.ts` — webhook calls
- `app.service.ts` — tool calls, stop webhook
- `PhotoManager.ts` — photo upload
- `app-settings.routes.ts` — settings push
- `system-app.api.ts` — tool invocation

**Backwards compat strategy**: SDK v3 mounts at `/api/_mentraos/*` as primary paths AND mounts thin aliases at old root paths during transition. Cloud can migrate to new paths, then old aliases are removed in v4.

---

## 25. Decisions Log

| #   | Decision                                                                  | Rationale                                                                        |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D1  | Manager pattern for session API                                           | Discoverability, lifecycle management, smaller files                             |
| D2  | Route namespacing under `/api/_mentraos/`                                 | Prevents collision with dev's web app routes; `/api/*` is conventional           |
| D3  | `session.location` as top-level manager (not under phone)                 | Location is complex enough to be its own namespace                               |
| D4  | Auto-detect as transcription default                                      | Soniox's strength, zero-config happy path                                        |
| D5  | ISO 639-1 language codes (`en`, `ja`)                                     | Soniox native format, Azure is dead code                                         |
| D6  | `onLanguage(lang, handler)` for filtered transcription                    | Composable, clear intent, avoids switch boilerplate                              |
| D7  | `configure()` separate from `on()` for transcription                      | Mid-session changes without re-subscribing                                       |
| D8  | Translation needs its own spike                                           | Bidirectional, one-to-many, Soniox constraints unknown                           |
| D9  | Translation redesign ships in v3.1, not v3.0                              | Reduce v3.0 scope, don't block on unknowns                                       |
| D10 | API is provider-agnostic and transport-agnostic                           | Future-proof for local SDK, provider changes                                     |
| D11 | Azure code is dead — remove from cloud                                    | Not deprecated, it's a bug that it's still there                                 |
| D12 | `MentraApp extends Hono` (from sdk-hono branch)                           | Lighter, faster, native Bun, consistency with cloud backend                      |
| D13 | MentraApp config slimmed to 5 fields                                      | 6 deprecated/removable fields dropped                                            |
| D14 | `session.device` flattened (remove `.state.` nesting)                     | One less level of nesting, DeviceState IS the device manager                     |
| D15 | `session.simpleStorage` → `session.storage`                               | Shorter, cleaner name                                                            |
| D16 | `session.layouts` → `session.display`                                     | More intuitive name for AR display operations                                    |
| D17 | v2 deprecated wrappers kept in v3 with warnings                           | Gives devs time to migrate, clean break in v4                                    |
| D18 | `vocabulary` config for custom terms                                      | Currently hardcoded in Soniox, app devs need domain-specific terms               |
| D19 | Diarization on by default                                                 | Soniox gives it for free, `speakerId` already in data                            |
| D20 | `languageHints` not `preferredLanguages`                                  | "Hints" is honest about what it does — advisory, not a filter                    |
| D21 | Callback pattern, not class inheritance                                   | TS devs use `app.onSession(handler)`, not `class MyApp extends AppServer`        |
| D22 | Single handler per hook (last registration wins)                          | Simpler mental model; compose inside the handler if needed                       |
| D23 | `session.userId` / `.getSessionId()` on session — no extra hook params    | Session object already has all context                                           |
| D24 | `session.audio` = OUTPUT, `session.mic` = INPUT                           | Clear separation of speakers vs microphone                                       |
| D25 | Location: cached `lat`/`lng` as read-only values                          | No async `getLatest()` needed when SDK already receives updates                  |
| D26 | `session.permissions` — centralized permissions manager                   | One source of truth; individual managers have convenience `.hasPermission`       |
| D27 | `session.phone` with sub-scoped capabilities                              | `phone.notifications`, `phone.calendar` — permissions live on sub-scopes         |
| D28 | `session.capabilities` → `session.device.capabilities`                    | Capabilities are a property of the device                                        |
| D29 | Settings deprecated in favor of Storage                                   | One storage system, not two; removes dev console schema flow                     |
| D30 | Canvas system with double buffering for future glasses                    | `prepare()` + `show()` hides cloud→glasses latency                               |
| D40 | App-to-app communication removed entirely                                 | Backend broken, feature unused, all APIs removed from SDK                        |
| D31 | Dashboard is an OS service, not a mini app                                | Cloud has all the data; kill the Dashboard mini app, render server-side          |
| D32 | Dashboard SDK API: `.showText()` + `.clear()` only                        | Dead simple — one slot per app, consistent naming with `session.display`         |
| D33 | No dashboard modes for now                                                | No main/expanded/alwaysOn — just one dashboard                                   |
| D34 | Dashboard layout: system header + full-width body                         | No more DoubleTextWall quadrants; cloud composes TextWall via display utils      |
| D35 | System data (time, weather, battery, calendar, notifications) owned by OS | Cloud already has this data, no need for a mini app to re-fetch it               |
| D36 | `session.time` namespace for timezone + formatting                        | Replaces 12-line boilerplate; session already knows timezone                     |
| D37 | `session.display.showText()` accepts `string \| string[]`                 | Takes wrap results directly; consistent pipeline                                 |
| D38 | `session.display.wrap()` for explicit text formatting                     | Pure function, returns `string[]`, supports `maxLines`, `breakMode`, `width` (%) |
| D39 | `session.display` integrates display-utils via session context            | Devs don't manually create toolkits or pick device profiles                      |

---

## 26. Open Questions

| #   | Question                                                               | Notes                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Q1  | MentraOS system settings — where do they live?                         | `metricSystemEnabled`, `brightness`, etc. are OS-level, not app-defined. Move to `session.device`?                      |
| Q2  | Typed storage with generics?                                           | `session.storage.get<MyData>('key')` — nice DX but requires dev-maintained types                                        |
| Q3  | Lazy-initialize managers?                                              | If app never uses `session.camera`, skip init? Saves memory, adds complexity                                            |
| Q4  | `session.display.clear()` — auto-clear on new display call?            | State management for what's on screen                                                                                   |
| Q5  | Should `onLanguage` do fuzzy match?                                    | `onLanguage('en')` matches `en`, `en-US`, `en-GB`? We said yes, confirm.                                                |
| Q6  | Translation v3.1 API shape                                             | `.to(lang).on(handler)` vs `.between(a, b).on(handler)` vs `.configure({...})`                                          |
| Q7  | Canvas draw API — SDK-side or glasses-side rendering?                  | Does SDK serialize to bitmap, or does glasses firmware execute draw commands? Depends on firmware.                      |
| Q8  | Minimum viable v3.0 scope                                              | Transcription + Display + Hono + Config cleanup + route namespacing + callback pattern? Translation and canvas in v3.1? |
| Q9  | `session.events` — keep as deprecated escape hatch or remove entirely? | Currently proposed: keep with deprecation warnings                                                                      |
| Q10 | Cloud v3 issue scope                                                   | Azure removal, Express dead code, WS→REST dead paths, anti-patterns — separate audit needed                             |
| Q15 | `session.display.wrap()` width option — percentage vs pixels?          | `{ width: 0.5 }` for 50%? Or `{ width: '50%' }`? Or `{ widthPercent: 0.5 }`?                                            |
| Q11 | Weather service — cloud-level design                                   | API key management, caching, rate limiting, fallback if no location                                                     |
| Q12 | Notification summarization — where in cloud?                           | LLM agent from Dashboard mini app → OS capability. Which LLM? Cost?                                                     |
| Q13 | Dashboard app content priority/ordering                                | How does OS decide which app content to show? Most recent? Something smarter?                                           |
| Q14 | Head-up gesture for dashboard                                          | Currently cycles app content rotation. Keep? Change behavior?                                                           |
