# Less-React-y Example Miniapp — Spec

## Why

Feedback from the PR #2512 dev-ex round: the example miniapp is "super React-y in a bad way." The specific complaint isn't that the SDK requires React (it doesn't — `@mentra/miniapp` is framework-agnostic, with React behind the optional `/react` subpath). The complaint is that the *example* treats glasses behavior as a function of which React route is mounted.

Today's example (`sdk/example-miniapp/src/pages/CaptionsPage.tsx`-ish): the `CaptionsPage` component subscribes to transcription on mount, displays it, drives glasses on its `useEffect`. If the user navigates to the tester menu, transcription unsubscribes — the glasses go silent. That's the wrong shape for smart glasses.

Smart-glasses miniapps are *always-on services*. The webview is a UI on top of a continuously-running session. Tying glasses behavior to React lifecycle means the glasses stop working when the user navigates the phone.

The cloud SDK didn't have this problem because cloud miniapps had two processes — a server (the always-on glasses-controller) and a separate webview (the optional UI). The architectural separation forced the split. In the local-miniapp world both layers run in the same JS bundle, so we have to enforce the split *as a code-level pattern*.

## Research: how cloud miniapps do it

Surveyed six sibling cloud miniapps in `~/Programming/OSSG/`: Livestreamer, LiveTranslationOnSmartGlasses, Notify, Merge, Mentra-AI, Mentra-Notes.

Universal patterns across all six:

1. **Two-layer class structure.** The `XxxApp extends AppServer` is *thin* — its `onSession` callback gets/creates a per-user state container and delegates to it. All glasses-event subscriptions live inside that container, never inside the App class itself.
   - Examples: `MergeApp.onSession` → `User.setAppSession(session)` (Merge); `MentraAI.onSession` → `User.setAppSession(session)` (Mentra-AI); `NotesApp.onSession` → `notesSession.setAppSession(session)` (Mentra-Notes).
2. **The per-user container owns subscriptions.** `User.setAppSession(session)` registers `session.events.onTranscription`, `onLocation`, `onButtonPress`, etc. The `clearAppSession` method tears them down. This pair is called on connect/disconnect/reconnect and is idempotent.
3. **Manager-per-responsibility composition.** Mentra-AI is the most disciplined: `User` composes `TranscriptionManager`, `PhotoManager`, `InputManager`, `LocationManager`, `NotificationManager`, `ChatHistoryManager`, `QueryProcessor`, `AudioManager`, `StorageManager`. Each manager owns one concern and exposes `setup(session) / destroy()`. Mentra-Notes formalizes this with a `@manager` decorator.
4. **Single source of truth in the glasses-side container.** State (chat history, current notes, stream status, whatever) lives in the User/Session object. Webviews are read-only viewers + RPC callers; they don't hold authoritative state.
5. **Glasses → webview is event-stream-shaped.** SSE in most repos, WebSocket sync in Mentra-Notes. Always per-user broadcast: `broadcastInsight(userId, event)`, `broadcastChatEvent(userId, event)`, etc.
6. **Pending-event queue for "webview opens after first event".** Mentra-AI's `pendingEvents` map and Merge's `eventQueue` buffer events when no client is attached and replay on connect.
7. **Initial-state replay on webview connect.** Every SSE handler sends a `history` snapshot before live events.
8. **Webview → glasses is REST/RPC, never raw events.** Settings updates and commands are POST endpoints (or `@rpc` methods in Mentra-Notes) that mutate the User. Mutations cause broadcasts that re-render the webview.
9. **Subscriptions never depend on webview state.** Every glasses listener is registered in `onSession` / `User.setAppSession`. Webview routes only register a viewer client. This is the load-bearing pattern that prevents the React-route problem.
10. **Soft-disconnect grace period.** Both Merge and Mentra-AI keep the User alive for ~60s after disconnect (`SessionManager.softRemove`). Prevents losing state on transient disconnects.

## What we copy in the local case

The local miniapp runs in one bundle inside one WebView. There's no process boundary, no SSE, no REST. The patterns translate as:

