# SDK Surface Alignment — Implementation Plan

Implementation plan for [`miniapp-sdk-surface-alignment-spec.md`](./miniapp-sdk-surface-alignment-spec.md). The spec is fully decided; this doc is the *how*, not the *what*.

Plan-level decisions (locked during the brainstorm before writing this):

- **Q1.** Modules call session-internal `_subscribe(streamType, handler)`; ref-counting registry lives on the session (via the existing `EventManager`).
- **Q2.** Keep the `EventManager` class file but shrink its public surface to only `subscribe(rawStreamType, handler)` (the escape hatch). Typed methods (`onTranscription`, etc.) move to domain modules.
- **Q3.** Inbound event dispatch stays on `EventManager._forwardEvent`. Modules don't see raw stream types.
- **Q4.** Keep the existing `onTranscription(handler)` / `onTranscription("en-US", handler)` overload shape. Cloud SDK v3 has a different shape (`transcription.on()`, `transcription.forLanguage()`, `transcription.configure()`, `transcription.stop()`) — noted as a possible future polish but out of scope for this round.
- **Q5.** Inline module construction in `MiniappSession`'s constructor.
- **Q6.** Same PR migrates the example. No `session.events` typed forwarders.
- **Q7.** Drop redundant prefixes once the namespace carries them (`onBattery`, `onNotification`); keep `Event`/`Position` where dropping them would be too vague.
- **Q8.** No imperative method stubs. Ship what exists; future imperatives land separately.

---

## File map

```
sdk/miniapp/src/
├── modules/
│   ├── audio.ts              EXISTING — trim to output-only (remove input subs)
│   ├── camera.ts             EXISTING — unchanged
│   ├── dashboard.ts          EXISTING — unchanged
│   ├── events.ts             EXISTING — shrink to subscribe() only + internal _forwardEvent
│   ├── glasses.ts            NEW
│   ├── imu.ts                NEW
│   ├── input.ts              NEW
│   ├── layouts.ts            EXISTING — unchanged
│   ├── led.ts                EXISTING — unchanged
│   ├── location.ts           NEW (today's location event lives in events.ts)
│   ├── microphone.ts         NEW (input audio events: transcription/translation/audio chunk/VAD)
│   ├── phone.ts              NEW
│   ├── storage.ts            EXISTING — unchanged
│   ├── stream.ts             EXISTING — unchanged
│   └── system.ts             EXISTING — unchanged
├── session.ts                Add module instantiations; expose private _subscribe
└── index.ts                  Add new module type exports; remove typed event re-exports
```

## Module-by-module API surface

```ts
// session.audio — output only
session.audio.speak(text, opts?)
session.audio.play({audioUrl})
session.audio.stop()

// session.microphone — audio input events
session.microphone.onTranscription(handler)
session.microphone.onTranscription(language, handler)            // overload
session.microphone.onTranslation(fromLang, toLang, handler)
session.microphone.onAudioChunk(handler)
session.microphone.onVoiceActivity(handler)

// session.input — physical control events
session.input.onButtonPress(handler)
session.input.onTouch(handler)

// session.location — location events
session.location.onUpdate(handler)

// session.imu — head position + motion
session.imu.onHeadPosition(handler)

// session.glasses — glasses device-state events
session.glasses.onBattery(handler)
session.glasses.onConnection(handler)

// session.phone — phone device-state events
session.phone.onNotification(handler)
session.phone.onCalendarEvent(handler)
session.phone.onBattery(handler)

// session.events — escape hatch only (undocumented in user-facing docs)
session.events.subscribe(rawStreamType, handler)
```

Existing modules (`layouts`, `camera`, `led`, `storage`, `dashboard`, `stream`, `system`) keep their current shapes verbatim.

## EventManager refactor (events.ts)

Today, `EventManager` exposes typed methods (`onTranscription`, `onButtonPress`, etc.) plus a private `_forwardEvent`. After the refactor:

- All typed methods deleted from the public surface. They re-appear on their owning domain modules.
- `subscribe(rawStreamType, handler)` is the only public method. Documented as an escape hatch.
- Ref-counting + wire `SUBSCRIBE` send unchanged.
- `_forwardEvent(streamType, data)` stays internal; `MiniappSession.handleIncoming` calls it.

The existing `events.ts` file goes from ~250 lines to ~80. Most of the deleted code is the typed wrapper methods, which are now in domain modules.

## Domain module pattern

Each new module follows the same shape — a thin wrapper that calls `session._subscribe`. Example for the simplest case (`glasses.ts`):

```ts
import {MiniappStreamType} from "../protocol"
import type {MiniappSession} from "../session"
import type {BatteryData, ConnectionData, UnsubscribeFn} from "./events"

export class GlassesModule {
  constructor(private readonly session: MiniappSession) {}

  onBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_BATTERY, handler as (data: unknown) => void)
  }

  onConnection(handler: (data: ConnectionData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_CONNECTION, handler as (data: unknown) => void)
  }
}
```

`microphone.ts` is the only one with a non-trivial method (the overload for `onTranscription` language variants).

## Session changes (session.ts)

Inline instantiation in the constructor:

