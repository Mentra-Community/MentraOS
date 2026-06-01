# Local Miniapp Architecture — Discussion Doc

## Related docs

- Execution plan (phone-side, V1-V4 by Linear issue): `agents/local-miniapp-execution-plan.md`
- Technical implementation plan (phone-side, full spec): `agents/local-app-runtime-plan.md`
- Cloud shrinkage plan (what stays in cloud vs moves to phone, Redis retrofit): `agents/cloud-shrinkage-plan.md`
- Miniapp store backend plan (dev console upload, publish, sharing, signed-URL install): `agents/miniapp-store-backend-plan.md`
- Miniapp SDK photo cleanup plan (private bucket + signed URLs + rename for `takePhoto()` path): `agents/miniapp-sdk-photo-cleanup-plan.md`

## Post-feedback improvements roadmap

After the dev-ex feedback round on this PR, the following spec docs were added. Each is plain markdown; each needs a real brainstorm pass before implementation. Index in `agents/HUMAN-TODO-miniapp-improvements.md`.

- `agents/miniapp-quick-fixes-spec.md` — Tier 1 bundle: live reload, permissions CLI, missing-permission warnings, manifest JSON Schema.
- `agents/miniapp-dev-applets-as-installed-apps-spec.md` — Persisted dev miniapps with retry-from-devUrl + DEV badge.
- `agents/miniapp-less-reacty-example-spec.md` — Restructure example so glasses behavior is independent of React routes.
- `agents/miniapp-sdk-surface-alignment-spec.md` — Move stream events off `session.events` onto domain modules. **Shipped at 0.2.0.**
- `agents/miniapp-sdk-v3-alignment-spec.md` — Round-2 alignment with cloud SDK v3: renames (`audio`→`speaker`, `microphone`→`mic`, `layouts`→`display`), hoist `session.transcription`/`session.translation` to top-level, phone sub-namespacing, new `session.permissions` module, `hasPermission` getters, `stop()` methods, touch gesture-filter overload. Clean break at `0.3.0`.
- `agents/miniapp-browser-testing-simulator-spec.md` — Stub for the simulator; needs full design pass.

## What this is

We're designing how third-party (and first-party) miniapps run on MentraOS. A miniapp is a small program that drives smart glasses — displays text, subscribes to transcription, responds to button presses, takes photos, etc. Today miniapps run as cloud apps: each miniapp is a Node/Bun server somewhere on the internet, the cloud routes events to it over WebSockets, the cloud routes display commands back down to the phone, the phone routes them to the glasses over BLE.

This doc is about whether we keep that model, replace it, or pick something in between — and what architecture gives us the best outcome given our constraints.

## Scope clarification

This doc is about the **new local miniapp SDK only**. The existing `@mentra/sdk` (cloud SDK) is not in scope here — it continues to work, both SDKs coexist during development, and `@mentra/sdk` will eventually be deprecated. We're not trying to design "one SDK for everything." If the local SDK ends up sharing transport logic with the cloud SDK as a happy side effect, great. If not, that's fine too.

## Goals

**What we're optimizing for, in priority order:**

1. **Reliability.** Today's chain is `miniapp-server ⇄ cloud ⇄ phone ⇄ glasses`. Four hops, four failure points, four sources of latency. Every extra hop is another place things break and another 50-200ms of delay. We want glasses that respond to events instantly and work when internet is flaky.

2. **Developer velocity.** Hosting a server is friction — most developers don't want to provision and maintain one. Removing that friction helps adoption.

3. **Modern-device performance.** We don't need to run on 2014 devices. Target is iPhone 15 / Pixel 9 class. We do need to not overheat those phones with 3-5 miniapps running.

## Requirements