| Cloud SDK pattern | Local SDK equivalent |
|---|---|
| `XxxApp extends AppServer` thin shell | `main.tsx` thin shell — instantiates session, instantiates the per-app controller, mounts React (if any) |
| `User` / `Session` per-user container | A single `Controller` / `Agent` class instantiated once at module init |
| `User.setAppSession(session)` | Controller subscribes on `session.on("ready")` |
| `clearAppSession` | Controller unsubscribes on `session.on("disconnect")` |
| Manager-per-responsibility composition | Same — controller composes per-concern modules |
| SSE broadcast to webview | In-process `EventEmitter` / Zustand store / valtio proxy that the React layer subscribes to |
| Pending-event queue | Same — controller buffers when no UI is mounted (or skip; in the local case the UI mounts almost immediately) |
| Webview → glasses RPC | Direct method call on the controller, e.g. `controller.setLanguage("fr")` |

The architectural shape is identical — what changes is the transport (in-process events instead of SSE, function calls instead of REST).

## Proposed example structure

```
sdk/example-miniapp/
├── miniapp.json
├── icon.png
├── server.ts                    # unchanged (Bun.serve)
├── index.html                   # unchanged
└── src/
    ├── main.tsx                 # entry: instantiate controller + render React
    ├── controller/              # ★ glasses-side logic, no React imports
    │   └── CaptionsController.ts   # owns ALL subscriptions inline (Merge-style for V1)
    ├── store/
    │   └── appStore.ts          # Zustand store; bridge from controller to React
    ├── pages/                   # ★ React-only, settings/UI surfaces
    │   ├── CaptionsPage.tsx       # reads from store; does NOT subscribe to session
    │   ├── SettingsPage.tsx
    │   └── tester/                # diagnostic; allowed to inline-subscribe (see rule below)
    └── ui/...
```

**Why one controller file, not a manager fleet:** The example does ~3 things (live captions, TTS, button events). Mentra-AI's per-concern manager fleet (`TranscriptionManager`, `PhotoManager`, `InputManager`, etc.) is appropriate when an app has 5+ distinct domains. For the example, splitting into managers is more file plumbing than the app warrants. **One `CaptionsController` class with inline `session.events.onTranscription` / `session.events.onButtonPress` handlers** is closer to Merge's `User.ts` shape — easier to read top-to-bottom for newcomers.

Document Mentra-AI-style as the recommended pattern when an app grows past ~5 concerns. Don't force it on the example.

### `main.tsx` shape

```ts
// pseudocode
import { MiniappSession } from "@mentra/miniapp"
import { CaptionsController } from "./controller/CaptionsController"
import { appStore } from "./store/appStore"

const session = new MiniappSession()
const controller = new CaptionsController(session, appStore)
controller.start()  // subscribes to session events, drives glasses display

session.connect().catch(console.error)

// React tree only renders UI; never touches session subscriptions
createRoot(document.getElementById("root")!).render(<App />)
```

The controller is *immortal* — it doesn't unmount when React routes change. Subscriptions are bound to session lifecycle, not component lifecycle.

### `CaptionsController.ts` shape

```ts
class CaptionsController {
  constructor(private session: MiniappSession, private store: AppStore) {}

  start() {
    this.session.on("ready", () => {
      this.unsub = this.session.events.onTranscription(data => {
        this.session.layouts.showTextWall(data.text)   // drive glasses
        this.store.setTranscript(data.text)             // notify UI
      })
    })
    this.session.on("disconnect", () => this.unsub?.())
  }
}
```

Glasses behavior is fully decoupled from React. Pages read `store` for display; they never subscribe to the session.

### React routes are settings + tester only

`CaptionsPage` becomes a *viewer* of the captions store, not an owner. It doesn't subscribe to transcription — it subscribes to `appStore.transcript` via `useStore`. Closing the page leaves the controller running, the glasses still showing captions.

### The tester-pages exception

The tester pages (`/tester/transcription`, `/tester/audio`, `/tester/storage`, etc.) are **diagnostic surfaces**, not user-facing logic. They exist to interactively probe SDK methods, observe events, and verify behavior. They subscribe to events on mount, display them inline, and tear down on unmount — exactly the pattern we're banning everywhere else.

