# SDK v3 — Documentation Update Spec

> **Note:** This doc was originally written using `MentraApp` as the server class name.
> That was renamed to `MiniAppServer` — see `decisions.md` D-002.
> All references below use the current name.

**Issue:** 048
**Related:** All spikes in this directory, [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md)
**Status:** Spec (not yet started)
**Date:** 2026-03-18

---

## Purpose

This document specifies everything that needs to happen to the developer-facing documentation when SDK v3 ships. It covers the doc site, the npm README, in-code docs, migration guides, and URL preservation strategy.

**Guiding principles:**

1. **Don't break existing links.** Developers have bookmarked pages, blog posts link to them, LLMs have them in training data. Old URLs must either serve updated content or redirect.
2. **New developers see v3 first.** The primary docs teach the new API. v2 is archived, not deleted.
3. **Migration is a first-class document.** The single highest-value page we write is "I just updated, what changed?"
4. **Don't write docs for things that don't ship.** Local apps, `mentra` CLI, and MentraJS framework are v3.1+. No docs until they exist.

---

## Current Doc Landscape

| Surface          | Location                                       | Current State                                                        |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Doc site         | `docs.mentra.glass`                            | Teaches v2 (`AppServer`, `session.events.*`)                         |
| npm README       | `packages/sdk/README.md`                       | Shows v2 patterns, `3.0.0-hono.8` prerelease                         |
| JSDoc            | Scattered across `app/session/`, `app/server/` | Incomplete, some modules have good docs, others have none            |
| Examples         | `packages/sdk/examples/`                       | v2 patterns                                                          |
| Deprecation URLs | Hardcoded in warning messages                  | Currently point to `docs.mentra.glass/sdk/migration` (doesn't exist) |
| GitHub README    | `cloud/README.md`                              | General cloud readme, not SDK-specific                               |

---

## URL Strategy

### Rule: Primary URLs become v3. Old content moves to `/sdk/v2/`.

```
docs.mentra.glass/sdk/getting-started    → REWRITE for v3 (MiniAppServer pattern)
docs.mentra.glass/sdk/session            → REWRITE for v3 (MentraSession + managers)
docs.mentra.glass/sdk/events             → REDIRECT to /sdk/v2/events (removed concept)
docs.mentra.glass/sdk/layouts            → REDIRECT to /sdk/display
docs.mentra.glass/sdk/audio              → REDIRECT to /sdk/speaker

docs.mentra.glass/sdk/v2/               → ARCHIVE of all v2 docs (read-only)
docs.mentra.glass/sdk/v2/getting-started → old getting started (preserved)
docs.mentra.glass/sdk/v2/session         → old session docs (preserved)
docs.mentra.glass/sdk/v2/events          → old events docs (preserved)
docs.mentra.glass/sdk/v2/layouts         → old layouts docs (preserved)
docs.mentra.glass/sdk/v2/audio           → old audio docs (preserved)
```

### New pages (v3)

```
/sdk/                           → landing / overview
/sdk/getting-started            → quickstart with MiniAppServer
/sdk/session                    → MentraSession overview (managers, lifecycle, events)

/sdk/transcription              → session.transcription
/sdk/translation                → session.translation
/sdk/display                    → session.display (renamed from layouts)
/sdk/camera                     → session.camera
/sdk/speaker                    → session.speaker (renamed from audio)
/sdk/mic                        → session.mic (new)
/sdk/device                     → session.device (state, events, WiFi, capabilities)
/sdk/phone                      → session.phone (notifications, calendar, battery)
/sdk/location                   → session.location
/sdk/storage                    → session.storage (renamed from simpleStorage)
/sdk/permissions                → session.permissions (new)
/sdk/dashboard                  → session.dashboard
/sdk/time                       → session.time (new)

/sdk/migration                  → v2 → v3 migration guide (the most important page)
/sdk/migration/api-map          → full v2 → v3 method mapping table
/sdk/migration/app-server       → AppServer → MiniAppServer deep-dive
/sdk/migration/events           → session.events.* → managers deep-dive

/sdk/v2/                        → archived v2 docs (banner: "You're viewing v2 docs")
```

### Redirects

| Old URL               | New URL          | Reason                                                |
| --------------------- | ---------------- | ----------------------------------------------------- |
| `/sdk/events`         | `/sdk/v2/events` | `session.events` is deprecated; no v3 equivalent page |
| `/sdk/layouts`        | `/sdk/display`   | Renamed                                               |
| `/sdk/audio`          | `/sdk/speaker`   | Renamed (output only)                                 |
| `/sdk/simple-storage` | `/sdk/storage`   | Renamed                                               |

### Archived v2 pages — banner treatment

Every page under `/sdk/v2/` gets a top-of-page banner:

```
┌──────────────────────────────────────────────────────────────────┐
│ 📦 You're viewing v2 SDK docs.                                   │
│ The current version is v3. → View v3 docs (/sdk/getting-started) │
│ Migration guide → /sdk/migration                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Pages to Write — Priority Tiers

### Tier 1 — Blocks the 3.0.0 release

These must exist before we run `npm publish @mentra/sdk@3.0.0`.

| Page                                      | What it covers                                                                                                               | Estimated effort | Notes                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| **`/sdk/migration`**                      | "I just updated, what changed?" Full v2 → v3 guide. TL;DR at top, step-by-step, FAQ at bottom.                               | **High**         | The single most important doc. Every developer who runs `npm update` will land here.       |
| **`/sdk/migration/api-map`**              | Searchable table of every v2 method → v3 equivalent. Derived from [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md). | **Medium**       | Don't rewrite as prose — keep it as a table. Developers will Ctrl+F for their method name. |
| **`/sdk/getting-started`**                | Rewrite. Install, create MiniAppServer, register onSession, subscribe to transcription, show text. First 5 minutes.          | **Medium**       | This is the first impression for new developers. Must show v3 patterns only.               |
| **npm README** (`packages/sdk/README.md`) | Update to show v3 patterns. Quick example, link to full docs.                                                                | **Low**          | This is literally the most-viewed "doc" — it's the npm package page.                       |

### Tier 2 — Should ship with 3.0.0

These make the v3 docs useful as reference. Can ship same week as the release.

| Page                        | What it covers                                                                                                                                         | Effort |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `/sdk/session`              | MentraSession overview: what managers exist, system events (`connected`, `disconnected`, `error`), lifecycle, `userId`, `sessionId`, `wasResurrected`. | Medium |
| `/sdk/transcription`        | `session.transcription` — `.on()`, `.forLanguage()`, `.configure()`, `TranscriptionEvent` shape, language codes, examples.                             | Low    |
| `/sdk/translation`          | `session.translation` — `.on()`, `.to()`, `.fromTo()`, examples.                                                                                       | Low    |
| `/sdk/display`              | `session.display` — `.showText()`, `.showTextWall()`, `.showDoubleTextWall()`, `.clear()`, wrapping.                                                   | Low    |
| `/sdk/camera`               | `session.camera` — `.takePhoto()`, streaming (unified API), error handling, `PhotoOptions`/`PhotoData`.                                                | Medium |
| `/sdk/speaker`              | `session.speaker` — `.play()`, `.speak()`, `.createStream()`, tracks, `AudioOutputStream`.                                                             | Medium |
| `/sdk/migration/app-server` | Deep-dive: class inheritance → callbacks, Express removal, custom Hono routes, `getExpressApp()` gone.                                                 | Low    |
| `/sdk/migration/events`     | Deep-dive: `session.events.onTranscription()` → `session.transcription.on()`, every event mapping.                                                     | Low    |

### Tier 3 — Follow-up (within 2 weeks of release)

Reference pages for all managers. Lower urgency because developers can discover the API from TypeScript types and JSDoc.

| Page               | What it covers                                                                      | Effort |
| ------------------ | ----------------------------------------------------------------------------------- | ------ |
| `/sdk/mic`         | `session.mic` — `.onChunk()`, `.onVoiceActivity()`, `AudioChunk` shape, VAD.        | Low    |
| `/sdk/device`      | `session.device` — `.state.*` Observables, hardware events, WiFi, capabilities.     | Medium |
| `/sdk/phone`       | `session.phone` — `.notifications.on()`, `.calendar.on()`, `.battery`, permissions. | Low    |
| `/sdk/location`    | `session.location` — `.onUpdate()`, `.requestUpdate()`, cached lat/lng.             | Low    |
| `/sdk/storage`     | `session.storage` — `.get()`, `.set()`, `.delete()`, etc.                           | Low    |
| `/sdk/permissions` | `session.permissions` — `.has()`, `.getAll()`, permission types.                    | Low    |
| `/sdk/dashboard`   | `session.dashboard` — `.showText()`, `.clear()`.                                    | Low    |
| `/sdk/time`        | `session.time` — `.zone`, `.now()`, `.toLocal()`, `.format()`.                      | Low    |

### Not in scope (v3.1+)

Do NOT write these until the features ship:

- Local apps / on-device runtime
- `mentra` CLI (`mentra dev`, `mentra build`, `mentra publish`)
- MentraJS framework (session/ + webview/ convention)
- `session.state<T>` shared state and React hooks
- Video recording
- SRT streaming
- Audio priority system

---

## Migration Guide Structure

The migration guide (`/sdk/migration`) is the most important document. Here's the proposed structure:

```markdown
# Migrating to SDK v3

## TL;DR (30-second version)

- `npm update @mentra/sdk` — your existing code still works
- You'll see deprecation warnings in the console
- Follow this guide to update at your own pace
- v3.1 removes the compat layer — update before then

## What Changed (and Why)

- MiniAppServer replaces AppServer (callbacks > inheritance)
- Managers replace session.events.\* (discoverability, lifecycle)
- Transport abstraction enables future local apps
- [link to full API map →]

## Step 1: AppServer → MiniAppServer (5 min)

[before/after code blocks]
[handling custom routes]
[getExpressApp() removal]

## Step 2: session.events.\* → managers (10 min)

[table: old method → new method, with links]
[before/after for transcription]
[before/after for button press]
[before/after for notifications]

## Step 3: session.layouts → session.display

[before/after, 1 min]

## Step 4: session.audio → session.speaker

[before/after, 1 min]

## Step 5: session.simpleStorage → session.storage

[before/after, 30 sec]

## Step 6: Other renames

[session.capabilities → session.device.capabilities]
[session.getWifiStatus() → session.device.state.wifiConnected]
[session.requestWifiSetup() → session.device.requestWifiSetup()]

## Step 7: Clean up deprecated imports

[AppSession → MentraSession]
[TpaSession → delete]
[TpaServer → delete]

## What didn't change

- Wire protocol (WebSocket messages, subscription strings)
- Cloud behavior
- Webhook format (still sends to /webhook, MiniAppServer mounts both old and new paths)
- Settings, capabilities, device state — same data, new access patterns

## FAQ

- "Do I HAVE to migrate right now?" → No.
- "Will my v2 app break on npm update?" → No.
- "When is the compat layer removed?" → v3.1 (date TBD, minimum 8 weeks)
- "Can I use v3 and v2 patterns in the same app?" → Yes, during the transition.
- "What about my Express middleware?" → See /sdk/migration/app-server (Express is gone — MiniAppServer uses Hono)
- "I used session.events.on() as a generic escape hatch" → Still works in v3.0
```

---

## npm README Strategy

The npm README (`packages/sdk/README.md`) is the highest-traffic "doc" — every developer who visits the npm page sees it.

### Current state

Shows v2 patterns: `class MyApp extends AppServer`, `session.events.onTranscription()`.

### Target state

```markdown
# @mentra/sdk

Build apps for MentraOS smart glasses.

## Quick Start

    npm install @mentra/sdk

    import { MiniAppServer } from "@mentra/sdk"

    const app = new MiniAppServer({
      packageName: "com.example.myapp",
      apiKey: "your_api_key",
    })

    app.onSession((session) => {
      session.transcription.on((data) => {
        session.display.showText(data.text)
      })
    })

    await app.start()

## Migrating from v2?

See the [migration guide](https://docs.mentra.glass/sdk/migration).
Your existing code still works — v3 includes a compatibility layer.

## Documentation

- [Getting Started](https://docs.mentra.glass/sdk/getting-started)
- [API Reference](https://docs.mentra.glass/sdk/session)
- [Migration Guide](https://docs.mentra.glass/sdk/migration)
- [Examples](https://github.com/user/mentraos-example-apps)

## Session Managers

| Manager       | Access                  | What it does             |
| ------------- | ----------------------- | ------------------------ |
| Transcription | `session.transcription` | Live speech-to-text      |
| Translation   | `session.translation`   | Real-time translation    |
| Display       | `session.display`       | AR display output        |
| Camera        | `session.camera`        | Photo capture, streaming |
| Speaker       | `session.speaker`       | Audio output, TTS        |
| Mic           | `session.mic`           | Raw audio input, VAD     |
| Device        | `session.device`        | Hardware state, events   |
| Phone         | `session.phone`         | Notifications, calendar  |
| Location      | `session.location`      | GPS                      |
| Storage       | `session.storage`       | Key-value persistence    |
| ...           | ...                     | ...                      |
```

Short, scannable, links to real docs. Not a tutorial — just enough to get someone oriented.

---

## In-Code Documentation Strategy

### JSDoc on every public method

Every public method and property on every manager gets JSDoc with:

- One-line description
- `@param` for each parameter
- `@returns` description
- `@example` with a realistic usage snippet

````typescript
/**
 * Subscribe to transcription events for a specific language.
 *
 * Each call is independent — multiple languages can be active simultaneously.
 * The cleanup function stops only this subscription.
 *
 * @param lang - ISO 639-1 language code(s): "en", "ja", or ["en", "ja"]
 * @param handler - Called for each transcription event in the specified language(s)
 * @returns Cleanup function to stop this subscription
 *
 * @example
 * ```ts
 * const stopEnglish = session.transcription.forLanguage("en", (data) => {
 *   console.log(`[EN] ${data.text}`)
 * })
 *
 * // Later: stop only English (other languages keep running)
 * stopEnglish()
 * ```
 */
forLanguage(lang: string | string[], handler: (data: TranscriptionEvent) => void): () => void
````

### Deprecation warning messages

Every deprecated accessor includes a URL pointing to the specific migration section:

```typescript
get layouts() {
  warnOnce(
    "session.layouts",
    "session.layouts is deprecated. Use session.display instead.\n" +
    "   Migration: https://docs.mentra.glass/sdk/migration#step-3"
  );
  return this.display;
}
```

Pattern for all deprecation warnings:

```
⚠️  DEPRECATION: {old thing} is deprecated. Use {new thing} instead.
   Migration: https://docs.mentra.glass/sdk/migration#{section}
```

### Type definitions as documentation

Export clean interfaces with JSDoc comments. Developers who hover over a type in their IDE should see useful information:

```typescript
/**
 * A transcription event from the speech-to-text engine.
 *
 * `text` and `isFinal` are always present.
 * Other fields depend on the transcription engine's capabilities —
 * check `session.transcription.capabilities` before relying on optional fields.
 */
export interface TranscriptionEvent {
  /** The transcribed text. */
  text: string;

  /** Whether this is a final result (true) or interim/partial (false). */
  isFinal: boolean;

  /** Detected language (ISO 639-1). May be undefined if engine doesn't support detection. */
  language?: string;

  // ... etc
}
```

---

## Doc Site Technical Considerations

### Versioning

If the doc site uses a framework with built-in versioning (Docusaurus, Nextra, etc.):

- Tag the current docs as "v2"
- Write new docs as "v3 (latest)"
- Framework handles the version selector and URL routing

If the doc site is custom / static:

- Copy current pages to `/sdk/v2/` directory
- Rewrite primary pages in place
- Add redirects manually (Cloudflare rules, nginx, or meta-refresh)

### Search

The doc site search index needs to:

- Index v3 pages with higher weight than v2 archive pages
- Searching "onTranscription" should surface both the v2 archive AND the migration guide

### Banner / callout component

Need a reusable component for:

- v2 archive pages: "You're viewing v2 docs. [See v3 →]"
- v3 pages during transition: "Migrating from v2? [See migration guide →]"
- Deprecated sections: "This API is deprecated in v3. [See replacement →]"

---

## Checklist

### Before 3.0.0 release

- [ ] Write `/sdk/migration` (migration guide)
- [ ] Write `/sdk/migration/api-map` (full method mapping table)
- [ ] Rewrite `/sdk/getting-started` for v3
- [ ] Update `packages/sdk/README.md` for v3
- [ ] Archive current docs to `/sdk/v2/` (copy, don't delete)
- [ ] Set up redirects for renamed pages (`/sdk/layouts` → `/sdk/display`, etc.)
- [ ] Add v2 archive banner to all `/sdk/v2/` pages
- [ ] Verify all deprecation warning URLs point to real pages
- [ ] Update example apps (at minimum: captions app as the canonical example)

### Within 1 week of release

- [ ] Write `/sdk/session` (MentraSession overview)
- [ ] Write `/sdk/transcription`, `/sdk/translation`
- [ ] Write `/sdk/display`, `/sdk/camera`, `/sdk/speaker`
- [ ] Write `/sdk/migration/app-server`, `/sdk/migration/events`
- [ ] Update search index weights

### Within 2 weeks of release

- [ ] Write remaining manager pages (`/sdk/mic`, `/sdk/device`, `/sdk/phone`, `/sdk/location`, `/sdk/storage`, `/sdk/permissions`, `/sdk/dashboard`, `/sdk/time`)
- [ ] Review and update any external references (blog posts, dev console help text, onboarding emails)
- [ ] Solicit feedback from developers who migrated

### Before 3.1.0 release (compat removal)

- [ ] Add "compat removal" section to migration guide
- [ ] Send communication to developers still using v2 patterns (if we have telemetry)
- [ ] Update `/sdk/getting-started` to remove any mention of compat layer
- [ ] Remove `/sdk/v2/` archive (or keep as historical reference — team decision)

---

## Anti-Patterns — Things NOT to Do

1. **Don't duplicate the API map as prose.** The [039 v2-v3 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md) is comprehensive. The migration guide references it; don't rewrite it.

2. **Don't write "concepts" docs before "how-to" docs.** "How do I show text?" beats "Understanding the Display Architecture" every time.

3. **Don't remove v2 docs from the site.** Archive them. Some teams will be on v2 for months. Removing docs for code that still works is hostile.

4. **Don't write local app docs yet.** Local apps, Hermes runtime, `mentra build` are v3.1+. Documenting unshipped features creates confusion.

5. **Don't put the migration guide behind a login or paywall.** It needs to be the first Google result for "mentra sdk v3 migration."

6. **Don't assume developers read changelogs.** The deprecation warning in their console IS the changelog for most developers. Make the warning message useful and link to the migration guide.
