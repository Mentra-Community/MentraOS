# Miniapp SDK Surface Alignment — Spec

## Why

Feedback from the PR #2512 dev-ex round, item #8: the new `@mentra/miniapp` SDK organizes its API more like the old cloud SDK (v2 shape) than the new cloud SDK (v3 shape). Specifically: events that should belong to a domain module are all hanging off `session.events` instead of being attached to the module that owns the corresponding capability.

The SDK is still at `0.1.0` and is unpublished. This is the right moment to fix the surface before any external consumer pins to it.

## Today's surface

From `sdk/miniapp/src/modules/events.ts` and `sdk/miniapp/src/index.ts`, all event subscriptions hang off `session.events`:

```ts
session.events.onTranscription(handler)
session.events.onTranslation(handler)
session.events.onButtonPress(handler)
session.events.onTouch(handler)
session.events.onHeadPosition(handler)
session.events.onLocation(handler)
session.events.onGlassesBattery(handler)
session.events.onPhoneBattery(handler)
session.events.onGlassesConnection(handler)
session.events.onPhoneNotification(handler)
session.events.onCalendarEvent(handler)
session.events.onVoiceActivity(handler)
session.events.onAudioChunk(handler)
```

Imperative methods sit on capability modules:

```ts
session.layouts.showTextWall(...)
session.audio.speak(...)
session.camera.takePhoto(...)
session.led.turnOn(...)
session.system.share(...)         // OS utilities
session.system.openUrl(...)
session.system.copyToClipboard(...)
session.system.download(...)
session.dashboard.setContent(...) // noop in v1
session.stream.startUnmanaged(...)
session.storage.get(...)
```

The mismatch: `session.audio.speak()` is on the audio module, but `session.events.onTranscription()` (which is also audio-input-related) is on a generic events module. Same for `session.camera.takePhoto()` and the missing `onPhotoTaken`. Etc.

## Cloud SDK v3 reference

In `cloud/packages/sdk/src/app/session/`:

- `events.ts` (current state — `onTranscription`, `onHeadPosition`, `onButtonPress`, `onLocation`, `onCalendarEvent`, `onPhoneNotifications`, etc. all here at lines 148-262).
- `modules/location.ts` — has `onLocation` already (line 42), wraps `session.events.onLocation`.
- `modules/audio.ts`, `modules/audio-output-stream.ts`, `modules/camera.ts`, `modules/led.ts`, `modules/simple-storage.ts` — capability modules, mostly imperative.

So v3 has *started* moving toward per-module event registration (location is the proof-point) but hasn't finished. The miniapp SDK should pick up where v3 was heading rather than copying v3's current half-state.

## Goal

Reorganize the miniapp SDK so each event hangs off the module that owns its domain. `session.events` either disappears or shrinks to a tiny escape-hatch module (`subscribe(rawStreamType, handler)` for forward compat, nothing else).

## Proposed module surface

Below is a candidate organization. Each section names the module, the rationale, and what hangs off it.

### `session.audio` — output only

Today: `speak`, `play`, `stop`. Stays output-only after the split.

```ts
session.audio.speak(text, opts)         // cloud TTS
session.audio.play({audioUrl})          // file / URL playback
session.audio.stop()
```

Output stays here because TTS and file playback share infra and have nothing to do with input capture. Naming matches developer intuition ("I want to play audio" → `session.audio.play`).

### `session.microphone` — audio input

```ts
session.microphone.onTranscription(handler)
session.microphone.onTranslation(handler)
session.microphone.onVoiceActivity(handler)   // VAD
session.microphone.onAudioChunk(handler)      // raw PCM
```

Split out from `audio` because the input surface is a different domain — different permission (`MICROPHONE`), different lifecycle (subscriptions vs imperative), different mental model. Cloud SDK v3's separation between `audio.ts` and `audio-output-stream.ts` hints at this; we make the split explicit at the API surface.

Future imperatives that belong here: `session.microphone.startCapture(opts)`, `session.microphone.mute()`, etc. — flagged but not in V1.

### `session.input` — physical control

```ts
session.input.onButtonPress(handler)
session.input.onTouch(handler)
```

Combined under `input` — two events, one domain ("how does the user interact with the glasses?"). Future input modes (gesture recognition, voice command, eye tracking) extend `session.input` rather than spawning new modules. The abstraction holds.

### `session.location`

```ts
// existing-or-new methods
session.location.onUpdate(handler)
// future: session.location.getOnce(), session.location.startTracking(opts)
```

Cloud SDK v3 has the location module as a starting point. Mirror it.

### `session.imu` — head position, motion

```ts
session.imu.onHeadPosition(handler)
// future: session.imu.onAcceleration(handler)
```

`headPosition` is IMU-derived, confirmed by the user. New module for V1 with just one event; expandable later.

### `session.glasses` — device-state events for the glasses themselves

