# Dev Miniapps as Installed Apps — Implementation Plan

Implementation plan for [`miniapp-dev-applets-as-installed-apps-spec.md`](./miniapp-dev-applets-as-installed-apps-spec.md). The spec is fully decided; this doc is the *how*.

The headline goal: a QR-scanned dev miniapp behaves exactly like an installed app. Persisted across app restarts, kept on the home screen and switcher, backgrounded JS keeps running on close. **Live reload + console bridge work whenever the dev server is reachable**; a cached bundle is served as a graceful fallback when it isn't.

> **Naming note:** the broader codebase uses `Applet` (legacy "applet" terminology). All NEW code in this work uses `Miniapp`. Existing types like `ClientAppletInterface` / `useAppletStatusStore` aren't renamed in this work — that's a separate sweep. New services/components/files use `Miniapp`.

---

## Key insight: reuse Composer instead of a parallel store

**Composer (`mobile/src/services/Composer.ts`) already implements a complete filesystem-backed install registry**: `Paths.document/lmas/<packageName>/<version>/`, on-boot scan, `getLocalApplets()` populates `useAppletStatusStore`, `installMiniApp(url)` for ZIP-based installs, `uninstallMiniApp(packageName)` for removal.

Dev miniapps plug into this directly. A dev miniapp is just an "installed" miniapp whose **version directory is named `dev-<timestamp>`** instead of a semver. Composer's filesystem scan picks it up automatically; no separate persisted-store needed.

What's NOT derivable from filesystem state and needs separate storage:

- `devUrl` — the dev server's URL (fresh from QR scan).
- `lastReachableAt` — last time the dev server responded.

That's two MMKV keys per dev package: `<packageName>_dev_url` and `<packageName>_dev_last_reachable`. No parallel "PersistedDevApplet" registry.

**Rule on packageName collision:** dev re-scan replaces the entire package directory. Dev and store-installed of the same packageName are mutually exclusive. If a developer needs both, they can use a different packageName (e.g. `com.mentra.example.dev`). Cleaner mental model than maintaining a "preferred version selector" between dev-* and semver versions.

---

## Architecture overview

```
┌─────────────────── DEVELOPER LAPTOP ───────────────────┐
│  mentra-miniapp dev (CLI)                              │
│   ├── user's server.ts          (port 3000, miniapp)   │
│   └── sidecar dev-server.ts     (port 3001)            │
│         ├── /__mentra_dev (WebSocket — live reload)    │
│         ├── /__mentra_dev/health                       │
│         └── /__mentra_dev/files  ← NEW: file manifest  │
└────────────────────────┬───────────────────────────────┘
                         │ HTTP/WS over LAN
┌────────────────────────┴───────────────────────────────┐
│                       PHONE                             │
│                                                         │
│  Scanner / URL-load                                    │
│   └─> snapshotDevBundle(pkg, devUrl)                   │
│       └─> writes to lmas/<pkg>/dev-<ts>/               │
│       └─> save <pkg>_dev_url to MMKV                   │
│       └─> push("/applet/local", ...)                   │
│                                                         │
│  App boot                                              │
│   └─> Composer.initialize() — scans lmas/, populates  │
│       store. Dev miniapps appear automatically as      │
│       ClientAppletInterface entries (with isMiniappDev:│
│       true derived from version starting with dev-).   │
│                                                         │
│  Home tray + AppSwitcher                               │
│   └─> render with orange-dot indicator                 │
│       └─> tap launches /applet/local                   │
│                                                         │
│  /applet/local route                                   │
│   ├─ if version starts with dev-:                      │
│   │   ├─ devUrl = MMKV[<pkg>_dev_url]                  │
│   │   ├─ freshness check (HEAD on devUrl/miniapp.json) │
│   │   ├─ reachable: mountDev(devUrl) — live reload    │
│   │   │             + bg cache refresh                 │
│   │   ├─ unreachable + cache exists: mount(file://)   │
│   │   └─ unreachable + no cache: full-screen offline  │
│   └─ else: existing installed-version path            │
│                                                         │
│  Long-press tile → Remove                              │
│   └─> Composer.uninstallMiniApp(pkg)                   │
│       + clear MMKV keys                                │
└────────────────────────────────────────────────────────┘
```

