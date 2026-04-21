# API and Docs 3.0.0-alpha.1 Audit

## Overview

**What this doc covers:** Every issue, decision, and correction found while reviewing the v3 SDK API surface and documentation. This is the living record of what we found and what we decided, so nothing gets lost between chat sessions. Covers both API design problems and documentation problems since the docs can't be right if the API isn't right first.
**Why this doc exists:** We audited every docs page against the actual SDK source code and found problems ranging from wrong method names to missing pages to confusing config options to API design issues. This doc tracks each finding and the decision made.
**Who should read this:** Anyone working on the v3 docs or SDK API surface.

## Config Option Decisions

### `cookieSecret` -- remove from docs

The `MiniAppServer` constructor automatically applies `createAuthMiddleware` using the `apiKey` as the cookie signing secret. Developers do not need to call `createAuthMiddleware` themselves or configure `cookieSecret`. This was confirmed in issue 082.

**Decision:** Remove `cookieSecret` from all docs. Remove any examples showing manual `createAuthMiddleware` setup. Auth is automatic.

### `verbose` -- deprecate in favor of `logLevel`

The SDK currently exposes both `verbose: boolean` and `logLevel: string` in the MiniAppServer config. They overlap: `verbose: true` shows SDK internals, `logLevel: "debug"` also shows SDK internals and implies verbose.

**Decision:**
- Keep `logLevel` as the single config option. Values: `"error"`, `"warn"`, `"info"`, `"debug"`.
- Default to `"warn"` (errors and warnings only, clean terminal).
- `"info"` shows developer's own `session.logger.info()` calls.
- `"debug"` shows everything including SDK internals.
- Deprecate `verbose` internally (keep it working, map to `logLevel: "debug"`). Remove from docs.
- `MENTRA_LOG_LEVEL` env var stays as an override. Config takes priority over env var.

### `createAuthMiddleware` -- remove from v3 docs

Developers should NOT be told to call `createAuthMiddleware` manually. It is built into `MiniAppServer`. The webview-authentication page should only show `getMentraAuth(c)` for reading the authenticated user in route handlers.

### `subscribeToGestures` -- deprecate, add array overload to `onTouchEvent`

The current API has three ways to handle touch/gesture events:

1. `onTouchEvent(handler)` -- all gestures, one call. Good.
2. `onTouchEvent("double_tap", handler)` -- one gesture, one call. Good.
3. `subscribeToGestures(["a", "b"])` -- multiple gestures, no handler. Bad.

Option 3 breaks the pattern. It subscribes without a handler. The developer must make a separate `onTouchEvent` call to actually receive events. Two calls to do one thing.

**Decision:**
- Deprecate `subscribeToGestures(gestures[])`
- Add array overload to `onTouchEvent`: `onTouchEvent(gestures: string[], handler)` so this works:
  ```typescript
  session.device.onTouchEvent(["single_tap", "double_tap"], (e) => {
    console.log(e.gesture);
  });
  ```
- Docs only show the `onTouchEvent` pattern. Never show `subscribeToGestures`.

The principle: if you are subscribing to events, the subscription and the handler are always in the same call. You never "subscribe" without a handler. `configure()` on transcription/translation is different because it sets processing config, not event subscriptions.

### CORS section -- remove entirely

The `react-webviews.mdx` page has an entire CORS section showing Express-style `import cors from "cors"` and `app.use(cors({...}))`. This is wrong for v3:

1. The webview is served from the same Bun process as the API (same origin). No CORS needed.
2. Even if CORS were needed, Hono has built-in CORS middleware. The Express `cors` package is irrelevant.

**Decision:** Remove the entire CORS section from `react-webviews.mdx`. If a note about CORS is needed, one sentence: "CORS is not needed because the webview and API are served from the same URL. If you do need cross-origin support, use Hono's built-in `cors()` middleware."

### `npm install` / `yarn add` -- replace with `bun add` everywhere

Every instance of `npm install` and `yarn add` in the v3 docs should be `bun add`. Bun is required for v3. We use the Bun runtime, Bun fullstack dev server, Bun bundler. Showing npm/yarn is misleading.

**Decision:** Global find-and-replace across all v3 doc pages:
- `npm install` -> `bun add`
- `yarn add` -> remove
- No more "or" alternatives. Just `bun add`.

### Express references -- remove from v3 pages

The `react-webviews.mdx` prerequisites mention "different domain that allows CORS requests from your frontend." This is the Express-era mental model where frontend and backend are separate servers. In v3, they are the same server.

