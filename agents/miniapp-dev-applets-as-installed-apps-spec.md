# Dev Applets as Installed Apps — Spec

## Why

When a developer scans a `mentra-miniapp://dev?...` QR code, the resulting app is treated as a temporary, single-session experiment. It vanishes from the home tray and switcher when "closed", lives only in transient store state, and does not survive an app restart. This shape mismatches the smart-glasses model — these apps are intended to *run continuously* on the glasses, not just while the user is staring at the phone.

This spec consolidates three pieces of feedback from PR #2512's dev-ex round:

- **(#2)** "What happens when I walk away from my computer? Does it keep running?"
- **(#3)** "Local miniapp scanned via QR should save to home screen, persist, retry from URL on its own — like Metro."
- **(#5)** "When I close the QR-scanned miniapp, it disappears from switcher and tray, but some code keeps running in the background."

All three are facets of the same problem: dev-loaded miniapps are second-class citizens in the applet system. Promote them to first-class citizens.

## What we're building

A QR-scanned miniapp behaves identically to an installed app:

- Appears on home screen and in the app switcher.
- Has a small orange-dot indicator so it's distinguishable from store-installed apps.
- Survives app restarts.
- Close (minus button) → backgrounded, JS keeps running. Same lifecycle as any other miniapp.
- **First successful load downloads and caches the bundle locally** (HTML/JS/CSS/assets) into the same on-disk layout `Composer` already uses for store-installed local miniapps. Reuses `Composer.installMiniApp` / `getBundleDir`.
- Re-launching from home screen tries the live `devUrl` first (so live reload still works when the laptop is reachable); falls back to the cached bundle when unreachable.
- If `devUrl` is unreachable AND no cache exists, surfaces a "server offline" state with the cached name/icon and a re-scan affordance.
- Re-scanning the same `packageName` updates the entry (same as today).
- Long-press a tile → "Remove" action; removal also drops the cached bundle.

This is mostly a behavior change, not a UI redesign. The applet renderers, switcher, and capsule menu only need the dev-dot indicator. The new code lives in the persistence layer and the bundle-cache integration with `Composer`.

## Affected code

The current dev-applet flow touches several files. Each changes:

| File | Today's role | Changes needed |
|---|---|---|
| `mobile/src/app/applet/local.tsx` | Mounts dev miniapp; `handleClose` calls `unregisterDevApplet` (line 30-37). | Drop the `unregisterDevApplet` call. Close → setBackground only. |
| `mobile/src/stores/applets.ts` | `registerDevApplet` writes to in-memory state only; `unregisterDevApplet` removes by packageName. `refreshApplets` preserves dev applets through merges. | `registerDevApplet` also persists to storage. New: `loadPersistedDevApplets()` called from `refreshApplets` (or app boot). New: per-applet "server reachable" status. |
| `mobile/src/app/miniapps/settings/miniapp-developer-scanner.tsx` | QR scan → `replace("/applet/local", ...)`. Already calls `registerDevApplet` indirectly via `local.tsx`. | No change to scan path. |
| `mobile/src/app/miniapps/settings/miniapp-developer-url.tsx` | URL-typed dev miniapp; uses local `RECENT_KEY` MMKV storage scoped to that screen. | Migrate to the unified persisted dev-applets store. |
| `mobile/src/components/home/AppSwitcher.tsx` & `mobile/src/components/home/AppSwitcherButtton.tsx` | Render apps from `useActiveApps`. Already filter by `running`. | Render DEV badge if `applet.isMiniappDev`. |
| Home tray (wherever applets are listed) | Renders apps from store. | Render DEV badge if `applet.isMiniappDev`. |
| `mobile/src/components/miniapp/MiniappHost.tsx` | Owns WebView lifecycle; `setBackground` puts WebView in 1×1 off-screen holder. | No change. Already works correctly for backgrounded apps. |

## Lifecycle model

```
QR scan / URL load
        ↓
registerDevApplet(packageName, name, devUrl, iconUrl, hardwareReqs)
        ↓
[persisted to storage with isMiniappDev: true, devUrl, lastReachableAt]
        ↓
[appears on home tray + switcher with DEV dot]
        ↓
[user taps tile]
        ↓
freshness check: HEAD or short GET on devUrl/miniapp.json (≤500ms timeout)
        ↓
  reachable AND newer/no-cache:
    → download bundle into Composer.getBundleDir(pkg, "dev-<timestamp>")
    → mountDev with devUrl as live source (live reload still works)
  reachable AND cache fresh:
    → mountDev with devUrl as live source
  unreachable, has cache:
    → mount with file:// to cached bundle
    → show toast: "Dev server offline — running cached version"
  unreachable, no cache:
    → show full-screen offline screen with "Re-scan QR" / "Try again"
        ↓
[user uses app]
        ↓
[user navigates away or hits minus]
        ↓
miniappHost.setBackground (NOT unmount)
        ↓
[applet stays in apps store with running:true]
[WebView lives in 1×1 off-screen holder, JS continues]
        ↓
[user re-launches from home tray]
        ↓
miniappHost.setForeground (no remount needed)

──── App restart path ────
App boots
        ↓
loadPersistedDevApplets() reads from storage
        ↓
For each persisted applet: re-register in memory (running: false initially)
        ↓
Tiles render on home + switcher (with DEV dot, not running yet)
        ↓
[user taps tile] → see freshness-check flow above

──── Long-press removal ────
Long-press tile → action sheet → "Remove"
        ↓
unregisterDevApplet(pkg) + remove storage entry + delete Composer bundle dir
```

## Persistence

Persist the minimum needed to re-launch later:

```ts
{
  packageName: string         // identity
  name: string                // display name (cached from manifest)
  devUrl: string              // current best-known URL
  iconUrl?: string            // cached from manifest
  hardwareRequirements: HardwareRequirement[]  // cached from manifest
  registeredAt: number        // when first scanned
  lastReachableAt?: number    // last successful manifest fetch
  cachedBundleVersion?: string  // marker into Composer.getBundleDir; absent if no cache yet
}
```

Storage key: `miniapp_dev_persisted` (single array). Use the existing `storage` MMKV / AsyncStorage abstraction (`mobile/src/utils/storage`) — no new helper.

Replaces the existing `miniapp_dev_recent` key in `miniapp-developer-url.tsx`. Migrate that on first read (read-old, write-new, delete-old) so existing recent entries become persisted dev applets.

## Bundle caching (live-or-cached fallback)

This is the "what happens when I walk away from my computer?" answer. Dev miniapps install just like store-installed local miniapps — `Composer` already has the install-and-serve pipeline (`mobile/src/services/Composer.ts:294` `getBundleDir`, plus `installMiniApp`). Reuse it.

### What gets cached

When a dev miniapp is mounted from a reachable `devUrl`, kick off a background download of the bundle into `Composer`'s on-disk layout: `Paths.document/lmas/<packageName>/dev-<timestamp>/`. The `dev-` version prefix marks these directories as dev caches so they're easy to garbage-collect and don't collide with real installed versions.

The dev server publishes a **file manifest** at `GET /__mentra_dev/files`:

```json
{
  "files": [
    "/index.html",
    "/main.js",
    "/chunk-abc.js",
    "/styles.css",
    "/miniapp.json",
    "/icon.png",
    "/fonts/inter.woff2"
  ]
}
```

The phone fetches this manifest, then fetches each file and writes it to disk preserving paths. This is robust to any framework — Vite, Next, code-split bundles, lazy-loaded chunks all work, because the dev server (which knows the full file tree) is the authority on what to cache, not a runtime HTML crawl.

The CLI generates the manifest by walking the project root excluding `node_modules`, `dist` (unless that's the served output), `.git`, `.env*`. Configurable via `mentra-miniapp.config.ts` later if needed.

For frameworks that don't expose static file lists (Vite/Next dev mode where everything is on-demand), the CLI falls back to walking the project source tree directly — accepting that some transformed files will be re-built at request time on the phone's first fetch but cached as-served thereafter. Acceptable trade-off because the cache is fallback-only, not the primary path.

After download, write the `cachedBundleVersion` into the persisted entry so the next launch knows a cache exists.

### Mount strategy on re-launch

Three cases, decided by an upfront freshness check (HEAD or short GET on `<devUrl>/miniapp.json` with a ~500ms timeout):

| Situation | Mount source | Behavior |
|---|---|---|
| `devUrl` reachable | `devUrl` (live) | Live reload still works. Background-refresh the cache after mount. |
| `devUrl` unreachable, cache exists | `file://<bundleDir>/index.html` | **Always** silently fall back. Show a small toast: "Dev server offline — running cached version (cached N days ago)." Cache age is informational, not a warning; no thresholds, no interrupts. |
| `devUrl` unreachable, no cache | n/a | Show full-screen offline screen (see below). |

This naturally falls out of the existing `MiniappHost` API: `mountDev(packageName, devUrl, ...)` for live, or `mount(packageName, bundleUri, ...)` for cached. Today's code already distinguishes the two paths — we just route to the right one based on the freshness check.

### Cache invalidation

Each dev mount writes to a fresh `dev-<timestamp>` directory and updates `cachedBundleVersion`. Garbage-collect older `dev-*` directories for the same packageName at mount time, keeping only the latest two (one current, one previous as a fallback in case the new cache is corrupt).

On long-press removal, also delete every `dev-*` directory for that package.

### Notable edge

Live reload is the *whole point* of `mentra-miniapp dev`. The cache is not the source of truth when the laptop is reachable — always prefer live. The cache is the "graceful fallback" answer for "I walked away from my computer."

## "Server offline" UX

Only triggers when `devUrl` is unreachable AND no cached bundle exists. Most users won't hit this — they'll have a cache from the first launch.

Full-screen takeover at the route level (mirrors `MiniappErrorScreen.tsx` for cloud apps):

- Cached app icon and name.
- "Server offline" headline.
- "Last reached: [relative time]"
- Two buttons: "Re-scan QR" (push to scanner) and "Try again" (re-attempt freshness check).

If a cache exists but is older than some threshold, do we silently fall back, or notify? Recommend: silent fall back to cache always (with the toast banner). The developer would rather see *something* working than a takeover screen.

## DEV indicator (orange dot)

Render an orange dot in the top-right corner of the app icon wherever the applet is rendered with `applet.isMiniappDev === true`:

- Home tile.
- Switcher card.
- Capsule menu more-actions sheet (smaller, in the icon thumbnail).

Implementation: hook into the existing app-icon component (likely a single shared component used in all three places). The dot is a small absolutely-positioned `View` with the project's accent orange and a thin matching-background border to separate it from icons that have orange in them. ~10 LOC at the icon-component level.

## Removal flow

Long-press the tile on the home screen → action sheet → "Remove" (matches the long-press flow store apps already have).

Removal does three things:

1. `unregisterDevApplet(packageName)` in the store.
2. Drop the entry from the persisted-applets storage.
3. Delete every `Paths.document/lmas/<packageName>/dev-*/` directory via `Composer`.

No standalone settings screen for now. If we need bulk management later, add it.

## Bug-report path

`submitMiniappStartFailedBugReport` (`stores/applets.ts`) currently fires for any failed-to-start applet. For dev applets it's the developer's own buggy code — not actionable for the Mentra incident pipeline, and noisy.

Skip the bug report when `applet.isMiniappDev === true`. Keep the client-side console log only. The error screen still surfaces the failure to the dev directly, which is what they want.

## Compatibility & migration

- `isMiniappDev` flag already exists on `ClientAppletInterface` (`stores/applets.ts:46`). No new field.
- `registerDevApplet` already replaces by packageName. No semantic change.
- `unregisterDevApplet` still exists, called only by the explicit long-press removal flow. Removed from `local.tsx` close handler.
- Existing `miniapp_dev_recent` MMKV key migrates on first read (see Persistence section).
- Composer's `getLocalApplets` already scans `Paths.document/lmas/`. Need a small filter so it skips `dev-*` directories — those are surfaced via the persisted-applets path, not as installed local applets, to avoid double-counting.

## Decisions

All locked in:

- **Persistence:** existing `storage` MMKV/AsyncStorage helper, key `miniapp_dev_persisted`. Migrate old `miniapp_dev_recent` entries on first read.
- **Server-offline UX:** full-screen takeover at the route level. Only triggers when no cache exists; cached fallback runs silently with a toast.
- **Removal:** long-press tile → "Remove." No settings management screen for V1.
- **Cross-machine packageName collision:** silently update. PackageName is identity.
- **DEV indicator:** small orange dot in the top-right of the icon, hooked into the shared app-icon component.
- **Bundle caching:** ship in V1. Reuse `Composer.getBundleDir` / `installMiniApp`. Live `devUrl` preferred when reachable; cached bundle is the fallback when offline.
- **Bug-report path:** skip `submitMiniappStartFailedBugReport` for `isMiniappDev === true`. Console log only.

All locked. No remaining unknowns at the spec level — implementation details (manifest endpoint format, exact file-walk exclusion list, etc.) settle during plan-writing.

## Acceptance criteria

- A QR-scanned miniapp appears on the home tray and in the switcher with the orange dot.
- First successful mount downloads and caches the bundle into `Paths.document/lmas/<packageName>/dev-<timestamp>/`.
- Closing it (minus button or back swipe) backgrounds it; JS keeps running.
- Re-tapping the home tile foregrounds the same WebView (no remount).
- Killing and relaunching the MentraOS app: the dev applet is still on the home tray.
- Tapping it after relaunch tries the live `devUrl` first; falls back to cache transparently when unreachable; shows offline screen only when neither is available.
- Live reload still works whenever `devUrl` is reachable (the cache is silent fallback, not the source of truth).
- Re-scanning the same `packageName` updates the existing entry (URL refresh, manifest refresh, fresh cache download).
- Re-scanning a *different* `packageName` adds a new tile.
- Long-press on an orange-dotted tile offers "Remove"; remove deletes the entry, the storage record, and every cached bundle directory for that package.
- Failed dev-applet starts log to console but do *not* fire `submitMiniappStartFailedBugReport`.

## Out of scope

- Store-installed local miniapps. They go through `Composer.installMiniApp` from the store API, separate code path, separate lifecycle.
- Cloud miniapps. Untouched.
- Any change to QR code format or `mentra-miniapp dev` CLI output.
- Sharing dev miniapps between users / devices. The `devUrl` is laptop-LAN-specific by design.
- Settings-screen management UI for dev applets. Long-press only for now.
- Multi-version cache history beyond keep-last-2.

## Sequencing

This is roughly a 2-3 week project on its own. Suggested decomposition:

1. **Persist + load** — extend `registerDevApplet` to write through; add `loadPersistedDevApplets()` called from app boot; migrate `miniapp_dev_recent` data.
2. **Lifecycle fix** — drop `unregisterDevApplet` from `local.tsx`; verify backgrounded dev applets behave correctly through the existing `MiniappHost` pipeline.
3. **Bundle caching** — Composer integration: download crawler, dev-prefix versioning, freshness check on launch, cache-fallback mount path. The biggest piece of new code.
4. **Server-offline screen** — only triggered when no cache exists. New route, "try again" + "re-scan" buttons.
5. **Orange dot indicator** — at the shared app-icon component.
6. **Removal UX** — long-press flow; cleanup deletes storage entry + cache directories.
7. **Bug-report skip** — guard in `applets.ts` `startApplet` failure path on `isMiniappDev`.

Steps 1-2 are prerequisites. Step 3 is the largest single piece. Steps 4-7 are independent and shippable in any order after.