---

## File map

```
mobile/src/
├── services/
│   ├── Composer.ts                  EXISTING — small extensions (see PR 1)
│   ├── DevMiniappBundleCache.ts     NEW — download bundle from manifest endpoint
│   └── DevServerBridge.ts           (no changes)
├── stores/
│   └── applets.ts                   EXISTING — no parallel-store changes;
│                                    just respect the isMiniappDev flag set
│                                    by Composer
├── components/
│   ├── home/AppSwitcher.tsx         EXISTING — orange-dot rendering
│   └── miniapps/
│       ├── CapsuleMenu.tsx          EXISTING — pass-through dev flag
│       └── DevMiniappBadge.tsx      NEW — orange-dot indicator (shared)
├── app/
│   ├── miniapps/settings/
│   │   ├── miniapp-developer-scanner.tsx   EXISTING — call snapshotDevBundle
│   │   └── miniapp-developer-url.tsx       EXISTING — same; drop RECENT_KEY
│   └── applet/
│       ├── local.tsx                EXISTING — freshness check + dispatch
│       └── dev-offline.tsx          NEW — full-screen offline screen
└── i18n/en.ts                       EXISTING — new copy strings

sdk/miniapp-cli/src/
└── dev-server.ts                    EXISTING — add /__mentra_dev/files endpoint
```

10 files touched, 3 new. The new "DevMiniappBundleCache.ts" is a thin functional module — not a singleton service with state.

---

## Decomposition (5 PRs)

### PR 1 — Composer dev-* recognition + miniapp.json metadata (1 day)

**Goal:** Composer already scans the filesystem; teach it about `dev-*` versions and the miniapp.json metadata format.

**Composer changes** (`mobile/src/services/Composer.ts`):

1. **`getAppletMetadata`** today reads `app.json` only:
   ```ts
   const appJsonFile = new File(lmaDir, "app.json")
   const appJson = JSON.parse(appJsonFile.textSync())
   ```
   Switch to `miniapp.json` (greenfield — no installed `app.json` miniapps in the wild). Drop the app.json fallback.

2. **`getActiveAppletVersion`** sorts versions with `semver.rcompare(a, b)`. `dev-*` versions aren't valid semver; sort would break. Filter rule: if any version starts with `dev-`, use that as active (most recent by lexicographic timestamp). Otherwise existing semver logic.

   ```ts
   public async getActiveAppletVersion(packageName: string): Promise<string> {
     const stored = storage.load<string>(`${packageName}_active_version`)
     if (stored.is_ok()) return stored.value

     const versions = this.getAppletInstalledVersions(packageName)
     // Dev versions take precedence — re-scan replaces the whole package.
     const devVersions = versions.filter((v) => v.startsWith("dev-")).sort().reverse()
     if (devVersions.length > 0) {
       await this.setActiveAppletVersion(packageName, devVersions[0])
       return devVersions[0]
     }
     versions.sort((a, b) => semver.rcompare(a, b))
     await this.setActiveAppletVersion(packageName, versions[0])
     return versions[0]
   }
   ```

3. **`getLocalApplets`** populates `ClientAppletInterface` entries. Add `isMiniappDev: version.startsWith("dev-")` and `devUrl: storage.load(\`${packageName}_dev_url\`).valueOr(undefined)` so the existing applet-store consumers see dev miniapps with the right flags.

4. New helper: `getDevBundlePath(packageName: string): string | null` — returns the absolute path to the latest `dev-*` directory's content, or null if none. Used by `local.tsx` for the cached fallback.

**Acceptance:**
- Existing installed (semver) miniapps still work.
- A miniapp directory containing `dev-1234567/miniapp.json` shows up as `isMiniappDev: true` with the right name/icon/permissions.
- `getDevBundlePath` returns the right path.

---

### PR 2 — Lifecycle fix + scanner-to-Composer wiring (1 day)

