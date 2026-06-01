# SDK v3 Alignment — Spec

Round-2 alignment: bring the miniapp SDK surface as close to the cloud SDK v3 surface as makes sense. Builds on top of [`miniapp-sdk-surface-alignment-spec.md`](./miniapp-sdk-surface-alignment-spec.md), which already split events onto domain modules and shipped at `0.2.0`.

The motivation is consistency: an author who knows the cloud SDK should be able to read miniapp SDK code and follow it without a translation step. Today there are seven concrete gaps between the two — most cosmetic, two architecturally meaningful.

This spec consolidates them into one round so we can break the SDK once, cleanly, before any external authors pin to `0.2.0`. Target version after this round: `0.3.0`.

---

## What's actually different today

For full diff context see the analysis at the bottom of the previous brainstorm. Boiled down, the gaps fall into four buckets:

| Bucket | Items | Effort |
|---|---|---|
| **Trivial** — pure renames | `audio` → `speaker`, `microphone` → `mic`, `layouts` → `display` | Mechanical |
| **Small additions** — new methods on existing modules | `mic.stop()`, `transcription.stop()`, `hasPermission` getters | Each ≤ 10 LOC |
| **Medium reshapes** — API shape changes | Hoist transcription to top-level, multi-language `forLanguage`, `configure()`, phone sub-namespacing | One PR, real design choices |
| **Big additions** — new capability | `session.permissions` module + wire-protocol push for permission updates | Phone runtime + SDK |

Plus two judgment calls that need resolving even if the answer is "no change":

- **Three modules vs. one (`input` + `imu` + `glasses` vs `device`)** — cloud SDK v3 collapses; miniapp split.
- **Speaker stream-state observability** — v3 has it; we don't. Probably defer.

---

## Decisions to lock in now

### Decision 1 — Module rename to v3 names (locked)

| Old (`0.2.0`) | New (`0.3.0`) | Rationale |
|---|---|---|
| `session.audio` | `session.speaker` | v3's `SpeakerManager`. Output-only — name becomes literal. |
| `session.microphone` | `session.mic` | v3's `MicManager`. Just shorter, matches v3 exactly. |
| `session.layouts` | `session.display` | v3's `DisplayManager`. Glasses-display is the universal term. |

Keeping names: `session.camera`, `session.led`, `session.location`, `session.imu`, `session.glasses`, `session.phone`, `session.system`, `session.storage`, `session.stream`, `session.dashboard`, `session.events` (escape hatch). Plus a new `session.permissions`.

### Decision 2 — Hoist transcription + translation to top-level (locked)

```ts
// Old (0.2.0)
session.microphone.onTranscription(handler)
session.microphone.onTranslation(fromLang, toLang, handler)

// New (0.3.0) — mirrors v3
session.transcription.on(handler)
session.transcription.forLanguage("en-US", handler)
session.transcription.forLanguage(["en-US", "es-ES"], handler)
session.transcription.configure({languageHints, vocabulary, diarization})
session.transcription.stop()                        // tear down all subs

session.translation.forLanguagePair("en-US", "es-ES", handler)
session.translation.stop()
```

Reasons:

- **Consistent with v3.** Authors moving between the two SDKs don't have to rethink it.
- **The "this is a microphone thing" framing is wrong.** Transcription is text generation from speech — not a microphone-input event. The `microphone` module would still expose the lower-level `onAudioChunk` and `onVoiceActivity`.
- **Multi-language in one call.** `forLanguage([...])` is the killer feature; the previous overload didn't support it.

`session.mic` after this change exposes only:

```ts
session.mic.onAudioChunk(handler)
session.mic.onVoiceActivity(handler)
session.mic.stop()                  // tear down all mic-bound subs
session.mic.hasPermission           // getter — see Decision 4
```

### Decision 3 — Phone sub-namespacing (locked)

```ts
// Old (0.2.0)
session.phone.onNotification(handler)
session.phone.onCalendarEvent(handler)
session.phone.onBattery(handler)

// New (0.3.0) — mirrors v3
session.phone.notifications.on(handler)
session.phone.notifications.onDismissed(handler)
session.phone.notifications.hasPermission           // getter
session.phone.calendar.on(handler)
session.phone.calendar.hasPermission                // getter
session.phone.onBattery(handler)                    // stays flat — no sub-domain
```

Reasons:

- **Each sub-namespace cleanly owns its surface.** `phone.notifications.*` includes `on`, `onDismissed`, and `hasPermission` together — that's the v3 shape and it reads well.
- **`onDismissed` doesn't fit the flat namespace** — `session.phone.onNotificationDismissed` is awkward. v3's nested form is correct.
- **Phone battery stays flat** — single-event "sub-namespace" of just `phone.battery.on(...)` would be hollow.

