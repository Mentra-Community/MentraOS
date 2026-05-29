# Navigation Mini-App: App-Wide UI State Persistence Plan

## Goal

When the user closes the WebView and re-opens it (while the background JSContext
keeps running the trip), **the entire UI restores to exactly where it was** —
current page/route, selected destination, search state, dev toggles, drawer, the
AddPlace page they were on, etc. Not a drawer-specific patch: everything that was
on screen comes back.

## Two kinds of state (the key distinction)

The app holds two fundamentally different kinds of state, and they restore by
different mechanisms:

1. **Live trip state** — coords, heading, `TripState` (status, running,
   maneuver, activeDestination, route), pivots. **Owned by the background**,
   already streamed via `nav:snapshot` + hot channels. This is always *current*,
   never a stale photo. The UI store (`navStore.ts`) already hydrates it
   correctly on open.

2. **Pure UI state** — which route/page, selected `destination`, preview
   route/summary, `isSearching` + search query, drawer override, dev toggles,
   AddPlace form fields. **Owned only by the React tree.** The background has no
   idea these exist, so they are **destroyed on every WebView teardown.**

App-wide persistence = restore category 1 from the live background snapshot
(already works) **and** restore category 2 from a persisted UI-state blob.

## Decisive constraint: the WebView is fully destroyed on close

Confirmed in the host shim (`mobile/modules/island/src/services/mentraUiShim.ts`):
on close the WebView's JS context is **fully torn down** — in-memory state,
`sessionStorage`, and `localStorage` are all gone; a fresh shim runs on the next
open. **Therefore UI state cannot be persisted inside the WebView.** It must be
shipped to the **background** (which stays alive across opens, and has on-disk
storage that even survives an app kill).

This is why the chosen design is: **persist UI state through the background.**

## Design

```
┌─────────── WebView (short-lived) ───────────┐        ┌─── Background (persistent) ───┐
│ UI state (Zustand "ui" slice)               │        │ cachedUIState (in memory)     │
│   on any change ──ui:state-changed──────────┼───────▶│   merge + debounce-persist    │
│                                             │        │   SimpleStorageManager (disk) │
│   on open  ◀─────────── ui:state ───────────┼────────│   onOpen → send(ui:state)     │
└─────────────────────────────────────────────┘        └───────────────────────────────┘
        live trip already restored via nav:snapshot (unchanged)
```

- **Save:** the WebView broadcasts `ui:state-changed` (partial) whenever UI state
  changes. The background merges into `cachedUIState` and debounce-writes it to
  disk via `SimpleStorageManager`.
- **Restore:** on `ui.onOpen` the background sends a `ui:state` broadcast (next to
  the existing `nav:snapshot`). The UI applies it into the store and the pages
  initialize from the store instead of fresh `useState` defaults.

### Conflict rule (live trip wins)

When restored UI state and the live trip disagree (e.g. saved "previewing X" but
the trip already arrived while the WebView was closed), **the live `nav:snapshot`
wins for anything trip-related.** UI state only fills what the background doesn't
own (the pre-trip selection, search text, dev toggles). Apply order on open:
restore `ui:state` first, then let `nav:snapshot` + hot channels overwrite the
trip fields. This avoids showing a stale trip.

## Centralize UI state in the store (so persistence is one mechanism)

Today each page holds its own `useState`. To persist "everything" without
hand-wiring every field, move the persist-worthy UI state into a **`ui` slice on
the Zustand store** (`navStore.ts`). Pages read/write the slice instead of local
`useState`. Then one subscriber serializes the whole slice on change, and one
action rehydrates it on open. New UI state added later is covered automatically
if it lives in the slice.

### What goes in the persisted `ui` slice

From the inventory (`NavigationPage.tsx`, `AddPlacePage`, `LocationSearch`,
`router.tsx`):