**Goal:** dev applets stay backgrounded on close like normal apps. QR scanner writes the bundle into Composer's filesystem (snapshot path stub for PR 3).

#### Lifecycle fix in `mobile/src/app/applet/local.tsx`

Today's `handleClose`:
```ts
const handleClose = () => {
  miniappHost.unmount(packageName)
  if (devUrl) {
    useAppletStatusStore.getState().unregisterDevApplet(packageName)  // ← drop
  }
  goBackRef.current()
}
```

becomes:
```ts
const handleClose = () => {
  miniappHost.setBackground(packageName)  // not unmount
  goBackRef.current()
}
```

Closing now backgrounds the WebView (1×1 off-screen, JS continues), tile stays visible. Removal happens only via long-press (PR 5).

#### Scanner integration in `miniapp-developer-scanner.tsx` and `miniapp-developer-url.tsx`

Today: scanner writes nothing to disk, calls `replace("/applet/local", {packageName, devUrl, appName, iconUrl, devPort})`. The route then calls `mountDev(devUrl, ...)` directly.

After: scanner first ensures the bundle is snapshotted to disk, saves `<pkg>_dev_url` to MMKV, then routes. PR 3 implements the actual snapshot; PR 2 stubs the call as a `void devMiniappBundleCache.snapshot(...)` and lets `local.tsx` proceed even if the snapshot is still in-flight.

```ts
// In handleBarcodeScanned:
storage.save(`${packageName}_dev_url`, devUrl)

// Kick off snapshot in background — local.tsx will use live URL anyway,
// snapshot just populates the cache for next time.
void devMiniappBundleCache.snapshot(packageName, devUrl, devPort)

replace("/applet/local", {packageName, devUrl, appName: name, iconUrl, devPort})
```

Drop the `RECENT_KEY` MMKV usage in `miniapp-developer-url.tsx` — the "Recent" list now reads from Composer's `getLocalApplets().filter(a => a.isMiniappDev)`.

**Acceptance:**
- Tap minus on dev miniapp → backgrounded, tile still visible, JS still running.
- After QR scan, `<pkg>_dev_url` is in MMKV (verified via dev tools).
- Re-open from home tile foregrounds existing WebView (no remount).

---

### PR 3 — Bundle snapshot pipeline (5-7 days, the big one)

**Goal:** Live reload + console bridge work when reachable; cached bundle serves as graceful fallback when offline.

#### Sidecar endpoint — `sdk/miniapp-cli/src/dev-server.ts`

Add `GET /__mentra_dev/files` returning:
```json
{
  "files": [
    "/index.html",
    "/main.js",
    "/styles.css",
    "/miniapp.json",
    "/icon.png",
    "/fonts/inter.woff2"
  ]
}
```

Generate by walking the project root. Exclude:
- `node_modules/`, `dist/` (unless served), `.git/`, `.env*`
- `__mentra_dev` paths themselves.

Walk strategy: BFS from project root, breadth limit ~5 levels, file count limit ~500. Beyond that warn and truncate.

#### Phone-side bundle cache — `mobile/src/services/DevMiniappBundleCache.ts` (new)

Functional module, not a class:

```ts
import {Directory, File, Paths} from "expo-file-system"

const inFlight = new Map<string, Promise<string | null>>()

/**
 * Download the file manifest from the dev server and snapshot every file
 * into Paths.document/lmas/<packageName>/dev-<timestamp>/.
 *
 * Returns the version directory name on success, or null on failure.
 *
 * Idempotent per packageName: concurrent calls share the same Promise.
 */
export async function snapshotDevBundle(
  packageName: string,
  devUrl: string,
  devPort: number,
): Promise<string | null> {
  const existing = inFlight.get(packageName)
  if (existing) return existing

  const promise = doSnapshot(packageName, devUrl, devPort)
  inFlight.set(packageName, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(packageName)
  }
}

async function doSnapshot(packageName: string, devUrl: string, devPort: number): Promise<string | null> {
  const sidecarBase = buildSidecarUrl(devUrl, devPort)  // ws://host:port → http://host:port
  const manifestRes = await fetch(`${sidecarBase}/__mentra_dev/files`)
  if (!manifestRes.ok) return null
  const {files} = (await manifestRes.json()) as {files: string[]}

  const version = `dev-${Date.now()}`
  const versionDir = new Directory(Paths.document, "lmas", packageName, version)
  versionDir.create({intermediates: true})

  // Concurrency: 4 parallel fetches.
  await runWithConcurrency(4, files, async (relPath) => {
    const url = `${devUrl.replace(/\/$/, "")}${relPath}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
    const buf = await res.arrayBuffer()
    const target = new File(versionDir, relPath.replace(/^\//, ""))
    target.create({intermediates: true})
    await target.write(buf)
  })

  // GC older dev-* dirs, keep latest 2.
  gcDevVersions(packageName, 2)
  return version
}