```ts
session.glasses.onBattery(handler)
session.glasses.onConnection(handler)
// future: session.glasses.onModelChange, session.glasses.getStatus()
```

The cloud SDK calls this surface "device state" (`device-state.ts`). Recommend `session.glasses` as more concrete and developer-recognizable. Confirm naming.

### Phone surface — the open architectural question

This is the most interesting decision in the spec. Today, phone-related items are spread across two surfaces:

- `session.system.share / openUrl / copyToClipboard / download` — imperative phone-OS utilities.
- `session.events.onPhoneNotification / onCalendarEvent / onPhoneBattery` — phone-data event subscriptions.

The user explicitly raised: *"phone notifications, calendar — those are phone modules. But what do we put share/openUrl/copyToClipboard/download on? Those are also phone."*

Three plausible groupings:

#### Option A — single `session.phone.*` module

```ts
session.phone.onNotification(h)
session.phone.onNotificationDismissed(h)
session.phone.onCalendarEvent(h)
session.phone.onBattery(h)
session.phone.share(opts)
session.phone.openUrl(url)
session.phone.copyToClipboard(text)
session.phone.download(opts)
```

Pros: one surface, easy to find, the namespace is self-documenting.
Cons: `phone` becomes a grab bag — utilities, events, OS integration all in one. May get unwieldy.

#### Option B — split by capability

```ts
session.notifications.onReceived(h)
session.notifications.onDismissed(h)
session.calendar.onEvent(h)
session.battery.onPhone(h)        // or session.phone.onBattery
session.share.share(opts)
session.browser.openUrl(url)
session.clipboard.copy(text)
session.downloads.start(opts)
```

Pros: each module is single-purpose; matches `session.location` / `session.imu` style.
Cons: many small modules, navigation-heavy. `session.share.share()` reads awkwardly. Some are `phone` capabilities and some are `phone-OS` capabilities and the line is fuzzy.

#### Option C — hybrid

```ts
// imperative phone-OS utilities stay grouped
session.system.share(opts)
session.system.openUrl(url)
session.system.copyToClipboard(text)
session.system.download(opts)

// event surfaces split by domain
session.notifications.onReceived(h)
session.notifications.onDismissed(h)
session.calendar.onEvent(h)
session.glasses.onBattery(h)         // the glasses' battery
session.phone.onBattery(h)           // the phone's battery
```

Pros: imperative one-shots stay together (matches their nature — `system` reads as a kitchen-drawer of OS calls); event surfaces get domain-specific homes.
Cons: still has the `system` grab-bag; arguably the same problem as A but on a smaller surface.

### Decision: Option C with the battery split (locked in)