| Field | Source | Persist? |
|------|--------|----------|
| `route` (router stack top: navigation / add-place + presetType) | router.tsx | **Yes** |
| `destination` (selected place) | NavigationPage:196 | **Yes** |
| `isSearching` | NavigationPage:222 | **Yes** |
| `searchQuery` (LocationSearch query) | LocationSearch:51 | **Yes** |
| `devDrawer` override | NavigationPage:235 | **Yes** |
| `simulatorMode`, `simulate`, `speedMultiplier`, `wrongSidewalk`, `skipCrossings`, `travelMode`, `searchFrozen`, `rawMapOpen` | NavigationPage:220-240 | **Yes** (dev) |
| AddPlace form: `customName`, `query`, `selectedPlace`, `searchOpen`, `focused` | AddPlacePage:34-39 | **Yes** (only meaningful if `route === add-place`) |
| `previewRoutePoints`, `previewTurns`, `previewRouteSummary` | NavigationPage:242-255 | **No** — re-derived from `destination` via `computeRoute` on restore |
| `savedPlaces`, `recentSearches`, `suggestions` | RPC-backed | **No** — re-fetched via `storage:*` / `places:*` |
| `loading`, `error` | transient | **No** — reset to idle on restore |

Rule of thumb: persist *intent/selection/position*; re-derive *data* and reset
*transient* flags.

## Tricky bits to get right

1. **Router restore (History API).** The router's stack is React state seeded
   into the History API; a fresh WebView has a fresh history cursor. To restore
   `route === {add-place}` we must rebuild BOTH the React stack AND re-seed
   history to the right depth **without firing popstate** (popstate would pop the
   route). Plan: on rehydrate, `replaceState` the base entry, then `pushState`
   one entry per extra stack level, and set the React stack directly — mirroring
   the existing seed logic at `router.tsx:87` and the push at `:105`, but in a
   "silent restore" path. Verify the iOS back-swipe (`allowsBackForwardNavigation
   Gestures`, bound to stack depth) still behaves.

2. **First-paint flash.** `ui:state` and `nav:snapshot` arrive shortly after
   mount. If pages render with default `useState` first, the user sees idle for a
   frame, then a jump. Gate the top-level render on a `hydrated` flag that flips
   true once the first `ui:state` (or a short timeout) lands, so we paint the
   restored UI directly. (Store already has a natural place for this flag.)

3. **Save cadence / loops.** `ui:state-changed` on every keystroke is chatty and
   could feedback-loop if a restore re-triggers a change. Debounce the save
   (e.g. 250-500ms) and make rehydrate set state without re-broadcasting (apply
   via a dedicated action that doesn't fire the save subscriber, or guard with a
   "restoring" flag).

4. **Staleness window.** Disk-persisted UI state can be old (app was killed days
   ago). On restore, if there's no active trip and the saved `destination` is
   stale, that's fine (user can re-pick). Consider a TTL or version stamp so a
   schema change doesn't rehydrate garbage — store `{version, savedAt, state}`
   and drop on version mismatch.

5. **Don't double-own the trip.** The persisted `destination` must NOT override
   the live trip's `activeDestination`. Keep the conflict rule: trip fields come
   from `nav:snapshot`; `ui` slice supplies only the pre-trip selection. When a
   trip is running, the running drawer should read the trip's destination (this
   is also the original drawer bug — solved for free once the slice + snapshot
   apply order is correct).

## Implementation steps

1. **Define `UIPersistedState`** in `src/shared/types.ts` (the fields table
   above), plus a `{version, savedAt, state}` envelope for the disk blob.

2. **Add channels** in `src/shared/channels.ts`:
   - `"ui:state-changed": Partial<UIPersistedState>` — UI → background, fire-and-forget.
   - `"ui:state": UIPersistedState` — background → UI, broadcast on `onOpen`.