/** Returns the absolute path to the latest dev-* bundle, or null. */
export function getLatestDevBundlePath(packageName: string): string | null {
  const pkgDir = new Directory(Paths.document, "lmas", packageName)
  if (!pkgDir.exists) return null
  const dirs = pkgDir.list()
    .filter((d): d is Directory => d instanceof Directory && d.name.startsWith("dev-"))
    .map((d) => d.name)
    .sort()
    .reverse()
  if (dirs.length === 0) return null
  return new Directory(pkgDir, dirs[0]).uri
}

/** Delete all dev-* dirs for this package. */
export function clearDevBundles(packageName: string): void {
  const pkgDir = new Directory(Paths.document, "lmas", packageName)
  if (!pkgDir.exists) return
  for (const item of pkgDir.list()) {
    if (item instanceof Directory && item.name.startsWith("dev-")) item.delete()
  }
}

function gcDevVersions(packageName: string, keep: number): void {
  const pkgDir = new Directory(Paths.document, "lmas", packageName)
  const dirs = pkgDir.list()
    .filter((d): d is Directory => d instanceof Directory && d.name.startsWith("dev-"))
    .sort((a, b) => a.name < b.name ? 1 : -1)
  for (let i = keep; i < dirs.length; i++) dirs[i].delete()
}
```

#### Mount strategy in `local.tsx`

```ts
// Read params + MMKV
const {packageName, devUrl: paramDevUrl, devPort, appName, iconUrl, version} = useLocalSearchParams<...>()
const storedDevUrl = storage.load<string>(`${packageName}_dev_url`).valueOr(null)
const devUrl = paramDevUrl ?? storedDevUrl
const isDev = !!devUrl

