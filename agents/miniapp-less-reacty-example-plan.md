# Less-Reacty Example — Implementation Plan

Implementation plan for [`miniapp-less-reacty-example-spec.md`](./miniapp-less-reacty-example-spec.md). The spec is fully decided; this doc is the *how*.

The headline goal: glasses behavior in the example is owned by a session-scoped controller, not by React route lifecycles. Closing the captions page leaves the controller running; the glasses keep showing transcription.

This is a focused example-only refactor. No SDK changes (the v3-aligned `0.3.0` API is the surface we build against). ~3-4 days of work — most of it moving code, not designing new pieces.

---

## Architecture overview

```
sdk/example-miniapp/src/
├── main.tsx                         entry; instantiates session, controller, renders React
├── controller/
│   └── GlassesController.ts         ★ owns ALL session subscriptions
│                                      Merge-style: single class, inline handlers
├── store/
│   └── appStore.ts                  Zustand store: bridge controller → React
├── pages/
│   ├── Shell.tsx                    unchanged-ish — layout chrome
│   ├── CaptionsPage.tsx             reads from store; NEVER subscribes to session
│   └── tester/                      diagnostic surfaces — allowed to inline-subscribe
│       ├── TesterMenu.tsx
│       ├── AudioPage.tsx
│       ├── DisplayPage.tsx
│       ├── EventsPage.tsx
│       ├── LedPage.tsx
│       ├── StoragePage.tsx
│       ├── SystemPage.tsx
│       └── ComingSoonPage.tsx
└── ui/                              unchanged
```

The class is **`GlassesController`** — generic. A developer copying this example as a starting point will keep the name, not rename it to match their app. "What controls the glasses?" → `GlassesController`.

(Earlier draft called it `CaptionsController`. That was wrong: it implies "Captions-app-specific" but is actually meant to be the canonical pattern. `GlassesController` is forkable.)

---

## The pattern, stated precisely

**Rule.** User-facing glasses logic must live in the controller. Diagnostic / tester pages may inline-subscribe directly to `session.*` because they are explicitly ephemeral.

The controller is *immortal* — instantiated once at module init, never unmounts, doesn't care which React route is active. Subscriptions are bound to session lifecycle, not component lifecycle. CaptionsPage becomes a *viewer* of `appStore.transcript`; it doesn't subscribe to transcription.

---

## File map

```
sdk/example-miniapp/
├── miniapp.json                     unchanged
├── icon.png                         unchanged
├── server.ts                        unchanged
├── index.html                       unchanged
├── package.json                     EXISTING — add zustand dep
└── src/
    ├── main.tsx                     REWRITE — instantiate session + controller before React
    ├── App.tsx                      unchanged (HashRouter)
    ├── controller/
    │   └── GlassesController.ts     NEW — single class, inline handlers
    ├── store/
    │   └── appStore.ts              NEW — Zustand store
    ├── pages/
    │   ├── CaptionsPage.tsx         REWRITE — reads from store, no session subs
    │   ├── Shell.tsx                unchanged
    │   └── tester/                  unchanged (inline-subscribe is OK here)
    └── ui/                          unchanged
```

7 files touched, 2 new.

---

## Decomposition (3 PRs)

### PR 1 — Controller + store skeletons (1-2 days)

**Goal:** infrastructure in place, but CaptionsPage still drives glasses. Nothing visible to users yet.

#### `package.json`

Add `zustand` to deps. Already used elsewhere in the broader codebase, so no new license/dep concerns.

#### `store/appStore.ts`

```ts
import {create} from "zustand"

interface AppStore {
  // Transcription state (live + history)
  liveTranscript: string
  history: string[]
  setLiveTranscript: (s: string) => void
  appendHistory: (s: string) => void
  clearHistory: () => void

  // Last button press shown in CaptionsPage's footer
  lastButton: string
  setLastButton: (s: string) => void

  // Settings the controller observes — UI mutates these, controller reads
  mirrorToGlasses: boolean
  setMirrorToGlasses: (v: boolean) => void
}

export const useAppStore = create<AppStore>((set) => ({
  liveTranscript: "",
  history: [],
  setLiveTranscript: (s) => set({liveTranscript: s}),
  appendHistory: (s) => set((st) => ({history: [...st.history, s]})),
  clearHistory: () => set({history: [], liveTranscript: ""}),

  lastButton: "",
  setLastButton: (s) => set({lastButton: s}),

  mirrorToGlasses: true,
  setMirrorToGlasses: (v) => set({mirrorToGlasses: v}),
}))
```

#### `controller/GlassesController.ts`

