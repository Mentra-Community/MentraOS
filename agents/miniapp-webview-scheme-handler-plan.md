# MiniappWebView — custom URL scheme handler for installed miniapps

> **Status:** long-term plan. The short-term unblock is the `--format=iife`
> Bun build flag — it makes production builds load successfully from
> file:// today, with no native code changes. This document is what we
> ship later when we want the *real* fix.

## What this doc gets us vs the `--format=iife` band-aid

The IIFE flag tells the bundler to produce one classic `<script>` per
miniapp instead of modern `<script type="module">`. That's enough to
make file:// loading work — but only barely, with real costs.

| Capability | `--format=iife` (today) | This plan (later) |
|---|---|---|
| Production miniapp loads from disk | ✅ | ✅ |
| Dynamic imports (`import("./foo")`) | ❌ broken | ✅ |
| Code splitting / lazy routes | ❌ disabled | ✅ |
| WASM dynamic loading (Three.js, ML libs, etc.) | ❌ awkward / broken | ✅ |
| Top-level `await` in bundle entry | ❌ | ✅ |
| Per-miniapp origin (cookies, IndexedDB, localStorage isolated) | ❌ all share "null" file:// origin | ✅ each package its own origin |
| Storage actually works at all | ⚠ varies — file:// disables most storage APIs | ✅ stable |
| Service workers (offline patterns) | ❌ file:// can't register SW | ✅ |
| `fetch()` to relative paths inside the bundle | ⚠ flaky on file:// | ✅ |
| Strict CSP working as expected | ❌ file:// is too weird for many CSP rules | ✅ |
| `<video>` / `<audio>` streaming local assets via Range requests | ❌ | ✅ |

The IIFE band-aid lets miniapps render and run JS. It doesn't let them
*do anything stateful*. The first miniapp that wants to remember a
single user setting between launches hits the storage wall. The first
one that wants to lazy-load a route hits the dynamic-import wall. The
first navigation app that wants offline tile caching hits the SW wall.

That's why this plan exists. Not because the band-aid doesn't work —
it does, for the simplest case — but because the next two real
miniapps will need the things the band-aid blocks.

**Sequencing decision:** ship IIFE today to unblock the dev who's
sideloading right now. Ship this scheme-handler module before the
first real consumer needs persistent storage, lazy loading, or WASM.

---

## TL;DR

Installed local miniapps load from disk. Today they load via `file://`,
which has two unfixable problems:

1. **ES modules don't work.** `<script type="module">` over `file://` is
   blocked by the unique-origin rule. Modern bundlers (Bun, Vite) emit
   module scripts by default; production builds white-screen.
2. **No origin isolation.** All file:// pages share the "null" origin,
   so storage (cookies, IndexedDB, localStorage) is either disabled or
   shared across every miniapp. We can't safely let miniapps persist
   user data.

Fix: replace `react-native-webview` with a small Expo module that owns
the WebView and registers a custom URL scheme handler. Each miniapp
loads from `mentra-miniapp://<package>/<path>`. Native code resolves
the path to `lmas/<package>/<active-version>/<path>` and serves it
with proper headers.

This unblocks production builds, gives every miniapp its own origin,
and is the canonical pattern Capacitor / Tauri / WebView2 use.

## Why not the cheaper alternatives

### `--format=iife` build flag

Tell `bun build` to emit one IIFE-wrapped script instead of modules.
Works from `file://`. Loses dynamic imports, code splitting, top-level
await, WASM lazy loading. The original use case for sideloaded builds
(navigation app, possibly with WASM routing engine) is exactly the
class of app that needs these features. Band-aid.

### Localhost HTTP server

Native module spins up `127.0.0.1:<port>` and serves files. WebView
loads `http://127.0.0.1:port/`. Real HTTP origin → modules work.

Killer: lifecycle. iOS aggressively kills foregrounded servers on
backgrounding. WebView reloads on resume → 404. We'd need workarounds
(restart-on-foreground + reload, or background URLSession tricks).
Also: per-miniapp origin requires port-per-package, more lifecycle
state, port conflict surface area. The custom scheme handler is just
a method called on demand — no lifecycle. Strictly cleaner.

### Patch react-native-webview

Fork it / add a config plugin to expose `WKURLSchemeHandler` as a
prop. Drags us into maintaining a fork forever. RN-WebView upgrade
treadmill becomes our problem. The miniapp WebView surface is small
enough that owning it ourselves is less work over time.

