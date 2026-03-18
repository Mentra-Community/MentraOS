# Spike: SDK v3 API Surface Improvements

## Status

**Backlog** — brainstorming, not yet specced. To be batched with 038-sdk-logging-dx into a single SDK v3 release.

## Context

The SDK API has grown organically since v1. Patterns that made sense early on are now confusing for new developers. We want to audit the full API surface, identify DX pain points, and plan breaking changes for v3 — knowing that:

1. **Old SDK versions must keep working** — the underlying WebSocket protocol between SDK and cloud cannot break. v2 apps must still connect and receive data.
2. **We can't do breaking changes often** — v3 is our chance to clean up. Whatever we ship needs to last.
3. **The protocol is the contract, the SDK is the wrapper** — we can reshape how devs interact with the SDK without changing what goes over the wire.

---

## Audit: Current API Patterns

### Transcription subscription (the poster child for confusion)

There are multiple overlapping ways to subscribe to transcriptions:

```typescript
// Way 1: Convenience method, defaults to en-US
session.events.onTranscription((data) => { ... });

// Way 2: Language-specific with options
session.events.onTranscriptionForLanguage("en-US", (data) => {
  ...
}, { hints: ["ja"], disableLanguageIdentification: false });

// Way 3: Generic stream subscription
session.events.onStream("transcription:en-US?hints=ja", (data) => { ... });

// Way 4: Low-level subscribe + manual handler
session.subscribe("transcription:en-US" as ExtendedStreamType);
session.events.addHandler("transcription:en-US", (data) => { ... });
```

**Problems:**

- 4 ways to do the same thing, at different abstraction levels, all publicly accessible
- `onTranscription` vs `onTranscriptionForLanguage` — naming is awkward, discoverability is poor
- Options like `hints` and `disableLanguageIdentification` are transcription-provider-specific details leaking into the app API
- The `lastLanguageTranscriptioCleanupHandler` pattern (yes, that typo is in the code) for managing handler lifecycle is fragile
- Cleanup functions returned by handlers are easy to forget and leak subscriptions

### Translation subscription (same problems)

```typescript
session.events.onTranslation("en-US", "es-ES", (data) => { ... });
session.events.onTranslationForLanguages("en-US", "es-ES", (data) => {
  ...
}, { disableLanguageIdentification: true });
```

Same patterns, same confusion. Plus the source/target language pair ordering is easy to get backwards.

### EventManager is doing too much

`EventManager` (`events.ts`, ~580 lines) handles:

- Stream subscriptions (transcription, translation, audio, video, etc.)
- System events (connected, disconnected, error, settings_update)
- Custom messages (app-to-app)
- Dashboard mode changes
- Permission errors
- Handler lifecycle (add/remove/cleanup)
- WebView URL building

This is a god object. Developers discover features by scrolling through `session.events.*` autocomplete and hoping they find what they need.

### Session object is also doing too much

`AppSession` (`index.ts`, ~1600+ lines) handles:

- WebSocket connection lifecycle
- Message serialization/deserialization
- Subscription management
- Layout/display sending
- Audio playback
- Camera/photo capture
- RTMP streaming
- Settings management
- Reconnection logic
- Health checks

Developers access everything through `session.*` — flat namespace, no organization.

### Display/Layout API

```typescript
// Current: imperative, error-prone
session.layouts.showTextWall("Hello world", {durationMs: 3000})
session.layouts.showDoubleTextWall("Top", "Bottom")
session.layouts.showReferenceCard("Title", "Body text")
session.layouts.showBitmapView(bitmapData)

// Must manually manage what's on screen, when to clear, etc.
```

This is actually one of the better APIs — clear, simple methods. But there's no state management — devs have to track what's displayed and manually clear/replace.

### Camera API

```typescript
// Buried inside session
const photo = await session.camera.takePhoto({quality: "high"})

// RTMP streaming is separate
session.startRtmpStream(config)
session.stopRtmpStream()
```

Camera and streaming are related but split across different access patterns.

### Settings API

```typescript
// Fetch settings
const settings = await session.settings.getSettings(keys);

// Listen for changes
session.events.onSettingsUpdate((settings) => { ... });

// Define settings schema — completely separate system
// Done in console.mentra.glass, not in code
```