```ts
import type {ButtonPressData, MiniappSession, TranscriptionData} from "@mentra/miniapp"
import {useAppStore} from "../store/appStore"

/**
 * GlassesController — the always-on logic for this miniapp.
 *
 * Owns every subscription to the MiniappSession. Subscriptions are bound
 * to the session lifetime, NOT to any React component lifecycle. The
 * controller is instantiated once at module init in main.tsx and never
 * unmounts.
 *
 * React pages read from the appStore and call imperative methods on the
 * controller — they never subscribe to session events directly.
 *
 * Tester pages (src/pages/tester/) are an explicit exception — they're
 * diagnostic surfaces, ephemeral by design, and may inline-subscribe.
 *
 * If your miniapp grows beyond ~5 distinct concerns, consider splitting
 * the controller into per-concern manager classes (Mentra-AI's pattern).
 * For 1-3 concerns, keeping everything inline here is clearer.
 */
export class GlassesController {
  private unsubs: Array<() => void> = []
  private subscribed = false

  constructor(private readonly session: MiniappSession) {}

  /**
   * Wire subscriptions. Idempotent: noop if already wired. Subscriptions
   * stay alive for the entire session — they are NOT bound to any React
   * component's lifecycle.
   */
  start(): void {
    if (this.subscribed) return
    this.subscribed = true

    // The session queues outbound calls until CONNECT_ACK
    // (queue-before-ACK behavior in MiniappSession), so this works
    // regardless of whether the session is connected yet.

    this.unsubs.push(
      this.session.transcription.on((data: TranscriptionData) => {
        const store = useAppStore.getState()
        store.setLiveTranscript(data.text)
        if (store.mirrorToGlasses) {
          this.session.display.showTextWall(data.text)
        }
        if (data.isFinal && data.text.trim()) {
          store.appendHistory(data.text.trim())
          store.setLiveTranscript("")
        }
      }),
    )

    this.unsubs.push(
      this.session.input.onButtonPress((data: ButtonPressData) => {
        useAppStore.getState().setLastButton(`${data.buttonId} (${data.pressType})`)
      }),
    )
  }

  // ─── Imperative actions exposed to React UI ─────────────────────────────

  clearGlasses(): void {
    useAppStore.getState().clearHistory()
    this.session.display.clearView()
  }

  async speakSummary(): Promise<void> {
    const history = useAppStore.getState().history
    const last3 = history.slice(-3).join(". ")
    const phrase = last3 ? `Here's what was said: ${last3}` : "Nothing to summarize yet."
    try {
      await this.session.speaker.speak(phrase)
    } catch {
      /* swallow TTS error; UI can read session.speaker.state if it cares */
    }
  }

  /** Called only on full app teardown (rare in practice). */
  stop(): void {
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
    this.subscribed = false
  }
}

// Module-level singleton — accessed by main.tsx and any UI that needs to
// dispatch imperative actions.
let instance: GlassesController | null = null

export function getGlassesController(): GlassesController {
  if (!instance) {
    throw new Error(
      "GlassesController not yet initialized — call initGlassesController(session) first",
    )
  }
  return instance
}

export function initGlassesController(session: MiniappSession): GlassesController {
  if (instance) return instance
  instance = new GlassesController(session)
  instance.start()
  return instance
}
```

#### `main.tsx`

```tsx
import {createRoot} from "react-dom/client"
import {MentraProvider, useSession} from "@mentra/miniapp/react"

import App from "./App"
import {initGlassesController} from "./controller/GlassesController"
import "./index.css"

/**
 * Bootstrap shim — useSession() only works inside the React tree, so we
 * grab the shared session here and initialize the GlassesController on
 * first render (idempotent). Children mount immediately after.
 */
function Bootstrap() {
  const session = useSession()
  initGlassesController(session)
  return <App />
}

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <Bootstrap />
  </MentraProvider>,
)
```

The `Bootstrap` shim is necessary because `useSession()` only returns inside the React tree. The controller initializes on Bootstrap's first render — synchronous, no waiting. Children mount immediately after.

**At this stage CaptionsPage still subscribes itself — controller and page both run, the page wins via React state.** That's fine for PR 1; cleanup happens in PR 2.

**Acceptance:**
- `bun dev` runs without errors.
- App functions identically to today.
- `useAppStore.getState().liveTranscript` updates as transcription arrives (controller is wired).
- `getGlassesController().clearGlasses()` works from a console eval.

---

### PR 2 — Migrate CaptionsPage to read from store (1-2 days)

**Goal:** drop the page's `session.transcription.on(...)` and `session.input.onButtonPress(...)`. Page reads from store; controller drives session.

CaptionsPage diff:

- Remove the `useEffect(() => { const unsubs = [session.transcription.on(...), session.input.onButtonPress(...)]; ... }, [session, mirrorToGlasses])` block entirely.
- Replace local `useState` for `liveTranscript`, `history`, `lastButton`, `mirrorToGlasses` with `useAppStore` selectors.
- Remove inline `session.display.showTextWall(...)` — controller handles mirror-to-glasses based on `mirrorToGlasses` from the store.
- Replace `clearHistory` and `speakSummary` to call `getGlassesController().clearGlasses()` and `.speakSummary()`.

The `mirrorToGlasses` toggle becomes a Zustand setter: page UI checkbox updates `useAppStore.getState().setMirrorToGlasses(...)`. Controller reads `mirrorToGlasses` synchronously inside its transcription handler — always up-to-date because Zustand state is mutable across the boundary.

```tsx
// CaptionsPage.tsx — after migration
const liveTranscript = useAppStore((s) => s.liveTranscript)
const history = useAppStore((s) => s.history)
const lastButton = useAppStore((s) => s.lastButton)
const mirrorToGlasses = useAppStore((s) => s.mirrorToGlasses)
const setMirrorToGlasses = useAppStore((s) => s.setMirrorToGlasses)
const controller = getGlassesController()