## What gets built

### Native module: `MiniappWebView` in `mobile/modules/crust/`

A new Expo `View` module that wraps a `WKWebView` (iOS) / `WebView`
(Android), with custom-scheme handlers built in. Sits next to the
existing `CrustView` (which is a separate, generic WebView wrapper).
Replaces `react-native-webview` for miniapp use only — everything
else in the app continues using RN-WebView unchanged.

#### File layout

```
mobile/modules/crust/
├── ios/
│   ├── MiniappWebView.swift           NEW — ExpoView wrapping WKWebView
│   ├── MiniappSchemeHandler.swift     NEW — WKURLSchemeHandler impl
│   └── MiniappWebViewModule.swift     NEW — Expo module declaration
├── android/src/main/java/com/mentra/crust/miniapp/
│   ├── MiniappWebView.kt              NEW — ExpoView wrapping WebView
│   ├── MiniappSchemeInterceptor.kt    NEW — WebViewClient.shouldInterceptRequest
│   └── MiniappWebViewModule.kt        NEW — Expo module declaration
└── src/
    ├── MiniappWebView.tsx             NEW — typed JS wrapper
    └── index.ts                       UPDATED — re-export

mobile/src/components/miniapp/MiniappHost.tsx
                                       UPDATED — import MiniappWebView,
                                       drop react-native-webview for miniapps
```

#### Scheme: `mentra-miniapp://`

URL shape: `mentra-miniapp://<package>/<path>`

- `<package>` — `com.mentra.example` etc. Becomes the host. Origin
  isolation kicks in here: WebView treats `mentra-miniapp://com.a` and
  `mentra-miniapp://com.b` as different origins. Storage, cookies,
  service workers all scoped per-host automatically.
- `<path>` — `index.html`, `assets/main.js`, `fonts/inter.woff2`, etc.
  Resolved against `lmas/<package>/<active-version>/`.

A miniapp's index would load from
`mentra-miniapp://com.mentra.example/index.html`. Its bundled assets
are referenced as relative paths in the HTML (`./main.js`) and the
WebView resolves them against the same origin → all served from disk.

### iOS: `MiniappSchemeHandler.swift`

Implements `WKURLSchemeHandler`. Two methods:

```swift
func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
  // 1. Parse the URL: mentra-miniapp://<package>/<path>
  // 2. Look up active version for <package>
  //    (passed in via prop / set on the handler when MiniappWebView
  //    mounts, refreshed on prop change)
  // 3. Resolve <lmas>/<package>/<active>/<path>
  // 4. Read bytes; on miss → 404
  // 5. Build URLResponse with content-type guessed from extension
  // 6. didReceive(response), didReceive(data), didFinish()
}

func webView(_: WKWebView, stop: WKURLSchemeTask) {
  // Cancel any in-flight read.
}
```

Content types — minimal table:
- `.html` → `text/html`
- `.js`, `.mjs` → `text/javascript` (NOT `application/javascript`;
  module scripts require text/javascript or application/javascript
  per HTML spec, text/javascript is the canonical choice)
- `.css` → `text/css`
- `.json` → `application/json`
- `.svg` → `image/svg+xml`
- `.png`, `.jpg`, `.webp` → `image/<ext>`
- `.woff`, `.woff2`, `.ttf`, `.otf` → `font/<ext>`
- `.wasm` → `application/wasm`
- everything else → `application/octet-stream`

Headers to include:
- `Content-Type: <as above>`
- `Content-Length: <bytes.count>`
- `Access-Control-Allow-Origin: *` (so future fetch() calls within the
  miniapp don't get CORS-blocked even though they're same-origin)
- `Cache-Control: no-store` (let the WebView re-fetch on every load,
  so an install of a new version is reflected on the next reload
  without stale-cache surprises)

Range request support: defer. Important if a miniapp ever streams a
local video via `<video src>` or `audio`, but YAGNI for now. Note in
follow-up.

### Android: `MiniappSchemeInterceptor.kt`

Implements `WebViewClient.shouldInterceptRequest(WebView, WebResourceRequest): WebResourceResponse?`:

```kotlin
override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
  val url = req.url
  if (url.scheme != "mentra-miniapp") return null  // let WebView handle it

  // 1. host = package, path = file
  // 2. Resolve <lmas>/<package>/<active>/<path>
  // 3. Read bytes, build WebResourceResponse with proper MIME
  // 4. On miss, return 404 WebResourceResponse
}
```