Settings access is split between `session.settings.*` and `session.events.onSettingsUpdate`. The schema definition is out-of-band (web console). No type safety on settings keys/values.

### AppServerConfig is full of dead/deprecated fields

```typescript
export interface AppServerConfig {
  packageName: string // ✅ Required
  apiKey: string // ✅ Required
  port?: number // ✅ Used (default: 7010)

  cloudApiUrl?: string // ❌ DEPRECATED — cloud tells the SDK its public URL via the webhook payload now
  webhookPath?: string // ❌ DEPRECATED — SDK auto-exposes at '/webhook', marked deprecated in JSDoc but still in the type
  appInstructions?: string // ❌ DEPRECATED — no longer used

  publicDir?: string | false // 🔸 REMOVABLE — with Hono, devs can add serveStatic middleware themselves (one line)
  healthCheck?: boolean // 🔸 REMOVABLE — trivial one-line Hono route, doesn't need to be SDK config
  cookieSecret?: string // 🔸 REMOVABLE — webview auth concern, not core SDK config
}
```

3 fields are deprecated, 3 more are removable now that AppServer extends Hono (devs can wire these up themselves with one line of Hono middleware). That leaves just `packageName`, `apiKey`, and `port` as actual config.

### AppServer is moving from Express to Hono (`cloud/sdk-hono` branch)

Work-in-progress on `origin/cloud/sdk-hono`: `AppServer` now **extends** `Hono` instead of wrapping an Express instance.

```typescript
// Before (v2): AppServer HAS an Express app
export class AppServer {
  private app: express.Application
  // devs can't add routes without getExpressApp()
}

// After (v3): AppServer IS a Hono app
export class AppServer extends Hono<{Variables: AuthVariables}> {
  // devs can add routes directly: this.get('/my-endpoint', handler)
}
```

**Why this is good:**

- Hono is lighter, faster, native Bun support, better TypeScript — Express is dead weight
- Cloud backend already uses Hono — consistency across the stack
- Devs who extend AppServer (`class MyApp extends AppServer`) get full Hono capabilities for free — custom routes, middleware, etc.
- Removes the awkward `getExpressApp()` escape hatch (already marked deprecated on the branch)

**Why `extends` over composition:**

- `class MyApp extends AppServer` is already the established pattern — devs subclass AppServer. With `extends Hono`, their subclass is also a Hono app. This means they CAN add custom HTTP endpoints alongside MentraOS webhook/session machinery if they need to (OAuth callbacks, webview serving, status pages, etc.)
- Composition (`AppServer has a .hono` property) would require devs to go through an accessor to add routes — more boilerplate for the same result
- Route collisions are unlikely — SDK routes are namespaced (`/webhook`, `/health`, `/tool-call`, `/settings`, `/photo-upload`)

**Why `publicDir` can go:** With `extends Hono`, static file serving is one line in the dev's constructor:

```typescript
this.use("/public/*", serveStatic({root: "./public"}))
```

No need for SDK config to handle this.

---

## Pain Points Summary

| #   | Pain Point                                                                         | Severity                                  |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Multiple ways to subscribe to transcription/translation                            | HIGH — confusing for new devs             |
| 2   | EventManager god object — too many concerns                                        | HIGH — poor discoverability               |
| 3   | No manager pattern — everything flat on session                                    | MEDIUM — hard to find features            |
| 4   | Provider-specific options leak into app API (hints, disableLanguageIdentification) | MEDIUM — unnecessary complexity           |
| 5   | Handler cleanup functions easy to forget                                           | MEDIUM — subscription leaks               |
| 6   | No error taxonomy (see 038)                                                        | HIGH — addressed in 038                   |
| 7   | No logging control (see 038)                                                       | HIGH — addressed in 038                   |
| 8   | Session object too large (~1600 lines)                                             | MEDIUM — maintainability                  |
| 9   | Typos in code (`lastLanguageTranscriptioCleanupHandler`)                           | LOW — but embarrassing in public API      |
| 10  | No type safety on settings keys                                                    | LOW — nice-to-have                        |
| 11  | AppServerConfig has 3 deprecated fields still in the interface                     | MEDIUM — confuses new devs                |
| 12  | Express dependency is dead weight, Hono migration in progress                      | HIGH — already underway on cloud/sdk-hono |

