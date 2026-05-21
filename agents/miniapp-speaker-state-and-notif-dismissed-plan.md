# Speaker state observability + notifications.onDismissed — Plan

Two small additions on top of the v3 alignment shipped in `0.3.0`. Both
were noted as deferred in the v3-alignment spec — building them now.

- **Speaker state observability** — `session.speaker.onStateChange(handler)`,
  `session.speaker.state`, `session.speaker.isPlaying`. Per-miniapp playback
  state machine.
- **`session.phone.notifications.onDismissed(handler)`** — Android-only.
  iOS no-ops with the same console.warn it has today (Apple doesn't expose
  dismiss callbacks to apps).

Both ride on existing phone-side wiring; this is mostly SDK plumbing plus a
couple of new wire-protocol envelope types.

---

## #1 — Speaker state observability

### Public API

```ts
type SpeakerState = "idle" | "loading" | "playing" | "stopped" | "error"

session.speaker.state                       // current state, sync getter
session.speaker.isPlaying                   // sync getter, true iff state === "playing"
session.speaker.onStateChange(handler)      // fires on every transition
```

`onStateChange` payload:

```ts
interface SpeakerStateEvent {
  state: SpeakerState
  /** When state === "error", the underlying error code (TTS_*, INTERNAL). */
  errorCode?: string
  errorMessage?: string
  /** Set when state === "stopped" — milliseconds the playback ran. */
  durationMs?: number
}
```

### State machine (per miniapp)

```
idle ─── speak()/play() ──► loading ─── playback starts ──► playing
                                │                              │
                                │                              ▼
                                │                        stop() / completion
                                │                              │
                                │                              ▼
                                └── error from TTS/load ──► stopped
                                                               │
                                                               ▼
                                       (next call) ─────► loading
                                error path: error ──► (settles to stopped after handler fires)
```

`error` is a transient state — fires once with `errorCode` set, then settles
to `stopped`. This means `isPlaying` correctly reads `false` after an error,
without forcing the developer to handle a sticky error state.

`loading` is for the gap between "I called speak()" and "audio is actually
playing." For TTS this is the cloud fetch + buffering; for `play(url)` it's
the HTTP fetch + decoder warm-up.

### Wire protocol

New `MiniappResponseType.SPEAKER_STATE` envelope. Phone push, no requestId.

```ts
{
  type: "miniapp_speaker_state",
  state: "idle" | "loading" | "playing" | "stopped" | "error",
  errorCode?: string,
  errorMessage?: string,
  durationMs?: number,
}
```

Sent per-miniapp.

### Phone-side (LocalMiniappRuntime)

Per-app `speakerState` field on `ConnectedMiniapp`. Helper `setSpeakerState(packageName, next, extra?)`:

- Updates the cached state.
- Pushes `SPEAKER_STATE` envelope to that miniapp.
- Idempotent on no-change.

`handlePlayAudio` and `handleSpeak`:

1. Set state to `loading` immediately when the request arrives.
2. Set state to `playing` after `audioPlaybackService.play(...)` returns
   (best-effort optimistic timing — matches v3's approach).
3. The existing onComplete callback already fires when playback finishes /
   errors / is interrupted. On success → `stopped` (with durationMs); on
   error → `error` (with errorCode/message), then immediately settle to
   `stopped` so isPlaying reads false.

`handleStopAudio`: set state to `stopped` after `stopForApp` call.

`unregisterApp`: state already gone since the whole entry is dropped.

### SDK side

`SpeakerModule` gains:

- Private `_state: SpeakerState = "idle"`.
- `state` and `isPlaying` getters.
- `onStateChange(handler)` returning UnsubscribeFn.
- `_applyState(payload)` internal called from session.handleIncoming.

`MiniappSession.handleIncoming` adds a `SPEAKER_STATE` case; emitter map
gains a `speakerState` event.

---

## #2 — `phone.notifications.onDismissed` (Android)

### Public API

```ts
session.phone.notifications.onDismissed((event) => {
  // event.notificationId
  // event.notificationKey
  // event.packageName
  // event.timestamp
})
```

The console.warn placeholder shipped in 0.3.0 goes away. Real subscriber.

iOS: still no-ops. The CoreModule listener for `phone_notification_dismissed`
on iOS doesn't fire (Apple doesn't expose dismiss callbacks). The SDK
doesn't need an iOS-specific code path; it just never receives events.
Document this limitation in the JSDoc.

### Wire protocol

New stream type `MiniappStreamType.PHONE_NOTIFICATION_DISMISSED`.
READ_NOTIFICATIONS permission required (same as the post event).

### Phone-side (MantleManager)

The existing listener for `phone_notification_dismissed` already forwards
to `restComms.sendPhoneNotificationDismissed`. Add a sibling
`localMiniappRuntime.forwardEvent("phone_notification_dismissed", payload)`
call right next to it.

### Phone-side (LocalMiniappRuntime)

`permissionForStream` gains the new mapping.

### SDK side

`PhoneNotificationsModule.onDismissed(handler)`:

- Drop the no-op + console.warn.
- Wire to `_subscribe(MiniappStreamType.PHONE_NOTIFICATION_DISMISSED, handler)`.
- Track in the existing `unsubs` set so `stop()` tears it down too.

New `NotificationDismissedData` interface in `events.ts`:

```ts
export interface NotificationDismissedData {
  notificationId: string
  notificationKey?: string
  packageName?: string
  timestamp: number
}
```

Re-exported from index.ts.

---

## File touches

### #1 — Speaker state

- `sdk/miniapp/src/protocol.ts` — add `SPEAKER_STATE` to `MiniappResponseType`.
- `sdk/miniapp/src/modules/speaker.ts` — add `onStateChange`, `state`,
  `isPlaying`, internal `_applyState`.
- `sdk/miniapp/src/session.ts` — add `speakerState` to emitter event map;
  handle `SPEAKER_STATE` envelope in `handleIncoming`.
- `mobile/src/services/LocalMiniappRuntime.ts` — per-app speaker-state
  cache + push helpers; thread through `handlePlayAudio`, `handleSpeak`,
  `handleStopAudio`.

### #2 — Notifications dismissed

- `sdk/miniapp/src/protocol.ts` — add `PHONE_NOTIFICATION_DISMISSED` stream type.
- `sdk/miniapp/src/modules/events.ts` — `NotificationDismissedData` interface.
- `sdk/miniapp/src/modules/phone.ts` — replace no-op `onDismissed` with real impl.
- `sdk/miniapp/src/index.ts` — re-export `NotificationDismissedData`.
- `mobile/src/services/LocalMiniappRuntime.ts` — extend
  `permissionForStream` mapping.
- `mobile/src/services/MantleManager.ts` — forward `phone_notification_dismissed`
  to localMiniappRuntime alongside the existing restComms forward.

## Sequencing

1. Wire protocol additions.
2. Phone-side notifications dismissed (small).
3. SDK-side phone.notifications.onDismissed (replace stub).
4. Phone-side speaker state machine + push helper.
5. SDK-side speaker state plumbing.
6. Tests for both.
7. Commit.