**Decision:** Remove all Express-era assumptions from v3 pages. The v3 architecture is: one Bun process, one URL, serves both the webview (via Bun fullstack HTML routes) and the API (via Hono fetch fallback). The only place Express should appear is in "Migrating from v2" sections.

### Location API -- add `configure()`, make `requestUpdate()` return a Promise

The current `requestUpdate(accuracy?)` does two things in one call: sets accuracy AND requests an update. The accuracy parameter on `onUpdate(handler, accuracy?)` also mixes subscribing with config. This is inconsistent with the `configure()` pattern used by transcription and translation.

**Decision:**
- Add `session.location.configure({ accuracy })` to set accuracy separately
- `onUpdate(handler)` subscribes to continuous updates (no accuracy param, uses configured value)
- `requestUpdate()` returns `Promise<LocationData>` instead of void (the correlationId mechanism already supports this)
- Cached getters (`lat`, `lng`, `accuracy`, `timestamp`) remain as pure reads, null until first update
- No auto-subscribe magic on cached property access (would cause hidden battery drain)
- Docs clearly state: "lat, lng, accuracy, and timestamp are null until you subscribe via `onUpdate()` or request via `requestUpdate()`"

The `configure()` pattern is now consistent across three managers:
- `session.transcription.configure({ languageHints, vocabulary, diarization })`
- `session.location.configure({ accuracy })`
- Principle: whenever a manager has settings that affect how data is processed or delivered, use `.configure()`. It is separate from subscribing to events.

Full proposed location API:
```typescript
session.location.configure({ accuracy: "high" });

// Continuous updates
const stop = session.location.onUpdate((location) => {
  session.logger.info(location.lat, location.lng);
});
stop(); // unsubscribe

// One-shot (returns a Promise)
const location = await session.location.requestUpdate();

// Cached values (null until first update)
session.location.lat       // number | null
session.location.lng       // number | null
session.location.accuracy  // number | null
session.location.timestamp // number | null

// Permission check
session.location.hasPermission // boolean

// Tear down
session.location.stop();
```

### `onPhotoTaken` -- remove

`onPhotoTaken(handler)` listens for externally-triggered photo events (hardware button press on glasses, not initiated by `takePhoto()`). The name is confusing because it sounds like the callback for `takePhoto()` completing, which it is not. `takePhoto()` returns a Promise.

**Decision:** Remove. If the user presses the hardware button and takes a photo without the app asking, we do not need to handle that. The app takes photos with `takePhoto()` and gets the result from the Promise. Simple. Deprecate `onPhotoTaken` in the SDK and do not document it.

### Translation manager -- confirmed using Soniox, has `configure` equivalent via `fromTo`/`to`

The cloud's TranslationManager already uses Soniox's unified transcription+translation API (with Alibaba as a fallback for China). It is NOT stale or deprecated.

Soniox translation supports two modes:
- **One-way:** translate all speech into a single target language (`target_language: "fr"`)
- **Two-way:** translate back and forth between two languages (`language_a: "ja", language_b: "ko"`)

Our v3 SDK's `session.translation` maps to this:
- `translation.to(target, handler)` maps to one-way
- `translation.fromTo(source, target, handler)` maps to two-way
- `translation.on(handler)` is a catch-all for any active translation