---

## Idea: Manager Pattern

Reorganize the session API into focused managers. Each manager owns one domain, has a clean API surface, and manages its own subscription lifecycle internally.

### Before (v2)

```typescript
// Transcription — 4 different ways
session.events.onTranscription(handler)
session.events.onTranscriptionForLanguage("en-US", handler, opts)

// Translation
session.events.onTranslation("en-US", "es-ES", handler)

// Display
session.layouts.showTextWall("Hello")

// Camera
const photo = await session.camera.takePhoto()

// Audio
session.playAudio(url)

// Settings
const val = await session.settings.getSettings(["key"])
session.events.onSettingsUpdate(handler)

// System events
session.events.onConnected(handler)
session.events.onDisconnected(handler)
session.events.onError(handler)

// Generic streams
session.events.onButtonPress(handler)
session.events.onHeadPosition(handler)
session.events.onPhoneNotification(handler)
session.events.onGlassesBatteryUpdate(handler)
```

### After (v3 idea)

```typescript
// ─── Config (minimal — just what matters) ────────
const app = new AppServer({
  packageName: 'com.example.app',
  apiKey: 'xxx',
  port: 7010,               // optional, default 7010
  logLevel: 'warn',          // from 038
  verbose: false,            // from 038
});

// AppServer extends Hono — add your own routes/middleware
app.use('/public/*', serveStatic({ root: './public' }));
app.get('/status', (c) => c.json({ ok: true }));

// ─── Transcription ───────────────────────────────
session.transcription.on((data) => { ... });
session.transcription.setLanguage("en-US");
session.transcription.stop();

// ─── Translation ─────────────────────────────────
session.translation.on((data) => { ... });
session.translation.setLanguages("en-US", "es-ES");
session.translation.stop();

// ─── Display ─────────────────────────────────────
session.display.showText("Hello world");
session.display.showCard({ title: "Title", body: "Body" });
session.display.showBitmap(data);
session.display.clear();

// ─── Camera ──────────────────────────────────────
const photo = await session.camera.takePhoto();
await session.camera.startStream(rtmpConfig);
await session.camera.stopStream();

// ─── Audio ───────────────────────────────────────
await session.audio.play(url);
await session.audio.stop();
session.audio.onChunk((chunk) => { ... });  // raw audio subscription

// ─── Device ──────────────────────────────────────
session.device.onButtonPress((data) => { ... });
session.device.onBatteryUpdate((data) => { ... });
session.device.onHeadPosition((data) => { ... });
session.device.onConnectionStateChange((state) => { ... });

// ─── Phone ───────────────────────────────────────
session.phone.onNotification((notif) => { ... });
session.phone.onBatteryUpdate((data) => { ... });
session.phone.onLocationUpdate((loc) => { ... });

// ─── Settings ────────────────────────────────────
const val = await session.settings.get("key");
session.settings.onChange((settings) => { ... });

// ─── System ──────────────────────────────────────
session.on("connected", () => { ... });
session.on("disconnected", (info) => { ... });
session.on("error", (err) => { ... });
```

### What this gives us

1. **Discoverability**: `session.` autocomplete shows `transcription`, `translation`, `display`, `camera`, `audio`, `device`, `phone`, `settings`. Each has a small, focused API.
2. **Managed lifecycle**: `session.transcription.on(handler)` internally handles subscribe/unsubscribe/cleanup. No cleanup functions for devs to track.
3. **No provider leakage**: `hints` and `disableLanguageIdentification` move to an optional advanced config, not the primary API.
4. **Smaller files**: Each manager is its own file, ~100-200 lines instead of one 1600-line session.

---

## Protocol Compatibility

The key constraint: **v2 SDK apps must keep working with the current cloud, and the current cloud must keep working with v2 SDK apps.** The WebSocket protocol (message types, subscription formats, DataStream structure) cannot change.

This means:

| Layer                                                             | Can change? | Notes                                |
| ----------------------------------------------------------------- | ----------- | ------------------------------------ |
| Public API surface (`session.transcription.on()` etc.)            | ✅ Yes      | This is what v3 is about             |
| Internal subscription strings (`"transcription:en-US?hints=ja"`)  | ❌ No       | Cloud expects these exact formats    |
| WebSocket message types (`AppConnectionInit`, `DataStream`, etc.) | ❌ No       | Both sides must agree                |
| Handler registration / event dispatch                             | ✅ Yes      | Internal to SDK                      |
| Manager classes wrapping existing logic                           | ✅ Yes      | Pure refactor                        |
| HTTP framework (Express → Hono)                                   | ✅ Yes      | Internal detail, already in progress |

The managers are a **wrapper layer** over the existing subscription/event machinery. `session.transcription.on(handler)` internally calls the same `subscribe("transcription:en-US")` and `addHandler(...)` that v2 uses. The wire format doesn't change.

### v2 → v3 migration for app developers

Since the protocol is unchanged, migration is purely API-level:

```typescript
// v2
session.events.onTranscription((data) => { ... });

// v3
session.transcription.on((data) => { ... });
```

We could provide a codemod, but honestly the changes are simple enough that a migration guide with find-and-replace patterns would suffice.

### Deprecation path

v3 could keep v2 methods as deprecated wrappers:

```typescript
// Deprecated — use session.transcription.on() instead
session.events.onTranscription = (handler) => {
  console.warn("[MentraOS] session.events.onTranscription() is deprecated. Use session.transcription.on()")
  return session.transcription.on(handler)
}
```

This lets v2 code still compile against v3 with warnings, giving developers time to migrate.

---

## Open Questions

1. **How far do we go with managers?** Do we create managers for everything (device, phone, location) or just the high-traffic ones (transcription, translation, display, camera, audio)? Smaller managers are simpler but more managers means more namespace.

2. **Should managers be lazy-initialized?** If an app never uses `session.camera`, should the camera manager even exist? Lazy init saves memory but adds complexity.

3. **Do we keep `session.events` at all?** It could remain as a low-level escape hatch for advanced use cases (custom streams, raw subscriptions). Or we remove it entirely and let managers be the only way.

4. **TypeScript generics for settings?** Could we support typed settings:

   ```typescript
   interface MySettings {
     theme: "dark" | "light"
     fontSize: number
   }
   const settings = session.settings.get<MySettings>("theme")
   ```

   Nice DX but requires the dev to maintain type definitions.

5. **Batch these changes with 038?** Logging/error DX (038) and API surface (039) are both v3 breaking changes. Ship them together to minimize breaking-change releases.

6. **Minimum viable v3** — what's the smallest set of changes that justifies a major version bump? Probably: managers for transcription + translation + display (the most-used APIs), logging control, error classes. Everything else can be v3.1, v3.2.

---

## Rough Effort Estimate

| Task                                                     | Effort         |
| -------------------------------------------------------- | -------------- |
| TranscriptionManager (replaces events.onTranscription\*) | ~1.5 days      |
| TranslationManager (replaces events.onTranslation\*)     | ~1 day         |
| DisplayManager (wraps layouts)                           | ~0.5 day       |
| CameraManager (wraps camera + RTMP)                      | ~0.5 day       |
| AudioManager (wraps audio play + audio chunk sub)        | ~0.5 day       |
| DeviceManager + PhoneManager (wraps hardware events)     | ~1 day         |
| Deprecation wrappers for v2 API                          | ~0.5 day       |
| Hono migration (merge cloud/sdk-hono, clean up)          | ~1 day         |
| Session refactor (wire up managers, slim down)           | ~1 day         |
| Tests                                                    | ~2 days        |
| Migration guide / docs                                   | ~1 day         |
| **Total**                                                | **~10.5 days** |

Combined with 038 (~4.5 days), SDK v3 is roughly **~15 days** of work. Could parallelize some of it. Hono migration is partially done on `cloud/sdk-hono` which reduces the actual remaining effort.

---

## Next Steps

1. Get feedback on manager pattern — is this the right direction?
2. Decide on scope for v3 vs v3.x
3. Spec the managers (exact method signatures, constructor patterns)
4. Implement alongside 038-sdk-logging-dx on this branch

## Date

2026-02-16