Same content-type table. Same headers (set via the response's
`responseHeaders` map). Android's `WebResourceResponse` is plain enough.

`androidx.webkit.WebViewAssetLoader` is a higher-level convenience
that wraps this with a "PathHandler" abstraction. It's tempting but
forces an `https://<custom-host>` URL shape (because Chrome's loader
rejects custom schemes for module loading on certain Android
versions). Going low-level with `shouldInterceptRequest` keeps the
URL shape symmetric with iOS.

### JS-side wrapper: `MiniappWebView.tsx`

```tsx
type MiniappWebViewProps = {
  packageName: string
  /** Active on-disk version. Used to resolve scheme requests. Bump
   *  to force a remount + clean reload of new files. */
  version: string
  /** http(s) URL for dev mode, or null/undefined for scheme-handler
   *  mode (the default for installed miniapps). When set, the WebView
   *  loads this URL instead. Preserves the dev-server live-reload path. */
  liveUrl?: string
  injectedJavaScriptBeforeContentLoaded?: string
  onMessage?: (event: { nativeEvent: { data: string } }) => void
  onLoadEnd?: () => void
  onError?: () => void
  onContentProcessDidTerminate?: () => void
  onNavigationStateChange?: (state: { canGoBack: boolean }) => void
  style?: ViewStyle
  // Imperative methods exposed on a ref:
  // - reload(), goBack(), injectJavaScript(string), postMessage(string)
}
```

Mirrors RN-WebView's surface for the methods MiniappHost actually
uses. We do NOT expose:

- `originWhitelist`, `allowFileAccess*`, `mixedContentMode` — locked
  to safe miniapp defaults inside native.
- `setBuiltInZoomControls`, `setDisplayZoomControls`, `scalesPageToFit`,
  `bounces`, `overScrollMode`, `automaticallyAdjustContentInsets`,
  `contentInsetAdjustmentBehavior` — locked to "feels like a native
  app" defaults inside native (no zoom, no bounce, no inset wiggle).

That trims the prop surface from 16 → 7 in the JS layer.

`allowsBackForwardNavigationGestures` stays exposed because
MiniappHost dynamically toggles it based on WebView history.

### MiniappHost wiring changes

Two-line change to the `<WebView>` JSX:

```tsx
<MiniappWebView
  packageName={app.packageName}
  version={app.version}                        // NEW — required prop
  liveUrl={app.liveUrl}                        // dev mode only
  injectedJavaScriptBeforeContentLoaded={injectedJS}
  onMessage={...}
  onError={...}
  onContentProcessDidTerminate={...}
  onNavigationStateChange={...}
  onLoadEnd={...}
  allowsBackForwardNavigationGestures={canGoBackState.get(app.packageName) ?? false}
  style={styles.webview}
/>
```

`mount()` and `mountDev()` set the same fields on `MountedMiniapp`,
just with `liveUrl` set in the dev case and absent (or null) for
installed. The WebView's source is implicit:

- `liveUrl` set → load `liveUrl` directly (http/https)
- `liveUrl` absent → load `mentra-miniapp://<packageName>/index.html`

So `MountedMiniapp.source` collapses from `{uri: string}` to one of
two implicit cases derived from `liveUrl`. Cleaner.

## Active-version coupling

The scheme handler needs to know which on-disk directory to read for
each request. Options:

### Option 1: Prop on the view (chosen)

`<MiniappWebView packageName="x" version="1.0.0">`. Native view passes
the version into the scheme handler when set up. On version change
(reinstall), MiniappHost updates the prop → native bumps the handler's
internal pointer. WebView reload picks up the new version's files.

Simple, explicit, debugger-friendly.

### Option 2: Native MMKV lookup