Keep `session.system` for phone-OS imperative one-shots (it's a reasonable name for "stuff that talks to the phone OS"). Split events by their natural domain. Resolve the battery question by putting `onBattery` on the device the battery belongs to: `session.glasses.onBattery` and `session.phone.onBattery`. Then `session.phone` becomes purely the phone-data event surface (notifications, calendar, battery), distinct from `session.system` (phone-OS imperatives).

That gives:

```ts
session.layouts          // glasses display imperative
session.audio            // audio output imperative (speak, play, stop)
session.microphone       // audio input events (transcription, translation, VAD, audio chunks)
session.input            // button + touch events
session.location         // location events (+ future imperatives)
session.imu              // head position + motion events
session.glasses          // glasses device-state events
session.phone            // phone device-state events (notifications, calendar, battery)
session.system           // phone-OS imperative utilities (share, openUrl, etc.)
session.camera           // photo imperative + future events
session.led              // LED imperative
session.dashboard        // dashboard imperative (noop in v1)
session.storage          // simple storage
session.stream           // streaming imperative
```

14 modules. Clean separation between events and imperatives where it matters. Audio I/O is split (`audio` for output, `microphone` for input) because the permission scoping, subscription lifecycle, and developer mental model differ. `system` and `glasses`/`phone` complement each other for non-audio surfaces.

## What disappears or shrinks

**Decision: `session.events` shrinks to a `subscribe(rawStreamType, handler)` escape hatch only.** All typed event subscriptions move to their owning domain modules; the escape hatch exists for forward-compat when a new event type ships before there's a wrapper module for it. Officially undocumented, available to advanced users. Avoids painting authors into a corner when we add new streams.

## Backwards compatibility

The SDK is at `0.1.0`. Nothing has been published. There are no external consumers. The example miniapp is the only consumer.

Recommend: **clean break.** Do not ship deprecated aliases on `session.events`. Update the example, update docs, ship `0.2.0` with the new surface.

## Type changes

Each module gets typed `Subscribable*` interfaces. The unsubscribe-fn return remains the same. Handler types unchanged.

The `MiniappStreamType` enum stays as the underlying wire-protocol identifier; modules wrap it. No protocol-level change — this is purely a JS API restructure.

## Decisions

All locked in:

- **Audio split: `session.audio` (output) and `session.microphone` (input).** TTS/play/stop on `audio`; transcription/translation/VAD/audio-chunks on `microphone`. Separates by permission, lifecycle, and mental model.
- **Input combined: `session.input`.** Button + touch under one module. Future input modes (gesture, voice command, eye tracking) extend `input`.
- **Phone-surface grouping: Option C with the battery split.** `session.system` for imperative phone-OS utilities; `session.phone` for phone-data events; `session.glasses.onBattery` and `session.phone.onBattery` for the two batteries.
- **`session.events` shrinks to `subscribe(rawStreamType, handler)` escape hatch.** Forward-compat for new event types not yet wrapped in domain modules. Officially undocumented.
- **Module naming uses the flatter form.** `session.glasses.onBattery`, not `session.glasses.battery.onChange`. Two-level nesting only when there's a real reason for it.
- **Stream subscriptions stay ref-counted via a shared internal registry.** New modules call into one shared `SubscriptionRegistry` (in `sdk/miniapp/src/internal/subscriptions.ts` or similar). Multiple subscribers to the same wire stream issue *one* SUBSCRIBE; unsubscribe only when the last goes away.
- **Backwards compatibility: clean break.** SDK is at `0.1.0`, nothing published, only the example consumes it. Ship `0.2.0` with the new surface, no deprecated aliases.
- **React hooks expansion deferred.** `useTranscription`, `useButtonPress`, `useLocation`, etc. land in a follow-up PR after the core surface stabilizes.

No spec-level unknowns remain. Implementation details (exact `SubscriptionRegistry` API shape, internal type names, etc.) settle during plan-writing.

## Implementation surface

1. Create new module files under `sdk/miniapp/src/modules/`: `microphone.ts`, `input.ts`, `imu.ts`, `glasses.ts`, `phone.ts`. Trim the existing `audio.ts` to output-only (move input events out to `microphone.ts`). Extend `location.ts` if needed.
2. Existing `events.ts` becomes the shared subscription registry plus the small `subscribe(rawStreamType, handler)` escape hatch. The internal registry is exported (under an `internal/` path) so all modules call the same `subscribe` / `unsubscribe` primitives.
3. Update `MiniappSession` (`sdk/miniapp/src/session.ts`) to instantiate each module and wire them through the same `sendOneShot` / `sendRequest` paths.
4. Update `sdk/miniapp/src/index.ts` exports — add new modules, drop typed event re-exports from `session.events`.
5. Update the example miniapp to use the new surface (will overlap with `miniapp-less-reacty-example-spec.md`).
6. Update `agents/miniapp-sdk-overview.md` modules table to reflect the 14-module list.
7. No protocol-level changes. The wire format (`MiniappStreamType` strings) stays exactly the same.

## Acceptance criteria

- Every event today on `session.events` is reachable from its owning domain module: `session.microphone.onTranscription`, `session.input.onButtonPress`, `session.imu.onHeadPosition`, `session.glasses.onBattery`, `session.phone.onNotification`, etc.
- The example miniapp uses only domain-module subscriptions; no `session.events.*` calls outside of tester pages (which may use the escape hatch directly per `miniapp-less-reacty-example-spec.md`).
- `session.events.subscribe(rawStreamType, handler)` continues to work as an undocumented escape hatch.
- Ref-counting semantics across the new modules behaves identically — multiple components subscribing to the same stream issue one wire-level subscribe.
- Audio output (`session.audio.speak`, `session.audio.play`, `session.audio.stop`) and audio input (`session.microphone.onTranscription`, etc.) are on separate modules.
- Documentation in `miniapp-sdk-overview.md` reflects the new 14-module surface; the table in that doc is the authoritative module list.

## Out of scope

- Protocol changes. The wire format stays.
- Any new event types. This is purely an organizational refactor.
- Renaming modules people already use (`layouts`, `camera`, `led`, `storage`, `dashboard`, `stream`). Leave those alone.
- React hooks expansion for new domain modules (`useTranscription`, etc.). Separate work.

## Sequencing

1. Implement new module files (`microphone.ts`, `input.ts`, `imu.ts`, `glasses.ts`, `phone.ts`); trim `audio.ts`. Keep `session.events` typed methods as forwarders during the transition so the example can migrate incrementally.
2. Migrate the example to the new surface (depends on `miniapp-less-reacty-example-spec.md` landing in parallel — they touch the same files).
3. Delete the `session.events` typed-method shims; keep only `subscribe(...)`. Ship the clean break.
4. Update overview doc + README with the new 14-module surface.

This is roughly 1 week of focused work. Implementation is mechanical now that the shape is decided.

## What this spec doesn't decide

- React hooks. Separate doc when needed.
- Adding new events / new domains. Future.
- The simulator transport (covered in `miniapp-browser-testing-simulator-spec.md`).
