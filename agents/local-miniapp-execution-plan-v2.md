# Local MiniApp SDK — Execution Plan

## What this is

A new JavaScript SDK (`@mentra/miniapp`) that lets mini apps run locally on the phone in WebViews instead of on remote servers. The phone handles display, events, and hardware access directly — no cloud hop. The existing cloud SDK (`@mentra/sdk`) stays untouched and both coexist until deprecation.

**How it works:** A mini app has two layers, both shipped in one ZIP and installed on the phone.

- **Background layer** — small piece of JavaScript (no DOM) that runs in a per-mini-app JS context on the phone (JavaScriptCore on iOS, QuickJS via Zipline on Android). ~1–5 MB per context. Always running while the mini app is enabled. Owns all glasses logic — display, transcription handlers, button events, etc.
- **UI layer** — a normal static web app (React + Tailwind, whatever) that only spawns when the user opens the mini app's settings/UI tile, and is destroyed when they leave. No persistent WebView in the background, so we don't burn ~100 MB of RAM per backgrounded mini app.

UI and background talk to each other through a typed message bus — the UI is just a pretty face. All glasses and cloud access goes through the background, which calls into the phone host. The phone host drives the glasses directly over BLE; for features that require cloud — STT, translation — it proxies subscriptions over its existing cloud WebSocket.

**Why:** Eliminates latency from the cloud round-trip for most operations. Makes mini apps work offline for local-only features. Simplifies the developer experience (static web app vs. running a server). Prepares for Apple Guideline 4.7 compliance.

**Internal until V3.** Local JS SDK is internal-only through V1 and V2. Not publicly accessible until we have a proper mini app store + install flow shipped.

**Throughout:** ship to main behind feature flags. Don't freeze the release train.

---

## What's done so far

- `@mentra/miniapp` SDK package — all hardware modules implemented (display, camera, mic, speaker, storage, location, IMU, etc.) plus transcription / translation / TTS bridged through the cloud.
- `mentra-miniapp` CLI with `dev` / `release` / `pack` / manifest wizard. Hot-reload dev server, QR-code launch onto phone.
- `create-mentra-miniapp` scaffolder.
- On-phone runtime landed: bundle install, WebView host, request dispatch, mic coordination, online↔offline STT fallback, dev-server bridge, crash UX.
- Cloud-side phone session (`__phone__` subscriber) proxies transcription/translation streams to local mini apps.
- Photo capture wired end-to-end through cloud (REST upload-token → glasses upload → signed URL back).
- Live Captions reference mini app runs locally. Navigation port is in place and builds green.

---

## What we have to do

### V1 — Display glasses, internal

SDK runtime is feature-complete for display-only glasses (G1, G2). All Mentra display mini apps run locally. Internal installs via dev tooling only — no store yet.

- [Harden the example mini app](https://linear.app/mentralabs/issue/OS-1431) — every SDK call exercised from tester pages and confirmed working on real glasses
- [Port Navigation](https://linear.app/mentralabs/issue/OS-1432) to local js sdk
- [New Local JS SDK version of Live Captions](https://linear.app/mentralabs/issue/OS-1433) — unified online/offline auto-switch, (this will end up retiring the existing 2 online/offline live captions mini apps)
- [Port Live Translation](https://linear.app/mentralabs/issue/OS-1434) - only uses cloud for translation. no ooffline translation fallback.
- [Rewrite Teleprompter](https://linear.app/mentralabs/issue/OS-1435) for local JS SDK

### V2 — Camera glasses + install platform, internal

Mentra Live mini apps run locally, and we have a real install path. New developer console + new mini app store flow + new DB collection for local mini apps. Cloud 1 still serves the old cloud mini apps through the same store UI — both kinds coexist behind a unified store API, users don't see the difference. New developer console gated/invite-only.

- [Photo capture](https://linear.app/mentralabs/issue/OS-1436) — E2E test on Mentra Live, add tester page, error/timeout UX
- [Unmanaged and Managed streaming](https://linear.app/mentralabs/issue/OS-1437) move almost entirely to phone. Unmanaged = phone. Managed = some cloud involvement. We should make a new stream handler in the cloud for this. Leave the old one intact and untounched. Streaming moves to be almost entirely phone coordinated sans managed which needs cloud for cloudflare orchastration. Ignore the old __phone__ stuff for streaming which we did as a prototype.
- [Port Livestream](https://linear.app/mentralabs/issue/OS-1438)
- [Port Mentra AI](https://linear.app/mentralabs/issue/OS-1439)
- [Port Mentra Notes](https://linear.app/mentralabs/issue/OS-1440)
- [Port X](https://linear.app/mentralabs/issue/OS-1441)
- [Port Merge](https://linear.app/mentralabs/issue/OS-1442)
- [New developer console flow](https://linear.app/mentralabs/issue/OS-1443) (upload bundle, manifest, permissions, hardware), include in here "New DB collection + backend schema for local mini apps (separate from the cloud mini app collection — makes Cloud 2 a clean delete later)". We already have a markdown plan for this somewhere that should be linked in linear tix for this.
- [Upgrade the Mentra MiniApp Store](https://linear.app/mentralabs/issue/OS-1444) — for API, one endpoint fans out to both collections, returns an opaque `install` discriminator. Mobile install dispatcher — same UI, routes to REST register (cloud) or ZIP download (local) under the hood. 

### V3 — Public launch, Cloud 1 deprecation

Cloud 1 sunset, Cloud 2 ships without legacy mini app infra, old SDK deprecated.

- (optional / low priority) [Migration guide](https://linear.app/mentralabs/issue/OS-1445) (`@mentra/sdk` → `@mentra/miniapp`)
- [Deploy Cloud 2 to production](https://linear.app/mentralabs/issue/OS-1446) — drops the old cloud-mini-app collection, models, routes, and services
- [Deploy new developer console to production](https://linear.app/mentralabs/issue/OS-1447), which cuts off new cloud mini app creation in console
- [Publish](https://linear.app/mentralabs/issue/OS-1448) `@mentra/miniapp`, `@mentra/miniapp-cli`, `create-mentra-miniapp` to npm
- [Deprecate](https://linear.app/mentralabs/issue/OS-1449) `@mentra/sdk` on npm
- [Archive cloud SDK code](https://linear.app/mentralabs/issue/OS-1450)

### V4 — Port final extreme low-priority mini apps

- [Port LinkLingo](https://linear.app/mentralabs/issue/OS-1451) mini app
- [Port Mentra Call](https://linear.app/mentralabs/issue/OS-1452) mini app
- [Port Dash](https://linear.app/mentralabs/issue/OS-1453) mini app
- [Port MemCards](https://linear.app/mentralabs/issue/OS-1454) mini app