### Decision 4 — `hasPermission` getters (locked)

Add a synchronous `hasPermission` getter to every module whose subscriptions require a manifest permission:

| Module | Permission |
|---|---|
| `session.mic` | `MICROPHONE` |
| `session.camera` | `CAMERA` |
| `session.location` | `LOCATION` |
| `session.phone.notifications` | `READ_NOTIFICATIONS` |
| `session.phone.calendar` | `CALENDAR` |
| `session.transcription`, `session.translation` | `MICROPHONE` (delegates to mic's) |

Reads from the cached manifest the runtime sends via CONNECT_ACK. Synchronous, cheap, used at the start of any code path that depends on the permission.

Note: this is permission **declaration in the manifest**, not OS-level **granted/denied** state. The miniapp SDK doesn't yet expose OS-grant state — that's bundled into Decision 6.

### Decision 5 — Add `stop()` methods (locked)

Tear-down-all-subs convenience on each domain that owns subscriptions:

```ts
session.mic.stop()
session.transcription.stop()
session.translation.stop()
session.phone.notifications.stop()    // new — convenience for tearing down all notification subs
session.phone.calendar.stop()
```

These are sugar over the existing per-handler unsubscribe-fn pattern. Useful for "clean up everything when route changes" without tracking N unsub functions. Each is a thin wrapper over the registry.

### Decision 6 — `session.permissions` module (locked, manifest-scoped to match v3 exactly)

New top-level module mirroring v3:

```ts
session.permissions.has(type: PermissionType): boolean
session.permissions.getAll(): PermissionRecord
session.permissions.onUpdate(handler: (perms: PermissionRecord) => void): UnsubscribeFn
session.permissions.onPermissionError(handler: (error) => void): UnsubscribeFn
```

`PermissionType` matches v3: `"location" | "microphone" | "camera" | "notifications" | "calendar"` (canonicalized to lowercase).

Read-only from the app's perspective. Populated from CONNECT_ACK. Re-fired via push when the **declared** set changes — e.g. when a developer re-scans a dev miniapp with an updated manifest, or when a store-installed miniapp's manifest changes on update.

**What "permission" means here.** Same as v3: this module tracks **manifest-declared** permissions. Its semantics:

| `permissions.has("microphone")` | meaning |
|---|---|
| `true` | the miniapp declared `MICROPHONE` in its manifest. SUBSCRIBE for mic-bound streams will not be rejected on declaration grounds. |
| `false` | the miniapp did NOT declare `MICROPHONE`. Calls that need it will fail with `PERMISSION_NOT_DECLARED`. |

It does **not** answer "did the user grant the OS prompt?" That is OS-grant state, a different concept. For miniapp authors: even when `has(...)` returns `true`, the user can still have denied the OS-level permission, and your subscriptions will simply not receive events. To detect that case in V1, observe whether your subscriptions actually receive data.

This matches v3's semantics by design — for cloud apps there is no OS layer between app and data, so manifest-declaration *is* the access gate. For local miniapps the OS layer exists but is intentionally not modeled in this module to keep the surface identical to v3.

**Out of scope (deferred to a future round if/when authors ask):**

- OS-level grant state (`isGranted(...)`).
- `request(type)` to trigger an OS prompt.
- Wire-protocol push for OS-grant changes (e.g. when the user toggles permission in iOS Settings while the miniapp is running).

When that work lands, it will live on this same module — additional methods like `isGranted("microphone")` / `request("microphone")` alongside the existing `has(...)` / `getAll(...)`. The future addition won't rename today's surface; it'll only add to it.

What ships in this round:

- New `MiniappResponseType.PERMISSIONS_UPDATE` envelope from phone (push when CONNECT_ACK or manifest re-registers — covers re-launch of dev miniapps with updated manifest).
- Phone runtime tracks the declared-permission set per app, sends update push when it changes.
- SDK module caches the latest set; `has()`/`getAll()` read from cache; `onUpdate` fires on cache change.
- `onPermissionError` plumbs the existing `PERMISSION_NOT_DECLARED` session-level error event into a typed handler. Works alongside the existing per-call error path.

Wire-protocol changes are minimal — one new response type. Phone-side code is mostly the cache + push logic.

### Decision 7 — Touch gesture filter overload (locked, with phone-runtime work)

Add v3's `onTouchEvent` overloads to `session.input.onTouch`:

```ts
session.input.onTouch(handler)                              // all touch events
session.input.onTouch("click", handler)                      // single gesture
session.input.onTouch(["scroll_top", "scroll_bottom"], handler)  // multi-gesture
```

**This requires phone-runtime work.** Today miniapp side has bare `touch_event` (single stream type). v3 uses `touch_event:<gesture>` per-gesture stream variants and the cloud fans out automatically. We need to mirror that:

- Phone runtime fans out incoming touch events to per-gesture stream subscribers as well as the bare stream.
- Wire-protocol stream type set extends with `touch_event:click`, `touch_event:double_click`, etc. — well-known suffixes.

Small but not pure-SDK work.

### Decision 8 — Three modules vs. one (locked: keep three)

Keep `session.input`, `session.imu`, `session.glasses` as separate modules. Reject v3's collapsed `session.device` shape.

Reasons:

- **Clear domain boundaries.** "input is for input, imu is for IMU, glasses is for the glasses device" reads naturally.
- **Discoverability via autocomplete.** `session.<dot>` shows the developer the surface area; collapsing into `device` hides what's there.
- **No real cost.** Three modules is fine; v3's collapse is more accident of cloud SDK history than deliberate pedagogy.

If we ever revisit, the cost is one rename — bearable. Track as future polish if external feedback ever asks.

### Decision 9 — Speaker stream-state observability (deferred)

v3's `SpeakerManager` has `onStateChange(state)` and an `AudioOutputStreamState` enum modeling playback as a state machine.

**Not in this round.** Reasons:

- Imperative `play()/speak()/stop()` is sufficient for the phone-WebView miniapp use case.
- Wire protocol doesn't currently push playback state; adding it is non-trivial.
- No author has asked for it.

Note in `HUMAN-TODO`. Revisit only if a real use case appears.

---

## Module surface after this round

```
session.permissions    NEW   has() / getAll() / onUpdate / onPermissionError
session.transcription  NEW   on() / forLanguage() / configure() / stop()
session.translation    NEW   forLanguagePair() / stop()
session.display        RENAMED from layouts
session.speaker        RENAMED from audio (output)
session.mic            RENAMED from microphone — input only, transcription/translation hoisted
                              onAudioChunk / onVoiceActivity / stop() / hasPermission
session.input          UNCHANGED (with onTouch gesture-filter overload added)
session.imu            UNCHANGED
session.glasses        UNCHANGED
session.phone          RESHAPED — sub-namespacing
                              .notifications.on / onDismissed / hasPermission / stop()
                              .calendar.on / hasPermission / stop()
                              .onBattery (stays flat)
session.location       UNCHANGED (gains hasPermission getter)
session.camera         UNCHANGED (gains hasPermission getter)
session.led            UNCHANGED
session.system         UNCHANGED
session.storage        UNCHANGED
session.stream         UNCHANGED
session.dashboard      UNCHANGED
session.events         UNCHANGED (subscribe escape hatch only)
```

15 modules total (was 14; `permissions` adds one; `transcription` and `translation` hoist out of `mic`).

---

## Wire-protocol changes

Two new message types:

```ts
MiniappResponseType.PERMISSIONS_UPDATE = "miniapp_permissions_update"
//   payload: {permissions: {location, microphone, camera, notifications, calendar}}

MiniappRequestType.TRANSCRIPTION_CONFIG = "miniapp_transcription_config"
//   payload: {languageHints?, vocabulary?, diarization?}
```

Plus the per-gesture `touch_event:<gesture>` stream-type expansion (Decision 7).

Phone runtime work:

- Track per-app declared-permission set; push `PERMISSIONS_UPDATE` on change.
- Forward `TRANSCRIPTION_CONFIG` to cloud STT layer.
- Fan out `touch_event` to per-gesture stream subscribers.

All else SDK-only.

---

## Backwards compatibility

SDK is at `0.2.0`. The example miniapp is the only consumer (and migrates in this PR). No external authors yet. **Clean break to `0.3.0`** — no deprecated aliases.

---

## Implementation surface

### SDK (`sdk/miniapp/src/`)

- New: `modules/permissions.ts`, `modules/transcription.ts`, `modules/translation.ts`.
- Renamed: `modules/audio.ts` → `modules/speaker.ts`, `modules/microphone.ts` → `modules/mic.ts`, `modules/layouts.ts` → `modules/display.ts`.
- Reshaped: `modules/phone.ts` — sub-namespaces (`PhoneNotificationsModule`, `PhoneCalendarModule`).
- Added: `hasPermission` getters across mic/camera/location/phone-sub-modules.
- Added: `stop()` methods on mic / transcription / translation / phone.notifications / phone.calendar.
- Updated: `modules/input.ts` — `onTouch` gesture-filter overload.
- Updated: `session.ts` — instantiate new modules, drop renamed ones, wire `_subscribe` and a new `_setPermissions(record)` for the permissions module's cache.
- Updated: `protocol.ts` — new response/request enum values.
- Updated: `index.ts` — export new module types, drop renamed-out names.
- Bumped to `0.3.0`.

### Phone (`mobile/src/services/`)

- `LocalMiniappRuntime.ts`: track declared-permission set per app; emit `PERMISSIONS_UPDATE` push on register/update.
- Touch-event fan-out: in addition to the bare `touch_event` stream, emit `touch_event:<gesture>` variants based on the incoming event's `kind` field.
- New transcription-config request handler: forward to cloud STT layer.

### Example (`sdk/example-miniapp/`)

Search-and-replace migration table:

| Before | After |
|---|---|
| `session.audio.*` | `session.speaker.*` |
| `session.microphone.onTranscription(...)` | `session.transcription.on(...)` or `.forLanguage(...)` |
| `session.microphone.onTranslation(from, to, h)` | `session.translation.forLanguagePair(from, to, h)` |
| `session.microphone.onAudioChunk(...)` | `session.mic.onAudioChunk(...)` |
| `session.microphone.onVoiceActivity(...)` | `session.mic.onVoiceActivity(...)` |
| `session.layouts.*` | `session.display.*` |
| `session.phone.onNotification(...)` | `session.phone.notifications.on(...)` |
| `session.phone.onCalendarEvent(...)` | `session.phone.calendar.on(...)` |
| `session.phone.onBattery(...)` | `session.phone.onBattery(...)` (unchanged) |

### Docs

- `agents/miniapp-sdk-overview.md` — module table refresh, `0.3.0` callout.

---

## Testing

- Unit-test `permissions` module: `has()`, `getAll()`, `onUpdate`. Stub the registry-update path.
- Unit-test new transcription methods: `forLanguage("en")`, `forLanguage(["en","ja"])`, `configure()` sends right envelope, `stop()` tears down.
- Migrate existing session.test.ts off renamed modules.
- Verify phone-side: scan-and-launch dev miniapp, observe `PERMISSIONS_UPDATE` envelope on launch, verify `session.permissions.getAll()` matches manifest.

Existing test counts: 83 SDK + 47 CLI. Should land at ~95 SDK after additions, 47 CLI unchanged.

---

## Sequencing

Suggested order, smallest-to-largest:

1. **Renames + `hasPermission` getters + `stop()` methods.** Pure SDK refactor. ~1 day.
2. **`session.permissions` module + phone-side `PERMISSIONS_UPDATE` push.** Phone work + SDK module + tests. ~2 days.
3. **Hoist transcription / translation + `forLanguage` + `configure()`.** SDK + new wire-protocol request type. ~2 days.
4. **Phone sub-namespacing for notifications/calendar.** SDK reshape, no phone work. ~1 day.
5. **Touch gesture-filter overload + phone fan-out.** SDK + phone runtime. ~1 day.
6. **Example migration + docs + 0.3.0 bump.** ~1 day.

End-to-end ~1 week of focused work. Steps 1-5 can land as separate PRs if useful; the renames in step 1 make every later diff churnier so they should go first.

---

## Acceptance criteria

- All 14 modules in the spec exist with the API shapes listed above.
- The example miniapp uses only the new surface; no `session.audio.*` / `session.microphone.onTranscription` / etc.
- `session.permissions.has("camera")` returns `true` when `CAMERA` is declared in `miniapp.json`, `false` otherwise.
- `session.permissions.onUpdate(handler)` fires on launch with the current set, and again if the manifest changes.
- `session.transcription.forLanguage(["en", "ja"], handler)` delivers events for both languages to the same handler.
- `session.transcription.configure({vocabulary: ["MentraOS"]})` produces a wire-level `miniapp_transcription_config` envelope.
- `session.phone.notifications.hasPermission` returns the right value.
- `session.input.onTouch("click", handler)` fires only for click events; multi-gesture variant works.
- `session.transcription.stop()` tears down every active transcription subscription.
- All test suites pass.

## Out of scope

- **OS-level grant state** and `request(...)` to trigger OS prompts. `session.permissions` only tracks manifest declarations in this round (matches v3's semantics exactly). Future work lands additively on the same module — `isGranted("microphone")` / `request("microphone")` etc. — without renaming the v1 surface. See Decision 6.
- Speaker stream-state observability (`onStateChange`).
- Renaming `session.input` / `session.imu` / `session.glasses` to a single `session.device`.
- `session.transcription`'s wildcard fan-out logic (already covered by today's `transcription:auto` behavior — preserve as-is).
- React hooks for the new modules (separate follow-up).