useEffect(() => {
  if (!packageName) return
  let cancelled = false

  ;(async () => {
    if (isDev) {
      const reachable = await checkDevServerReachable(devUrl, 500)
      if (cancelled) return

      if (reachable) {
        // Live mode: live URL, live reload, live console bridge.
        await miniappHost.mountDev(packageName, devUrl, {developerMode: true, appName, iconUrl})
        if (devPort) {
          devServerBridge.connect(packageName, devUrl, +devPort)
          // Background cache refresh — silent.
          void snapshotDevBundle(packageName, devUrl, +devPort)
        }
        storage.save(`${packageName}_dev_last_reachable`, Date.now())
        // Composer will reflect the new dev-<ts> dir on next refresh.
      } else {
        // Cached fallback if available.
        const cachedPath = getLatestDevBundlePath(packageName)
        if (cachedPath) {
          miniappHost.mount(packageName, `${cachedPath}/index.html`, {developerMode: true, appName, iconUrl})
          showToast(`Dev server offline — running cached version (${formatCacheAge(packageName)})`)
        } else {
          // No cache, no server. Push to offline screen.
          replace("/applet/dev-offline", {packageName, name: appName, iconUrl})
          return
        }
      }
    } else if (version) {
      // Existing installed-miniapp path.
      const bundleDir = composer.getBundleDir(packageName, version)
      miniappHost.mount(packageName, `file://${bundleDir}/index.html`, {developerMode: false, appName, iconUrl})
    }

    if (cancelled) return
    miniappHost.setForeground(packageName, {onClose: handleClose, onBack: handleBack})
  })()

  return () => {
    cancelled = true
    miniappHost.setBackground(packageName)
  }
}, [packageName, version, devUrl])
```

`checkDevServerReachable(url, timeoutMs)` does `HEAD <url>/miniapp.json` with `AbortController` for timeout; returns boolean.

`formatCacheAge(packageName)` reads `<pkg>_dev_last_reachable` and formats as "today" / "N days ago" / "just now."

`showToast` is whatever the codebase uses (find via search; if multiple, use what the offline-mode banner uses).

#### Offline screen — `mobile/src/app/applet/dev-offline.tsx` (new)

```
┌────────────────────────────────────┐
│        [icon]                      │
│        Live Captions               │
│                                    │
│        Dev server offline          │
│        Last reached: 2 days ago    │
│                                    │
│   [Try again]  [Re-scan QR]        │
└────────────────────────────────────┘
```

"Try again" re-runs freshness check; success → replaces with `/applet/local`. "Re-scan QR" pushes scanner.

#### Live-vs-cached behavior summary

| Server state at launch | What gets mounted | Live reload? | Console bridge? | Cache refresh? |
|---|---|---|---|---|
| Reachable | `mountDev(devUrl)` | ✅ | ✅ | ✅ background |
| Unreachable + cache exists | `mount(file://)` | ❌ | ❌ | ❌ |
| Unreachable + no cache | `/applet/dev-offline` | n/a | n/a | n/a |

Mid-session: if the dev server walks away, the WebView keeps running with already-loaded code (state preserved). Live reload signals stop arriving (bridge WS disconnects, reconnects in background per its existing logic). User-initiated WebView reload would fail — but the 99% case is launch-time, not mid-session. Document the limitation, defer.

#### Acceptance

- First load with reachable dev server: live mount, cache populates in background, `<pkg>_dev_last_reachable` updated.
- Live reload still works (file change → WebView reload).
- Kill dev server, kill phone app, restart phone app, tap tile: cached `file://` mount, toast appears, no live reload (correctly).
- Restart dev server, kill phone app, reopen: back to live mode with live reload working.
- Re-scan QR with same packageName: new `dev-<ts>` dir created, old GC'd.
- No-cache + offline: dev-offline screen.

---

### PR 4 — Orange-dot indicator (1 day)

**Goal:** distinguish dev miniapps visually from store-installed ones.

`components/miniapps/DevMiniappBadge.tsx` (new):

```tsx
export function DevMiniappBadge({size = 8}: {size?: number}) {
  return (
    <View style={{
      position: "absolute",
      top: -2,
      right: -2,
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: "#F97316",  // orange-500
      borderWidth: 1,
      borderColor: "#fff",
    }} />
  )
}
```

Render call sites (wrap each app-icon spot with `applet.isMiniappDev` check + badge):
- `components/home/AppSwitcher.tsx` — switcher cards.
- Home tray icon component (find via search).
- `components/miniapps/CapsuleMenu.tsx` — more-actions sheet thumbnail.

If there's a shared app-icon component, wrap that. If not, add the badge at each call site (cheaper than refactoring icon rendering).

**Acceptance:**
- Orange dot visible on home, switcher, capsule menu for dev miniapps.
- Store-installed apps unchanged.
- Visible on light + dark themes.

---

### PR 5 — Removal flow + bug-report skip (1-2 days)

**Goal:** developers can remove dev miniapps. Failed dev-miniapp starts don't pollute the incident pipeline.

#### Long-press action sheet

Find current long-press handler (likely in `components/home/HomeScreen` or `AppSwitcher`). For dev miniapps, expose "Remove":

```tsx
if (applet.isMiniappDev) {
  showActionSheet({
    options: ["Remove", "Cancel"],
    destructiveIndex: 0,
    onSelect: async (i) => {
      if (i === 0) {
        await composer.uninstallMiniApp(applet.packageName)  // drops the lmas/<pkg>/ tree
        clearDevBundles(applet.packageName)  // belt-and-suspenders for any partial dirs
        storage.delete(`${applet.packageName}_dev_url`)
        storage.delete(`${applet.packageName}_dev_last_reachable`)
        storage.delete(`${applet.packageName}_active_version`)
        await useAppletStatusStore.getState().refreshApplets()
      }
    },
  })
}
```

`composer.uninstallMiniApp` already deletes `Paths.document/lmas/<pkg>/` recursively. The MMKV cleanup is the only dev-miniapp-specific addition.

#### Bug-report path

In `stores/applets.ts` `startApplet` failure path:

```ts
if (result.is_error()) {
  console.error(`Failed to start applet ${applet.packageName}: ${result.error}`)
  // Skip bug-report for dev miniapps — it's the developer's own code,
  // not actionable in our incident pipeline.
  if (!applet.isMiniappDev) {
    void submitMiniappStartFailedBugReport(applet, result.error, "initial_start")
  }
  ...
}
```

Same guard in `retryStartApp`.

**Acceptance:**
- Long-press dev tile → sheet → "Remove" → tile gone, lmas dir deleted, MMKV keys cleared.
- Long-press non-dev tile shows whatever menu it had — no regression.
- Failed dev miniapp start doesn't appear in admin/incidents.

---

## Wire-protocol changes

**None.** All work is at the SDK + phone layer; the existing wire protocol is sufficient. The new `/__mentra_dev/files` endpoint is HTTP-on-the-laptop, not part of the phone-miniapp protocol.

## Test plan

### Unit
- `Composer.getActiveAppletVersion`: `dev-*` precedence over semver.
- `Composer.getLocalApplets`: `isMiniappDev` correctly set when version is `dev-*`.
- `snapshotDevBundle`: mocked fetch, writes correct files, GC keeps latest 2.
- `getLatestDevBundlePath`: returns newest `dev-*`, null if none.
- `freshness check`: aborts within 500ms when server unreachable.

### Integration (manual on phone)
- Persist + relaunch: scan, kill app, reopen → tile present (PR 1+2).
- Lifecycle: close → background → reopen → same WebView (PR 2).
- Live mode → kill server → restart phone → cached mount + toast (PR 3).
- Restart server → kill phone → reopen → back to live mode + live reload (PR 3).
- Re-scan with same packageName → new dev-<ts> created, old GC'd (PR 3).
- No-cache + offline → dev-offline screen (PR 3).
- Orange dot visible across all surfaces (PR 4).
- Long-press removal cleans everything (PR 5).
- Failed dev-miniapp start doesn't fire bug report (PR 5).

## Open items deferred to during-implementation

- **Bundle crawl strategy edge cases** for Vite/Next dev servers (lazy-loaded chunks). The manifest endpoint walks the source tree as a fallback. Resolve when a real Vite project hits the issue.
- **Mid-session dev-server disconnect:** WebView keeps running; manual reload would fail. Document; revisit if a real friction point.
- **Toast helper:** find via search; if multiple, use whatever the offline-mode banner uses.

## Sequencing recommendation

1. **PR 1** (Composer dev-* recognition) — unblocks all later PRs.
2. **PR 2** (lifecycle + scanner wiring) — small; lets tiles persist cleanly.
3. **PR 3** (bundle snapshot pipeline) — biggest piece; live-vs-cached routing.
4. **PR 4** (orange dot) — visual; independent.
5. **PR 5** (removal + bug-report skip) — depends on PR 1's `isMiniappDev` flag.

**Total: 4-6 days of focused work.** PR 3 dominates.

## Migration / breaking changes

- `miniapp_dev_recent` MMKV key (used by `miniapp-developer-url.tsx`'s "Recent" list): drop on first read, replaced by `Composer.getLocalApplets().filter(isMiniappDev)`. Existing entries that don't have a corresponding `lmas/` directory are simply lost — they were just URLs the developer typed once anyway.
- `unregisterDevApplet` semantics: was called from `local.tsx` close path, now called only from explicit removal (via long-press → `Composer.uninstallMiniApp`).
- `Composer.getAppletMetadata`: switches from `app.json` to `miniapp.json`. No breaking change in practice — greenfield, no `app.json`-format miniapps in the wild.

No SDK breaking changes. No version bump.