Handler reads `<pkg>_active_version` directly from MMKV. Couples
native code to the JS-side storage convention, requires native MMKV
bindings (currently not exposed in the project's native modules).

Adds friction for no benefit. Skip.

### Option 3: JS callback on every request

Scheme handler dispatches to JS to ask "what's the active version of
X right now?". Round-trip per asset. Slow.

Skip.

**Going with Option 1.**

## URL-format unification (deferred)

After this work:

- Dev miniapps load from `http://laptop:3000` (real HTTP origin).
- Installed miniapps load from `mentra-miniapp://<pkg>` (real custom-
  scheme origin).

Two URL shapes, both "real" origins. Both let modules work. Both let
storage isolate per origin.

Could go further: route dev too through the scheme handler, with the
handler proxying requests to the live URL (and serving from disk on
unreachable). Overkill — just keeps the symmetry-for-symmetry's-sake.
Defer indefinitely.

## Migration plan

### PR 1 — Native module + installed-miniapp swap

**Goal:** unblock the white-screen bug. Installed miniapps load via
the scheme handler. Dev miniapps still go through react-native-webview
(unchanged), so live reload + console bridge keep working without
risk.

**Scope:**

1. **iOS (`mobile/modules/crust/ios/`):**
   - `MiniappWebView.swift` — `ExpoView` subclass, holds a `WKWebView`.
     Initializes with WKWebViewConfiguration that registers the
     scheme handler for `mentra-miniapp`.
   - `MiniappSchemeHandler.swift` — `WKURLSchemeHandler`. Reads files
     from `Documents/lmas/<pkg>/<version>/`. Active version comes from
     a prop set by the view.
   - `MiniappWebViewModule.swift` — Expo module declaration. Exposes
     `View(MiniappWebView.self)` with the prop set we settled on.
     Imperative methods (reload, goBack, etc.) implemented.

2. **Android (`mobile/modules/crust/android/src/main/java/com/mentra/crust/miniapp/`):**
   - Same shape. `MiniappWebView.kt`, `MiniappSchemeInterceptor.kt`,
     `MiniappWebViewModule.kt`.
   - `WebView.setWebContentsDebuggingEnabled(true)` in dev builds.

3. **JS (`mobile/modules/crust/src/MiniappWebView.tsx`):**
   - Typed wrapper. Re-export from `crust`'s index.

4. **MiniappHost:**
   - Import `MiniappWebView` from `@mentra/crust`.
   - Replace the `<WebView>` JSX. Drop `originWhitelist`,
     `allowFileAccess*`, etc. (now hardcoded in native).
   - Update `mount()` to set `liveUrl: undefined` and `version:
     <fromComposer>`. `mountDev()` sets `liveUrl: devUrl`.
   - WebView ref methods (`injectJavaScript`, `goBack`, etc.) need to
     route through the new wrapper's imperative API.

**Acceptance:**
- Production-built miniapp installed via `mentra-miniapp release`
  loads, runs, and renders content. No white screen.
- ES modules, dynamic imports, and WASM all work in the production
  build.
- Dev miniapp still works (mountDev path, unchanged behavior).
- WebView debugger attaches via Safari (iOS) and Chrome inspect
  (Android).
- Two miniapps installed simultaneously have isolated localStorage /
  IndexedDB (verified by writing different values from each, reading
  back).

### PR 2 — Migrate dev miniapps to MiniappWebView too

**Goal:** one WebView component for both paths. Drop
`react-native-webview` from miniapp code entirely.

**Scope:**
- Move the dev path (`mountDev` → http://laptop:port) onto
  `MiniappWebView`. The native side just loads the http URL when
  `liveUrl` is set; no scheme handler involvement needed.
- Verify live reload works (the WebView reloads when the dev server
  signals over WebSocket — that's a JS-side mechanism, unaffected).
- Verify console-bridge JS injection still fires (the
  `injectedJavaScriptBeforeContentLoaded` prop must work the same way
  on the new view).
- Drop `react-native-webview` import from `MiniappHost.tsx`.

**Acceptance:**
- Dev mode: live reload, console bridge, all unchanged.
- `react-native-webview` no longer imported by any miniapp code.
- Other app surfaces (auth WebView, store WebView, etc.) still use
  react-native-webview without disruption.

### PR 3 — Polish

**Goal:** quality-of-life and isolation hardening.

**Scope:**
- Per-miniapp `WKWebsiteDataStore` (iOS) so each package gets its own
  cookie/storage jar separate from the default. Belt-and-suspenders
  on top of origin-based isolation.
- Range request support in the scheme handler (for `<video>` /
  `<audio>` element streaming). 30 LOC, opens up media-rich miniapp
  use cases.
- `Cache-Control` tuning if reloads feel sluggish on big bundles.
- Devtools attach toggle exposed as an MMKV setting (production
  builds default off, dev builds default on).

## Risk register

### "It doesn't work on iOS X.Y"

`WKURLSchemeHandler` is iOS 11+ which we already require. No issue.

`WKWebView.isInspectable` (devtools attach) is iOS 16.4+. Older iOS
falls back to no debugger — fine, we just lose attach there.

### Lost react-native-webview features

We hardcode 9 props that RN-WebView exposes. If a future feature needs
one of them (e.g. `mediaPlaybackRequiresUserAction`), add a prop to
`MiniappWebView`. Slow growth of our own surface, but intentional.

### Breaking on a miniapp that uses absolute URLs

A miniapp that hardcoded `https://api.mycompany.com` for fetches still
works — that's a separate origin, normal HTTPS, scheme handler
ignores it. Only same-origin (relative) requests hit the handler.

### Server-relative URLs from the bundler

Bun/Vite/etc. emit absolute paths starting with `/` in some
configurations: `<script src="/main.js">`. Those resolve against the
origin's root: `mentra-miniapp://com.x/main.js`. Scheme handler
strips the leading `/` from path → reads `<lmas>/<pkg>/<v>/main.js`.
Works. Just need to be consistent: the path component IS the file
path within the bundle.

### WebView crashes / OOM

Same as today's `WKWebView` — `onContentProcessDidTerminate` fires,
host can re-mount. No new risk.

### Migration error cascade

PR 1 changes the WebView component. If something subtle breaks (a
prop wired wrong, a callback signature off), every miniapp launch
fails. Mitigation: keep RN-WebView import live behind a feature flag
during PR 1's rollout window. Drop in PR 2 once we're confident.

## Out of scope for this work

- Replacing react-native-webview anywhere outside miniapp code.
- Service worker registration / lifecycle handling beyond "the
  WebView allows it to register" (no SW management UI).
- Cross-origin resource sharing rules tighter than `*` — the miniapp
  is its own origin, only it can call its own assets, fine to be
  permissive.
- Any signed-bundle / integrity verification — install-time signature
  checking is a separate future round.
- A way for miniapps to request URLs *outside* their bundle from the
  scheme handler (e.g. fetch from another miniapp). Origin isolation
  is the answer; if cross-miniapp data sharing is ever needed, that
  goes through SDK message passing, not URL scheme tricks.

## Open questions

1. **Should `mentra-miniapp://` be the canonical URL also surfaced to
   the user (e.g. in deep links, the SDK's `window.location`)?** The
   miniapp's JS will see this URL. It's a stable identity for the
   package. SDK methods that emit links could use it. → Probably yes,
   defer the call until we have a concrete need.

2. **Same scheme on both platforms?** Yes — `mentra-miniapp://` works
   identically on iOS and Android. Keeps things mentally simple.

3. **What about the auth/store WebViews still using
   react-native-webview?** Untouched. They have a different feature
   profile (need cookies, file uploads, mixed content). Keep them as
   they are.

4. **Capacitor as a foundation instead of building this ourselves?**
   Worth investigating before committing to PR 1 — see separate
   research note.

## Estimated effort

- **PR 1:** 2-3 days of focused work. Most of that is iOS scheme
  handler + Android shouldInterceptRequest + content-type mapping +
  prop surface implementation + testing on both platforms with a
  module-using miniapp.
- **PR 2:** half a day. Migration is mostly mechanical.
- **PR 3:** half a day. Polish.

Total: ~3-4 focused days end-to-end.

---

# Appendix: Capacitor research

Investigated whether adopting Capacitor's runtime (or part of it) saves
us from building this ourselves. Verdict: **no, but use it as a
reference**.

## What Capacitor is

Capacitor is Ionic's "native runtime for web apps" — a way to ship a
web app as an iOS/Android app with native API access. It's MIT
licensed, open source, ~2.3M weekly downloads, mature, well-maintained.

The relevant part for us is its WebView subsystem, which solves the
exact problem we're solving:

- **iOS:** registers a `WKURLSchemeHandler` for `capacitor://`. File
  `ios/Capacitor/Capacitor/WebViewAssetHandler.swift`. ~250 lines,
  including a 500-entry MIME-type fallback dictionary. Handles range
  requests for media, CORS for live-reload mode, file-system reads.
  Three Capacitor-specific identifier constants (used for HTTP-
  interception routing we don't need) — easily replaced.
- **Android:** `WebViewLocalServer.java` at
  `android/capacitor/src/main/java/com/getcapacitor/`. ~550 lines.
  Uses a `UriMatcher` to register URL patterns. Uses `https://localhost/`
  by default to make modules work (Android prefers https-origin
  schemes for module loading on some versions). Pulls in Capacitor's
  `Bridge`, `JSInjector`, `AndroidProtocolHandler` — coupling is
  heavier than iOS, would need to extract more carefully.

Both files are MIT-licensed, so we can copy / vendor / adapt directly.

## Three integration paths considered

### (1) Adopt Capacitor wholesale

Use Capacitor as the runtime and run miniapps inside it. Capacitor
generates an Xcode + Android Studio project, expects to BE the app.

**Why it doesn't fit:** Capacitor assumes the *whole app* is a web
app. We have a React Native shell. There's no documented way to drop
Capacitor INTO an existing React Native app — it owns the project
structure. This was Ionic's gap they tried to solve with **Ionic
Portals** specifically.

### (2) Use Ionic Portals

Ionic Portals = "Capacitor's WebView, embeddable into an existing
native app." Has React Native bindings (`@ionic/portals-react-native`).
Solves exactly our problem on paper.

**Why it doesn't fit:**

- **Commercial.** Proprietary license, "contact sales for pricing."
  No free tier mentioned. We'd be locked into a vendor contract for a
  core platform primitive.
- **Heavy.** Brings the whole Capacitor runtime + plugin system + JS
  bridge as a dependency. We'd inherit Capacitor's mental model and
  abstractions, even though our miniapp SDK has its own.
- **Mismatch in semantics.** Portals expects each "Portal" to be a
  versioned web bundle deployed via their tooling. Our miniapps are
  installed via filesystem (`lmas/<pkg>/<v>/`) on the device. Forcing
  Portals' deployment model is friction for no benefit.

Skip.

### (3) Build our own using Capacitor's source as a reference

Take the architecturally-validated approach (custom URL scheme
handler), copy the patterns from Capacitor's MIT-licensed
implementation, but ship a much smaller, miniapp-shaped module.

We don't need:
- HTTP request interception (Capacitor's "live mode" proxy). We have
  separate dev-server URL loading.
- 500-entry MIME table. ~15 entries cover us.
- Plugin bridge integration. We have our own SDK message channel.
- HTML5 mode routing fallback. SPAs in miniapps can opt into hash
  routing or include a 404→index.html in their bundle.
- JS injection from the asset handler. We have RN-side JS injection.

What we DO use directly from their playbook:
- The `mentra-miniapp://` scheme name structure (analogous to
  Capacitor's `capacitor://`).
- The pattern of "host = identity, path = asset path" in URL parsing.
- Range-request support on iOS for media (their snippet is
  copy-pastable).
- CORS header injection.
- The general shape of the iOS handler (~80-100 LOC for our subset).
- The Android `shouldInterceptRequest` with `WebResourceResponse`
  pattern (their lighter-weight counterpart, ~80-100 LOC for our
  subset).

## Verdict

**Don't adopt Capacitor or Portals.** Build the miniapp WebView module
ourselves. Keep Capacitor's source open in a tab while we write
`MiniappSchemeHandler.swift` and `MiniappSchemeInterceptor.kt` so we
catch the edge cases they've already solved (specific MIME types
Bun/Vite emit; HEAD vs GET handling; 206 responses for video; UTF-8
declaration in text/html).

Net cost-benefit:

| Option           | Native LOC | Build time | Ongoing cost                          |
|------------------|------------|------------|---------------------------------------|
| Adopt Capacitor  | ~0         | days       | inherit a runtime we don't control    |
| Adopt Portals    | small      | days       | commercial license + vendor lock-in   |
| Build (with ref) | ~200-400   | 2-3 days   | small surface, ours, tunable          |

The 2-3 day investment to own this primitive is correct. We get a
~300 LOC module that does exactly what we need, no more.

Sources:
- [Capacitor on GitHub (MIT)](https://github.com/ionic-team/capacitor)
- [WebViewAssetHandler.swift (iOS)](https://github.com/ionic-team/capacitor/blob/main/ios/Capacitor/Capacitor/WebViewAssetHandler.swift)
- [WebViewLocalServer.java (Android)](https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java)
- [Ionic Portals (commercial)](https://ionic.io/portals)
- [@capacitor/core on npm](https://www.npmjs.com/package/@capacitor/core)