- **Must work on iPhone 15.** Android equivalent too.
- **Must survive Apple App Store review.** Cannot violate 4.7.2 (no native API exposure beyond what Apple approves), 4.7.4 (miniapp index), 4.7.5 (age gate).
- **Must support the features miniapps actually need:** display control, event subscriptions (transcription, translation, button, head-up, etc.), audio playback, TTS, camera, streaming, location, LED, storage.
- **Must not require every miniapp developer to host a server.**
- **Must have two separate layers:**
  - **Layer 1 — Headless logic layer.** This is where miniapp business logic runs. It interfaces with the glasses: receives events (transcripts, button presses, head position, etc.), sends display commands (text walls, cards, etc.), drives audio/LED/camera. It runs continuously in the background while the miniapp is "running" — surviving even when the user isn't actively looking at the phone UI. It must be lightweight: no DOM, no full WebView, minimal memory footprint. Pebble's headless JSC runtime is the model.
  - **Layer 2 — WebView UI layer.** This is where the developer's phone-side UI lives. Built as a normal web app (HTML/CSS/JS or React/Vue/whatever). Opened on demand when the user wants to interact with the miniapp's settings, dashboard, or rich UI. Does NOT need to stay alive in the background — when the user closes it, it dies, and Layer 1 keeps running. Communicates with Layer 1 via a message bridge.
  - This split is non-negotiable for efficiency. Keeping a full WebView alive in the background just to drive glasses is wasteful and forces complexity (offscreen parking, keepalive pings, `opacity: 0` tricks). Headless JS uses ~10-15MB; a backgrounded WebView uses ~25-30MB, drains battery if developers aren't disciplined about disabling animations, and has Apple-review baggage.
  - Unlike Pebble (where developers MUST manually call `openURL()` to launch a UI), we assume every miniapp has a UI.

## Apple 4.7

Apple Guideline 4.7 covers "HTML5 and JavaScript mini apps." Apple updated 4.7 in November 2025 and launched a formal Mini Apps Partner Program (15% commission instead of 30% for qualifying mini app hosts). The guideline explicitly permits embedded JS runtimes and JavaScript miniapps, but with conditions:

- 4.7.2: No extending native platform APIs to miniapps without Apple's prior permission
- 4.7.4: Must publish an index of all miniapps with universal links
- 4.7.5: Must have an age-restriction mechanism
- 4.7.1: Privacy rules apply; must have moderation/reporting/blocking

These are product/legal requirements we owe regardless of runtime architecture. Worth being aware of when designing what we expose to miniapps.

## Case study: Pebble (2012-2016)

Pebble solved essentially this problem 12 years ago. Third-party watch apps had two components: a C binary running on the watch, and a JavaScript "companion" running on the phone. The JS handled anything the watch couldn't — fetching weather, geolocation, WebSocket connections, settings storage. The C handled display and user input.

**How they ran the JS on the phone:**