3. **Background** (`src/background/NavigationController.ts`):
   - Hold `cachedUIState`, load from `SimpleStorageManager` on `start()`.
   - `ui.on("ui:state-changed", merge + debounced persist)`.
   - In the existing `onOpen` handler, also `ui.send("ui:state", cachedUIState)`.
   - Add `getUIState`/`setUIState` to `SimpleStorageManager` (key `"uiState"`).

4. **Store** (`src/ui/store/navStore.ts`):
   - Add a `ui` slice with the persisted fields + `applyUIState(partial)` (used
     by rehydrate; does NOT trigger save) and `setUI(partial)` (used by pages;
     DOES schedule a save).
   - Subscribe `mentra.on("ui:state", ...)` → `applyUIState`.
   - A store subscriber serializes `ui` slice changes → `mentra.send("ui:state-
     changed", ...)` (debounced, skipped while restoring).
   - Add a `hydrated` flag, set when first `ui:state` lands.

5. **Migrate pages to the slice** — replace persist-worthy `useState` in
   `NavigationPage.tsx`, `AddPlacePage`, `LocationSearch` with store reads/writes.
   Leave derived/transient state (`previewRoute*`, `suggestions`, `loading`) as
   local — re-derived on restore.

6. **Router restore** (`src/ui/router.tsx`) — add a silent `restoreStack(route)`
   that rebuilds the stack + history depth without popstate; call it from
   rehydrate when the saved `route` is non-base.

7. **Gate first paint** on `hydrated` (App or NavigationPage root) to avoid the
   idle flash.

8. **Test matrix (on-device):**
   - Mid-trip: start → close app → reopen → running UI + correct map + maneuver,
     NOT idle. (Trip from snapshot, drawer from slice+snapshot.)
   - Preview-only: pick place, don't start → close → reopen → preview restored
     with the same destination; route re-derives.
   - On AddPlace page with typed query → close → reopen → back on AddPlace with
     the query/selection intact.
   - Search open with text → close → reopen → search reopens with text.
   - Dev toggles set → close → reopen → toggles restored.
   - Arrived while away: saved "previewing" but trip arrived → reopen shows
     arrival (live snapshot wins), not stale preview.
   - Schema bump: change `version` → old blob ignored, no garbage.

## Files

| File | Change |
|------|--------|
| `src/shared/types.ts` | `UIPersistedState` + versioned envelope |
| `src/shared/channels.ts` | `ui:state-changed` (UI→bg), `ui:state` (bg→UI) |
| `src/background/NavigationController.ts` | cache + load/merge/persist + send on `onOpen` |
| `src/background/managers/SimpleStorageManager.ts` | `getUIState`/`setUIState` (key `uiState`) |
| `src/ui/store/navStore.ts` | `ui` slice, `applyUIState`/`setUI`, save subscriber, `hydrated` flag |
| `src/ui/pages/NavigationPage/NavigationPage.tsx` | migrate persist-worthy `useState` → slice |
| `src/ui/pages/AddPlacePage/index.tsx` | migrate form state → slice (scoped to add-place route) |
| `src/ui/pages/NavigationPage/components/LocationSearch/LocationSearch.tsx` | migrate query/focus → slice |
| `src/ui/router.tsx` | silent `restoreStack(route)` for History-API-safe restore |

## Notes / decisions

- **Persist through the background, not the WebView** — mandatory: the WebView
  context is fully destroyed on close (shim confirmed). The background has both
  in-memory longevity and on-disk `SimpleStorageManager` (survives app kill).
- **Live trip always wins** over persisted UI state for trip fields — no
  staleness. Persisted state only fills pre-trip / pure-UI gaps.
- **Centralize in the store** so persistence is one serialize/rehydrate path, not
  per-field plumbing. This is the bigger refactor but the reason it scales to
  "everything."
- The original drawer-vanishing bug is a **subset** of this and gets fixed once
  the slice + snapshot apply order is in place.
- Scope creep guard: re-derive data (routes, suggestions) and reset transient
  flags (loading) rather than persisting them — keep the blob small and the
  restore robust.