```ts
this.audio = new AudioModule(this)
this.camera = new CameraModule(this)
this.dashboard = new DashboardAPI(this)
this.events = new EventManager(this)
this.glasses = new GlassesModule(this)
this.imu = new ImuModule(this)
this.input = new InputModule(this)
this.layouts = new LayoutManager(this)
this.led = new LedModule(this)
this.location = new LocationModule(this)
this.microphone = new MicrophoneModule(this)
this.phone = new PhoneModule(this)
this.storage = new SimpleStorage(this)
this.stream = new StreamModule(this)
this.system = new SystemModule(this)
```

15 lines (alphabetized for readability — fine for a constructor block).

New private method on session — `_subscribe(streamType, handler)`. Internally just delegates to `this.events.subscribe(...)` since EventManager holds the ref-count registry. Underscore prefix signals "module-internal, not part of the public SDK surface."

`handleIncoming` keeps its current shape — `session.events._forwardEvent(streamType, data)` for `MiniappResponseType.EVENT` envelopes.

## Index exports (index.ts)

Add module type exports:

```ts
// New module types
export type {GlassesModule} from "./modules/glasses"
export type {ImuModule} from "./modules/imu"
export type {InputModule} from "./modules/input"
export type {LocationModule} from "./modules/location"
export type {MicrophoneModule} from "./modules/microphone"
export type {PhoneModule} from "./modules/phone"
```

Remove the typed event method re-exports that previously hung off `EventManager`'s public surface — they're typed via the domain modules now. The `events` data type re-exports (`TranscriptionData`, `ButtonPressData`, etc.) stay; they're handler argument types and consumers still need them.

## Example migration (sdk/example-miniapp)

Search-and-replace through `sdk/example-miniapp/src/`:

| Before | After |
|---|---|
| `session.events.onTranscription(...)` | `session.microphone.onTranscription(...)` |
| `session.events.onTranslation(...)` | `session.microphone.onTranslation(...)` |
| `session.events.onAudioChunk(...)` | `session.microphone.onAudioChunk(...)` |
| `session.events.onVoiceActivity(...)` | `session.microphone.onVoiceActivity(...)` |
| `session.events.onButtonPress(...)` | `session.input.onButtonPress(...)` |
| `session.events.onTouch(...)` | `session.input.onTouch(...)` |
| `session.events.onHeadPosition(...)` | `session.imu.onHeadPosition(...)` |
| `session.events.onLocation(...)` | `session.location.onUpdate(...)` |
| `session.events.onGlassesBattery(...)` | `session.glasses.onBattery(...)` |
| `session.events.onGlassesConnection(...)` | `session.glasses.onConnection(...)` |
| `session.events.onPhoneBattery(...)` | `session.phone.onBattery(...)` |
| `session.events.onPhoneNotification(...)` | `session.phone.onNotification(...)` |
| `session.events.onCalendarEvent(...)` | `session.phone.onCalendarEvent(...)` |

Tester pages and the controller (when the less-Reacty-example spec lands) get the same treatment.

## Version bump

`sdk/miniapp/package.json`: `0.1.0` → `0.2.0`. Clean break, no deprecation aliases.

`sdk/miniapp-cli/package.json`, `sdk/create-mentra-miniapp/package.json`: leave at `0.1.0` — they don't expose the SDK API surface.

## Documentation

Update `agents/miniapp-sdk-overview.md` modules table to list all 14 modules in the new layout. Add a one-line entry for `events.subscribe()` as the escape hatch (advanced/forward-compat).

## Tests

The existing `events` tests need to flow with the new module locations:

- `session.test.ts` — only one place that `session.events.*` shows up via `showTextWall` (post-ACK queue test). The fix from the previous commit already accounts for layout's nested `text` field; no further test changes needed.
- `envelope.test.ts`, `protocol.test.ts` — wire-protocol level, unaffected.

Add minimal smoke tests for the new modules — at least one test per module verifying that calling its method correctly invokes `session._subscribe` with the right stream type. Skip the per-handler integration tests; the ref-counting + wire-format tests already exist on `EventManager` and we're not changing that path.

## Sequencing

One commit per logical chunk so review is easy:

1. **EventManager shrink + new module skeletons** — events.ts trimmed; glasses/imu/input/location/microphone/phone/audio (trimmed) all created with stub signatures.
2. **Wire into session** — `_subscribe` method on session; instantiate all modules in constructor; index.ts exports.
3. **Example migration** — search-and-replace the example's 13 call sites.
4. **Smoke tests** — minimal per-module tests.
5. **Docs + version bump** — overview doc table; 0.2.0.

Estimated 1 week of focused work; biggest single piece is the example migration since the test pages exercise every event type.

---

## Future polish (not this PR)

- **Cloud-SDK-v3-style transcription API**: `session.microphone.transcription.on(handler)` / `.forLanguage("en", handler)` / `.configure({languageHints, vocabulary, diarization})` / `.stop()`. v3 has a meaningfully cleaner shape with multi-language subscriptions and config. Worth revisiting once this spec ships and we've seen authors use the simple overload.
- **React hook expansion**: `useTranscription`, `useButtonPress`, `useLocation` etc. — listed as deferred in HUMAN-TODO.
- **Imperative methods**: `session.microphone.startCapture(opts)`, `session.location.getOnce()`, etc. — drop in when the wire-protocol counterparts exist.