- iOS: JavaScriptCore (Apple's built-in JS engine, available as a framework — `JSContext` + `JSVirtualMachine`), embedded headlessly in the Pebble mobile app. No WebView.
- Android: V8 embedded via JNI.
- One JS context per running app, created on launch, destroyed on exit. No DOM, no npm, no Node APIs. Just a curated set of globals: `XMLHttpRequest`, `localStorage`, `navigator.geolocation`, `setTimeout`, `WebSocket`, `console`, `Pebble.sendAppMessage()` for talking to the watch.
- All JS ran inside the Pebble app's process. No separate Node, no subprocess.
- Config pages (for settings) were a SEPARATE mechanism: `Pebble.openURL()` opened a WebView pointing at a developer-hosted URL, user filled in a form, URL-scheme callback passed settings back to the phone JS. The config UI died when closed — that was fine, it wasn't driving the watch.

**Why this is worth studying:**

- It shipped at scale — thousands of apps, millions of users
- It proved that JSC on iOS is a viable runtime for third-party code (Apple approved it)
- It identified the right split: headless JS for logic, WebView for UI (opened only when needed)
- Pebble eventually moved some UI logic onto the watch itself (Rocky.js via JerryScript) because BLE round-trips were too slow for animated UI — same lesson applies to us

**What didn't work for them:**

- iOS background kills. Required BLE background mode to stay alive. Cold-start latency after long idle.
- No process isolation — one bad miniapp could crash the Pebble app
- JSC↔V8 divergence (less relevant today since Hermes runs on both platforms)
- Small BLE message size + ACK semantics — UI-over-BLE was slow

Pebble's architecture is a direct precedent for what we're considering. The engineering approach transfers almost directly.

## Options

### Option 1 — Current plan: Everything in WebViews, run always

Miniapps are static web bundles (HTML/CSS/JS) that load into WebViews inside the MentraOS app. The WebView stays mounted always (offscreen when backgrounded, `opacity: 0`, not `display: none`). The WebView drives the glasses through a postMessage bridge to the native MentraOS code.

**Pros:**

- Simple mental model: "miniapp is a website, it runs continuously"
- Developers use any modern web stack (React, Vue, whatever, plus npm ecosystem via bundlers)
- Full DOM + browser APIs available — `fetch`, `WebSocket`, `IndexedDB`, animations, canvas
- Zero server to host — miniapps are static sites

**Cons:**

- **No clean cloud fallback.** If Apple bans this, we have no migration path — the miniapps are built as WebViews, not as servers. Every miniapp would have to be rewritten.
- Developers can be sloppy — a miniapp with a running `requestAnimationFrame` loop burns phone battery even when the glasses display is off
- WebView memory overhead: ~20-30MB per WebView on iOS
- WebView perf on iOS WKWebView is noticeably worse than Chrome for animation-heavy code
- We become a "mini app marketplace" by definition (4.7 applies fully)

**Cost to build:** mostly done (V1 in progress).

### Option 2 — nodejs-mobile: Same SDK on phone and cloud, phone runs embedded Node

Embed the full Node.js runtime on the phone via `nodejs-mobile` (community fork of the original Janea project). Each miniapp is still a `@mentra/sdk` Node app — same code that runs on a cloud server. The difference: instead of the developer hosting it, MentraOS embeds Node in the mobile app and runs the miniapp there.

**Pros:**

- **Literally the same SDK for everything.** Zero code changes between cloud and phone deployment.
- Developers get the full Node ecosystem — npm packages, `fs`, `crypto`, etc.
- Trivial cloud fallback — the miniapp already IS a Node app, just redeploy it to a server
- Easy to move first-party miniapps over

**Cons:**

- **Heavy.** Adds ~30MB to MentraOS binary (per platform). Android crosses Play Store "large app" warning threshold.
- **50-80MB RAM per Node instance.** 3-5 miniapps = 150-400MB just for runtimes, before user code. iOS jetsam starts killing us.
- iOS has no JIT for third-party apps — Node runs in interpreter mode, 3-5x slower on CPU-bound code. For IO-bound miniapps (which is most), it's fine.
- Separate process per miniapp means cross-process messaging overhead
- nodejs-mobile is community-maintained but low velocity. Not a Meta/Google-scale project.
- Cold start: 1-3 seconds to spawn Node + load miniapp on iOS interpreter mode
- Nobody has shipped this at scale for smart glasses — we'd be on the frontier
- Still need something for UI — developers building UI-heavy miniapps either open a WebView on demand (Pebble config pattern) or have no UI

**Fallback story:** trivial. Miniapps ARE cloud apps — move them to a server, done.

**Cost to build:** 4-8 weeks to integrate nodejs-mobile + build the lifecycle management + design the UI hand-off.

### Option 3 — Pebble-style: headless JSC/Hermes + WebView for UI on demand

Embed JavaScriptCore (on iOS, free — it's a system framework) and Hermes (on Android, already shipping in RN) as the miniapp runtime. Miniapps are pure JS — no DOM, no browser APIs, just a curated set of capabilities we explicitly expose: `fetch`, `WebSocket`, `setTimeout`, `localStorage`, `crypto.subtle`, `console`, plus our glasses-driving APIs.

UI, if the miniapp needs one, is a separate concern: launch a WebView on demand (settings, config, richer dashboards). The WebView doesn't need to stay alive in the background — it's only for when the user is actively looking at it.

**Pros:**

- **Very lightweight.** ~10-20MB per miniapp runtime (bundle + heap). Can run 10+ concurrently.
- Zero additional binary size on iOS (JSC ships with the OS). Hermes already in RN app on Android.
- Modern ES support, decent perf (Hermes is only ~15-30% slower than V8 in typical workloads)
- Best isolation story — spin up a fresh JSContext per miniapp, tear it down cleanly
- Proven architecture (Pebble, WeChat, Alipay all ship this pattern)
- Apple explicitly approves embedded JSC (Guideline 2.5.2 carve-out + 4.7 for mini programs)

**Cons:**

- **No npm packages that require Node APIs.** Developers get a curated subset. Same constraint as browser JS, minus DOM. If a miniapp author needs `express` or `node:fs`, they're out of luck.
- We have to implement the API surface ourselves — `fetch`, `WebSocket`, timers, crypto, storage all wired through native bridges. Not hard, but real work. (~2-3 weeks for a complete polyfill layer.)
- Fallback to cloud requires a code refactor — the miniapp JS uses our curated surface, which is a SUBSET of what `@mentra/sdk` offers. Not zero-change migration but close.

**Cost to build:** 6-10 weeks. Longer than Option 1 because we're building the runtime from scratch. Shorter than Option 2 because we're not dealing with nodejs-mobile complexity.

### Option 4 — Cloud-backed with WebView UI

Current architecture (status quo for cloud miniapps). Listed here for completeness. Miniapp runs as a Node server in the cloud. Phone shows a WebView UI when user opens it. WebView and cloud communicate over WebSocket. Cloud drives glasses via its existing cloud→phone→BLE path.

**Explicitly not considered** because this is what we're trying to get AWAY from. The miniapp-server ⇄ cloud ⇄ phone ⇄ glasses chain is exactly the reliability/latency problem we're solving.

## Cross-option comparison

| Factor                   | Option 1 (WebView) | Option 2 (nodejs-mobile) | Option 3 (Pebble-style)     | Option 5 (core + multi-runtime)         |
| ------------------------ | ------------------ | ------------------------ | --------------------------- | --------------------------------------- |
| Dev velocity (no server) | ✅ Excellent       | ✅ Excellent             | ✅ Excellent                | ✅ Excellent                            |
| Phone perf (iPhone 15)   | ⚠️ OK              | ⚠️ Heavy                 | ✅ Light                    | Depends on chosen runtime               |
| Apple review risk        | ⚠️ Moderate        | ⚠️ Moderate              | ✅ Low (explicit carve-out) | Depends on chosen runtime               |
| Engineering cost         | 💰 Mostly done     | 💰💰💰 4-8 weeks         | 💰💰 6-10 weeks             | 💰💰 2-3 weeks extraction + any runtime |
| Developer ecosystem      | ✅ Full web        | ✅ Full Node             | ⚠️ Curated subset           | Matches chosen runtime                  |
| Memory per miniapp       | ~25MB              | ~70MB                    | ~15MB                       | Matches chosen runtime                  |
| Developer familiarity    | ✅ It's a website  | ✅ It's a Node app       | ⚠️ Sandboxed JS             | Matches chosen runtime                  |

## Additional considerations we shouldn't skip

**Apple 4.7 risk exists in all options.** Any system that loads third-party code into our app is subject to 4.7. The specific requirements (miniapp index, age gate, moderation) are product work we owe regardless of runtime choice.

**First-party miniapps matter.** We're porting Captions, Translation, Livestreamer, Call, etc. The cost to port differs between options. Option 2 is zero-cost (same SDK). Option 1 requires a rewrite. Option 3 requires a rewrite.

**Memory pressure compounds.** A user with 5 miniapps open running Option 1 (WebView) burns 100-150MB just on WebView overhead. On Option 3 (JSC), it's 50-75MB. iOS jetsam is aggressive in the background — we should optimize for leanness.

## References

- Pebble JS runtime (open source reference implementation): [pebble/pypkjs](https://github.com/pebble/pypkjs)
- Apple Mini Apps Partner Program: https://developer.apple.com/programs/mini-apps-partner/
- App Store Review Guidelines 4.7: https://developer.apple.com/app-store/review/guidelines/
- Hermes engine docs: https://reactnative.dev/docs/hermes
- nodejs-mobile community fork: https://github.com/nodejs-mobile/nodejs-mobile
- Technical research report (deeper dive): see related research artifacts
- Current execution plan: `agents/local-miniapp-execution-plan.md`
- Current technical plan: `agents/local-app-runtime-plan.md`