The language pair configuration is implicit in the `to()`/`fromTo()` call, not in a separate `configure()`. This is acceptable because unlike transcription (where language hints are optional config that doesn't change the subscription), translation's language pair IS the subscription. You can't translate without specifying the target. So `to("fr", handler)` is both the subscription and the configuration in one call. No separate `configure()` needed.

`language_hints` is a Soniox transcription concept, not translation. Translation uses `target_language` or `language_a`/`language_b`. Our SDK correctly does not expose `languageHints` on the translation manager.

### v2 (Legacy) sidebar section -- clean up

The v2 sidebar section is messy:
- Some items have icons, some don't
- Some are postfixed with "(v2)", some aren't
- "MentraOS SDK Reference" is the first item but it's unclear what it is
- "Dashboard API", "Token Utilities", "Utilities" are miscellaneous items that aren't clearly v2 or v3

**Decision:**
- Every item in the v2 section should be prefixed with "v2:" not postfixed with "(v2)"
- Every item should have an icon for visual consistency
- The section header "v2 (Legacy)" is correct
- Items that are truly version-agnostic (Token Utilities, Utilities) should either move to a separate "Reference" section or stay in v2 with a clear label
- The whole section should feel like "here is the old stuff, it's organized but clearly marked as legacy"

## Sidebar Structure Decisions

### App Lifecycle Overview -- moved to Getting Started

This is a conceptual "what is a mini app" page, not an API reference. It belongs in the Getting Started section where new developers land first.

### Webviews -- moved after MiniAppServer

Webviews are part of the server architecture story. The developer needs to understand: "I run a Bun server, it serves my webview AND connects to the cloud." Webviews right after MiniAppServer tells that story.

### Device -- placed right after MentraSession

The device is the physical glasses in front of them. After learning "you get a session," the next thing to learn is "here is the hardware you are talking to." Device before any specific feature (display, transcription, etc.).

### Hardware & Capabilities -- folded into Device

These are subsets of `session.device` (`device.capabilities`, `device.state`). They are not separate concepts. The 4 old `hw/` pages are consolidated into `device/hardware-capabilities.mdx`.

### Simple Storage (v2) -- moved to v2 Legacy

It was listed under the v3 section. It is a v2 API. It belongs in v2 Legacy.

### Naming -- match managers, not hardware

- "Speech to Text" becomes "Transcription" (it is `session.transcription`)
- "Audio Chunks" stays as "Microphone" (it is `session.mic`)
- "Speakers" becomes "Speaker" (singular, it is `session.speaker`)
- Every sidebar entry maps 1:1 to a `MentraSession` property

### Icons -- every entry gets one

No more visual imbalance. Device gets a glasses icon. Every manager entry has an icon. See docs-plan.md for the full icon list.

## Page-Level Findings

### Missing pages (created)

| Manager | File | Status |
|---------|------|--------|
| DeviceManager | `device/overview.mdx` | Created |
| Hardware Capabilities | `device/hardware-capabilities.mdx` | Created |
| PhoneManager | `phone.mdx` | Created |
| TimeUtils | `time.mdx` | Created |
| Bun Fullstack Dev Server | TBD | Not yet created |

### Pages with wrong API patterns (need rewrite)

| Page | Problem | Status |
|------|---------|--------|
| `display/dashboard.mdx` | v2 `content.writeToMain()` throughout | Not started |
| `camera/README.mdx` | All v2 method names (`requestPhoto`, `startLivestream`) | Not started |
| `camera/photo-capture.mdx` | v2 `requestPhoto()` instead of v3 `takePhoto()` | Not started |
| `led/overview.mdx` | Documents 4 non-existent methods (`blink`, `solid`, `turnOn`, `turnOff`) | Not started |
| `speakers/*.mdx` | Two pages need merging into one, missing `stop()` | Not started |

### Pages needing targeted fixes

| Page | Fix needed | Status |
|------|-----------|--------|
| `app-lifecycle-overview.mdx` | Links point to v2 pages | Not started |
| `app-server.mdx` | Remove `cookieSecret`, add `logLevel`, remove manual auth middleware examples | Not started |
| `microphone/audio-chunks.mdx` | Add `stop()`, `hasPermission` | Not started |
| `camera/streaming.mdx` | Add `checkExistingStream()` | Not started |
| `permissions.mdx` | Fix LOCATION/CAMERA examples to v3, fix CALENDAR syntax error | Not started |
| `storage.mdx` | Add `clear()`, `keys()`, `has()`, `setMultiple()`, `flush()` | Not started |
| `location.mdx` | Add `stop()` | Not started |
| `webview-authentication.mdx` | Remove manual `createAuthMiddleware` setup, show auto auth | Not started |
| 4 hw/ pages | Remove from sidebar (content folded into Device) | Done (sidebar updated) |
| Simple Storage | Moved to v2 Legacy | Done (sidebar updated) |

## Documentation Tone and Style Rules

- No em-dashes. Use commas, periods, or "or" instead.
- Bun is required. No npm. No Node. Developers use Bun.
- Link to Hono docs for HTTP routing. Do not re-explain Hono.
- Link to Bun fullstack docs for the dev server. Explain why we use it.
- Every code example uses v3 callback pattern: `app.onSession((session) => {...})`
- No class inheritance patterns anywhere in v3 docs.
- No `AppSession` type. Only `MentraSession`.
- Import pattern: `import { MiniAppServer, type MentraSession } from "@mentra/sdk"`
- Every manager page follows: what it is, quick example, full API, common patterns.

### Variable naming in examples

Do not abbreviate variable names in documentation examples. Developers skim code. They should never have to look up where a variable was defined or guess what an abbreviation means.

**Bad:**
```typescript
const caps = session.device.capabilities;
if (caps?.hasCamera) { ... }
```

**Good:**
```typescript
if (session.device.capabilities?.hasCamera) { ... }
```

Or if a variable is truly needed:
```typescript
const capabilities = session.device.capabilities;
if (capabilities?.hasCamera) { ... }
```

`caps` means nothing to someone skimming. `capabilities` is self-documenting. Prefer inlining (`session.device.capabilities`) over intermediate variables when the expression is used once or twice.

This applies everywhere: no `opts`, `cfg`, `ctx`, `msg`, `evt`, `val`, `el`, `idx`, `buf`. Spell it out.

### Don't use `session.display` in camera examples

Mentra Live has a camera but no display. Any camera example that calls `session.display.showTextWall()` is demonstrating code that won't work on the only glasses that have a camera. Use `session.logger.info()` instead, or send the data to the webview.

**Bad:**
```typescript
const stream = await session.camera.startStream();
session.display.showTextWall(`Live!\n${stream.webrtcUrl}`);
```

**Good:**
```typescript
const stream = await session.camera.startStream();
session.logger.info("Stream live:", stream.webrtcUrl);
```

The same principle applies to any example: don't use a manager that the target device might not support unless you check capabilities first.

### "Always works on all glasses" claims

Do not claim code "always works on all glasses" if the example uses a manager that requires hardware (display, camera, speaker, etc.). The only things that truly work on all glasses are: transcription (mic can be on phone), logger, storage, permissions, time.

## API Surface Decisions

### Phone battery -- remove

`session.phone.battery` and `session.phone.onBatteryUpdate()` are typed but no client ever sends the data. Not a regression (never worked). Remove from the API surface entirely. Do not document.

### Dashboard mode events -- intentional removal

`onDashboardModeChange` was never fully built. Not a regression. Do not restore.

### App-to-app communication -- intentional removal

The entire subsystem (`discoverAppUsers`, `broadcastToAppUsers`, `sendDirectMessage`, rooms) never worked and was never used. Intentionally removed. Not coming back.

### Custom photo webhook URL -- intentional removal for now

`customWebhookUrl` and `authToken` on photo options removed from v3. May revisit later if there is developer demand.

### Camera FOV/ROI -- separate issue, redesign later

The v2 `setFov()` implementation was rushed. Do not copy it to v3. Track as a separate issue and design a proper API. See issue 092 spike.

### LED blink -- accidental regression, restore via extended `setColor()`

`blink()` / multi-cycle patterns dropped from v3. The wire protocol supports `offtime` and `count`. Restore this capability.

**Decision:** Extend `setColor()` with an overloaded second argument instead of adding a separate `blink()` method. One method, progressive complexity:

```typescript
// Simple (current behavior, backward compatible)
session.led.setColor("green");
session.led.setColor("red", 2000);

// Blink (new, optional params)
session.led.setColor("red", { onTime: 500, offTime: 500, count: 3 });
```

Second argument is either a `number` (duration in ms) or an options object `{ onTime, offTime, count }`. No separate `blink()` method. The simple case stays simple. The blink case is discoverable through the same method. Both cases use the same underlying `RGB_LED_CONTROL` wire message.

### Permission error/denied events -- accidental regression, restore

`onPermissionError` and `onPermissionDenied` dropped from v3. The cloud still sends these messages. Restore on `PermissionsManager`.

### PCM16 encoding -- bug, fix

The v3 `AudioOutputStreamImpl.write()` passes raw PCM through without encoding to MP3. The v2 version encoded via lamejs. The type signature promises PCM support but the implementation does not deliver. Fix before developers use audio streaming with Gemini/OpenAI.

### `onPhotoTaken` -- remove from SDK

Deprecate and do not document. See config decisions section above for rationale.

## Camera Docs Findings

### `camera/photo-capture.mdx` -- all v2

Uses `requestPhoto()` throughout. v3 method is `takePhoto()`. No `onPhotoTaken()` documented (though see the open question about whether to document it at all). No migration section. Needs full rewrite.

### `camera/streaming.mdx` -- mostly v3 but bad examples

The API calls are correct (`startStream`, `stopStream`, `onStreamStatus`). But the "Complete Example" at the bottom uses `session.display.showTextWall()` four times on a camera device that has no display. Should use `session.logger.info()` or send to webview. Also missing `checkExistingStream()` documentation.

### `camera/README.mdx` -- all v2

Uses `requestPhoto()`, `startLivestream()`, `startLocalLivestream()`. All v2 method names. Needs full rewrite as a camera overview linking to the two sub-pages.

### Display URL on glasses is nonsensical

The streaming example shows `session.display.showTextWall(`Live!\n${stream.webrtcUrl}`)`. Even if the glasses had a display, showing a URL on AR glasses makes no sense. The user can't click it or copy it. This should send the URL to the webview where the user can actually use it, or just log it.

## Dashboard Findings

The entire `display/dashboard.mdx` page is mostly v2 fiction. Dashboard "modes" are not a concept in v3. The v2 methods `content.writeToMain()`, `content.writeToExpanded()`, `onModeChange()` do not exist on the v3 `DashboardManager`. The v3 API is two methods: `session.dashboard.showText()` and `session.dashboard.clear()`. Full rewrite needed.

## Permissions Findings

The permissions page has v2 code in the LOCATION and CAMERA sections:
- LOCATION: `session.location.subscribeToStream()` and `session.location.getLatestLocation()` should be `session.location.onUpdate()` and `session.location.requestUpdate()`
- CAMERA: `session.camera.requestPhoto()` and `session.camera.startLocalLivestream()` should be `session.camera.takePhoto()` and `session.camera.startStream()`
- CALENDAR: syntax error with extra comma: `session.phone.calendar.on(, (data) => {})`

## Stale Docs Findings

These are specific issues found while manually reviewing the published docs:

### `react-webviews.mdx`
- Entire CORS section is Express-era, wrong for v3 (remove)
- `npm install @mentra/react` should be `bun add @mentra/react`
- `yarn add @mentra/react` should be removed
- Prerequisites mention "different domain that allows CORS requests" (not applicable in v3)
- Description meta tag mentions "CORS configuration" (remove)

### `bridge-api.mdx`
- `npm install @mentra/react` should be `bun add @mentra/react`

### `webview-authentication.mdx`
- Shows manual `createAuthMiddleware` setup (automatic in v3, remove)
- Express migration section is fine (intentionally showing v2 for comparison)

### `app-server.mdx`
- Still lists `cookieSecret` as a config option (remove)
- Missing `logLevel` config option
- May still show manual auth middleware examples

### General (all v3 pages)
- Every `npm install` should be `bun add`
- Every `yarn add` should be removed
- No Express patterns outside of "Migrating from v2" sections

## Open Questions

None remaining. All decisions made.

## SDK Code Changes Required

These are code changes to the SDK itself (not docs) that were decided during this audit. Track implementation status here.

| # | File | Change | Priority | Status |
|---|------|--------|----------|--------|
| 1 | `LedManager.ts` | Extend `setColor()` second arg: accept `{ onTime, offTime, count }` options object in addition to `number` | Medium | Not started |
| 2 | `DeviceManager.ts` | Add `onTouchEvent(gestures: string[], handler)` array overload. Deprecate `subscribeToGestures()`. | Medium | Not started |
| 3 | `CameraManager.ts` | Deprecate `onPhotoTaken()`. Mark as deprecated, do not remove yet (v2 compat). | Low | Not started |
| 4 | `LocationManager.ts` | Add `configure({ accuracy })`. Make `requestUpdate()` return `Promise<LocationData>`. Remove accuracy param from `onUpdate()`. | Medium | Not started |
| 5 | `SpeakerManager.ts` | Fix PCM16 encoding bug. `write()` must encode PCM to MP3 via lamejs when `format: "pcm16"`. Port encoding logic from v2 `AudioOutputStream`. | **High** | Not started |
| 6 | `PhoneManager.ts` | Remove `battery` getter and `onBatteryUpdate()`. Never implemented by any client. | Low | Not started |
| 7 | `PermissionsManager.ts` | Restore `onPermissionError(handler)` and `onPermissionDenied(handler)` events. Register handlers for cloud `permission_error` and `permission_denied` messages. | Medium | Not started |
| 8 | `app/server/index.ts` | Deprecate `verbose` config option (map to `logLevel: "debug"` internally). Change `logLevel` default from `"info"` to `"warn"`. Remove `verbose` from docs. | Low | Not started |
| 9 | `MentraSession.ts` | Remove `onPhotoTaken` registration from core handlers. | Low | Not started |
| 10 | `_V2SessionShim.ts` | Keep `onPhotoTaken` in v2 compat shim (deprecated but functional for v2 apps). | Low | Not started |

### Priority order

1. **PCM16 encoding bug** (#5) -- broken audio for Gemini/OpenAI integrations. Ship-blocking.
2. **LED blink** (#1) -- accidental regression, developers expect it.
3. **Location configure/requestUpdate** (#4) -- API design cleanup for consistency.
4. **onTouchEvent array overload** (#2) -- API design cleanup.
5. **Permission events** (#7) -- accidental regression.
6. Everything else is low priority cleanup.

## Related Issues

| Issue | Relationship |
|-------|-------------|
| 082 | Auth middleware is automatic (confirmed, drives cookieSecret removal) |
| 092 | Parent issue for all regressions and doc gaps |
| 093 | `mentra docs` CLI command for LLM doc access |