This is fine because tester pages are ephemeral by design. They are not part of the always-on glasses behavior; they are a developer's debugging tool that happens to be rendered in the same WebView.

**The rule, stated precisely:**

> User-facing glasses logic must live in the controller. Diagnostic / tester pages may inline-subscribe directly to `session.*` because they are explicitly ephemeral.

Do not extend "controller through Zustand" to tester pages. That would require the controller to expose dozens of "start tester sub for X / stop tester sub for X" methods — turning the controller into a god object whose surface is dominated by debug-only concerns. The cost outweighs the consistency benefit.

Tester pages do `const session = useSession()` and inline `useEffect(() => session.events.onX(handler), [])`. That's the only place this pattern is OK.

## What changes in the SDK

Mostly nothing. The pattern works with the existing `MiniappSession` API. Two small ergonomic additions are worth considering:

1. **Document the controller pattern in the README and example.** The biggest barrier is that there's no existing example showing the right shape. This is largely a docs + example-restructure task.
2. **A `MiniappController` base class?** Optional. Could expose lifecycle hooks (`onStart`, `onStop`, `onReady`, `onDisconnect`) and own the un-subscription cleanup. Reduces boilerplate. But it's not necessary — the pattern works fine with plain classes.

I'd recommend ship without the base class first, see if authors want it, add later if so.

## Decisions

All locked in:

- **Repo to mirror: Merge-style (single controller class, inline handlers).** Mentra-AI's manager fleet is documented as the recommended pattern for apps with 5+ concerns; the example doesn't need it.
- **Vanilla (non-React) template variant: deferred.** Get the React example right first. `bunx create-mentra-miniapp --vanilla` is a 1-day follow-up after the controller pattern is proven.
- **Store: Zustand.** Parity with the rest of the `mobile/` codebase, well-understood, trivial React integration via `useStore(selector)`.
- **Soft-disconnect grace period: none in V1.** Local miniapps disconnect rarely. Add later if flicker becomes a real issue.
- **Tester pages keep inline-subscribe.** Documented as the explicit exception ("user-facing glasses logic uses the controller; diagnostic pages may inline-subscribe because they are ephemeral by design"). Do NOT extend Zustand to tester pages — would bloat the controller with debug-only methods.

## Acceptance criteria

- The example's "Live Captions" feature continues to work when the user navigates from the captions page to the tester menu (glasses keep showing captions, transcription doesn't stop).
- All glasses-driving subscriptions live in `src/controller/` files; React `pages/` files have no `session.events.*` calls except in the tester pages (where it's explicitly diagnostic).
- The README / overview doc gets a new section describing the controller pattern with a diagram and a "do this / don't do this" comparison.
- The pattern is described once and authoritatively — no scattered guidance.

## Out of scope

- Moving away from React entirely in the example. React stays.
- A `MiniappController` SDK base class. Defer.
- Cross-miniapp shared controllers / multi-app architecture. Out of scope.
- Hot-swappable controller (HMR-aware). Future.
- Persistence layer (server-state across reloads). Use `session.storage`, but documenting that pattern is out of scope here.

## Sequencing

1. Read the existing example more carefully to enumerate everything `CaptionsPage` and tester pages do today.
2. Write the new `controller/` layer. Move every `session.events.*` call out of pages into controllers.
3. Introduce the store (Zustand) and wire pages to read from it.
4. Verify: run the example, navigate between pages, confirm glasses keep working through transitions.
5. Update README + add a "controller pattern" section to `agents/miniapp-sdk-overview.md`.

Estimated 1-2 weeks of focused work. Most of it is moving code, not designing new pieces.

## What this spec doesn't decide

- Whether the controller pattern becomes the recommended default or just the example's choice. (Recommendation: recommended default; doc it as such.)
- Whether to ship a vanilla template variant. (Open question 2 above.)
- Anything about the SDK surface itself (covered in `miniapp-sdk-surface-alignment-spec.md`).