// no useEffect with session subs

const onClear = () => controller.clearGlasses()
const onSpeak = () => controller.speakSummary()
const onToggleMirror = (v: boolean) => setMirrorToGlasses(v)
```

**Verification step (manual):** open CaptionsPage → say a phrase → navigate to TesterMenu → say another phrase. Glasses should keep updating. Today they don't.

**Acceptance:**
- `grep -n "session\." sdk/example-miniapp/src/pages/CaptionsPage.tsx` returns 0 matches except (if any) inside an explicitly tester-marked path. (CaptionsPage no longer uses `session` at all.)
- Navigating away from CaptionsPage and back: history is preserved (controller kept it).
- Mirror-to-glasses toggle works without refresh.

---

### PR 3 — Pattern documentation + tester-page audit (0.5-1 day)

**Goal:** the rule ("controller for user-facing logic, inline-subscribe only in tester pages") is documented authoritatively in one place, and the tester pages are audited to confirm they only subscribe to events for *display purposes* — not to drive any glasses state.

**Update `agents/miniapp-sdk-overview.md`:** new section right after the modules table, titled "Controller pattern (recommended for non-trivial apps)". Includes:

- The rule.
- Why the rule exists (always-on glasses logic shouldn't be tied to React lifecycle).
- The example as the reference, calling out `GlassesController` by name.
- The Mentra-AI manager-fleet pattern as the next-level pattern when 5+ concerns.

**Tester-page audit:** every tester page is checked to confirm it does NOT push display layouts, does NOT modify glasses state, only displays events. The current pages already do this — verify and document.

The tester pages also need a small comment header noting the inline-subscribe exception:

```tsx
// Tester pages are diagnostic surfaces — by design they subscribe to events
// directly via `session.*` and tear down on unmount. This is the ONLY place
// in the example where this pattern is acceptable; user-facing glasses
// logic must live in src/controller/GlassesController.ts.
```

**Acceptance:**
- Overview doc has the controller-pattern section, naming `GlassesController` as the reference.
- All 8 tester pages have the boilerplate exception comment.
- No tester page calls `session.display.show*` or `session.led.turnOn` etc. — only event subscriptions to display in the page.

---

## Tests

The example doesn't have a test suite today; it's explicitly a hand-tested reference app. **No new tests** for this work — the SDK tests already verify subscription/dispatch behavior. We'd be testing Zustand or the bootstrap shim.

Manual verification covers what tests would:

1. Navigate captions → tester → captions: history preserved.
2. Toggle mirror-to-glasses while on tester menu: takes effect when transcription arrives without re-mounting captions.
3. Cause an error mid-transcription (bad utterance): app stays alive, controller stays alive, subscription stays alive.
4. Live reload via `mentra-miniapp dev`: controller reinitializes cleanly (the singleton check protects against double-wire).

---

## Open items deferred to during-implementation

- **Soft-disconnect grace period:** confirmed in spec as "not in V1." Skip the implementation entirely. If transient disconnects become a real friction point we revisit.
- **Vanilla (non-React) template variant:** explicitly deferred per spec. The example stays React. A `--vanilla` flag for `create-mentra-miniapp` is a follow-up.
- **Mentra-AI-style manager fleet:** documented as the recommended pattern when an app grows past ~5 concerns; not implemented in the example since the captions app is small. The doc points future authors there.
- **Hot-reload-aware controller reinit:** the `instance` singleton + `subscribed` guard handle the live-reload case; if there's edge breakage during dev (e.g. orphaned subs), revisit.

---

## Sequencing recommendation

1. **PR 1 (skeletons)** — controller + store + bootstrap. Ships invisible-to-users; CaptionsPage still owns the subs. Lets us verify the controller wiring without breaking anything.
2. **PR 2 (migrate CaptionsPage)** — drop the page's subs; rely entirely on controller + store. Visibly fixes the navigate-away-loses-glasses bug.
3. **PR 3 (docs + tester audit)** — pure docs + comments. Lock the rule in.

Each PR is independent enough to review separately. **Total: 3-4 days of focused work.**

---

## Migration / breaking changes

**None for SDK consumers.** This is example-internal refactoring.

For anyone copying the example as a starting point: the new structure is the recommended path. The class is named `GlassesController` so a fork can keep the name (it describes what the class does, not what the example does). Old copies still work because the SDK API is unchanged.
