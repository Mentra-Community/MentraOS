# Miniapp SDK Improvements — Human TODO

Index of feedback items from the round of guinea-pig dev-ex feedback on PR #2512, the spec docs that cover them, and what still needs human input before any of them can be executed.

This doc is the entry point for the second round of work after the initial miniapp SDK landed. **None of the linked specs have been brainstormed end-to-end yet** — they capture the goal, the relevant code locations, and the open questions. Each one needs a real brainstorm pass before implementation.

---

## Specs in this round

| Spec | Scope | Status |
|---|---|---|
| [`miniapp-quick-fixes-spec.md`](./miniapp-quick-fixes-spec.md) | Tier 1 bundle: live reload, permissions CLI, phone-side missing-permission warning, manifest JSON Schema, MockTransport | **All decided.** Plans: [`#1+#5`](./miniapp-quick-fixes-1-5-plan.md), [`#2`](./miniapp-quick-fixes-2-plan.md) |
| [`miniapp-dev-applets-as-installed-apps-spec.md`](./miniapp-dev-applets-as-installed-apps-spec.md) | Persisted dev miniapps with retry-from-devUrl + bundle caching. Replaces ad-hoc QR-launch lifecycle. | **All decided** |
| [`miniapp-less-reacty-example-spec.md`](./miniapp-less-reacty-example-spec.md) | Restructure the example miniapp so glasses behavior isn't tied to React routes | **All decided** |
| [`miniapp-sdk-surface-alignment-spec.md`](./miniapp-sdk-surface-alignment-spec.md) | Move stream events off `session.events` onto their owning modules. | **Decided + shipped (0.2.0)** |
| [`miniapp-sdk-v3-alignment-spec.md`](./miniapp-sdk-v3-alignment-spec.md) | Round-2: rename to v3 names, hoist transcription/translation, sub-namespace phone, add `session.permissions`, hasPermission getters, stop() methods, touch gesture filter | **All decided — ready to implement** |
| [`miniapp-browser-testing-simulator-spec.md`](./miniapp-browser-testing-simulator-spec.md) | Stage 2 only (Stage 1 MockTransport moved to quick-fixes). Needs full design. | Stub — needs scoping |

---

## Decisions locked in

### `miniapp-less-reacty-example-spec.md`

- **Repo to mirror: Merge-style** (single `CaptionsController` class, inline handlers). Document Mentra-AI's manager-fleet pattern as the recommended path when an app has 5+ concerns.
- **Vanilla (non-React) template variant: deferred** to a follow-up. Get the React example right first.
- **Store: Zustand.** Parity with the broader `mobile/` codebase.
- **Soft-disconnect grace period: none in V1.** Local miniapps disconnect rarely.
- **Tester pages keep inline-subscribe.** Explicit rule in spec: user-facing glasses logic must use the controller; diagnostic/tester pages may inline-subscribe because they're ephemeral by design. Don't extend Zustand to tester pages — would bloat the controller with debug-only methods.

### `miniapp-dev-applets-as-installed-apps-spec.md`

- **Persistence:** existing `storage` MMKV/AsyncStorage helper, key `miniapp_dev_persisted`. Migrate the old `miniapp_dev_recent` data on first read.
- **Server-offline UX:** full-screen takeover at the route level — but only when no cache exists. Cached fallback runs silently with a toast.
- **Removal:** long-press tile → "Remove." No settings screen for V1.
- **Cross-machine packageName collision:** silently update. PackageName is identity.
- **DEV indicator:** orange dot in the top-right of the icon. Hook into the shared app-icon component.
- **Bundle caching ships in V1.** Reuse `Composer.getBundleDir` / `installMiniApp` install pipeline. Cache lives at `Paths.document/lmas/<packageName>/dev-<timestamp>/`. Live `devUrl` preferred when reachable; cached bundle is the silent fallback. Removal deletes all `dev-*` dirs for the package.
- **File list comes from a dev-server manifest endpoint** (`GET /__mentra_dev/files` returns `{files: [...]}`). The CLI generates it by walking the project tree, excluding `node_modules` / `dist` / `.git` / `.env*`. Robust to any framework (Vite, Next, code-split). For dev servers that can't enumerate (Vite on-demand mode), CLI walks the source tree directly.
- **Offline cache fallback is always silent.** Toast says "Dev server offline — running cached version (cached N days ago)." No threshold, no interrupt. Cache age is informational only.
- **Bug-report path:** skip `submitMiniappStartFailedBugReport` when `applet.isMiniappDev === true`. Console log only.

### `miniapp-quick-fixes-spec.md`

- **Live-reload client lives in the SDK.** `@mentra/miniapp` auto-injects when `miniappDeveloperMode === true`. Production miniapps don't ship the bytes.
- **Reload + log forwarding share one `__mentra_dev` WebSocket.** Multiplexed, no second connection.
- **Wire format: simple JSON-tagged messages.** `{type: "reload"}`, `{type: "log", level, args, packageName, timestamp}`. Extend with new `type` strings as needed.
- **Object serialization in the bridge:** `JSON.stringify` with circular-safe handling, `Error.stack` extraction. `console.trace/table/group` deferred.
- **Production gate is the single `miniappDeveloperMode` flag.** Sufficient because the shim is only injected via `mountDev`.
- **CLI surfaces: both object-verb subcommands AND interactive `mentra-miniapp manifest` wizard.** Different audiences, shared backend. Strict validation: unknown types and duplicates fail loudly with closest-match suggestion.
- **JSON Schema: local-resolved only for V1.** `$schema` points at `./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json`. No hosted URL infrastructure. Single schema file, no `schemaVersion` field yet.
- **MockTransport ships in this spec (#6).** Stage-1 stopgap moved out of simulator spec.

### `miniapp-sdk-v3-alignment-spec.md`

- Renames: `session.audio` → `speaker`, `microphone` → `mic`, `layouts` → `display`. Match v3 names exactly.
- Hoist `session.transcription` and `session.translation` to top-level. v3-style `on()` / `forLanguage(string | string[], handler)` / `configure({languageHints, vocabulary, diarization})` / `stop()`.
- Sub-namespace `session.phone.notifications.*` and `session.phone.calendar.*`. `phone.onBattery` stays flat.
- New `session.permissions` module: `has()`, `getAll()`, `onUpdate()`, `onPermissionError()`. Manifest-declaration tracking only — OS-grant state is out of scope. Adds one new wire-protocol push (`PERMISSIONS_UPDATE`).
- `hasPermission` getters on every module whose subs need a manifest permission.
- `stop()` convenience methods to tear down all subs in a module at once.
- `session.input.onTouch` gains gesture-filter overload (`onTouch("click", h)`, `onTouch(["a", "b"], h)`). Requires phone-runtime fan-out to per-gesture stream variants.
- Keep three modules (`input`/`imu`/`glasses`) — explicitly reject v3's collapsed `device` shape.
- Defer speaker stream-state observability (`onStateChange`).
- Clean break to `0.3.0`. Example migrates in same PR.

### `miniapp-sdk-surface-alignment-spec.md` (shipped at 0.2.0)

- **Audio split: `session.audio` (output) and `session.microphone` (input).** TTS/play/stop on `audio`; transcription/translation/VAD/audio-chunks on `microphone`.
- **Input combined: `session.input`.** Button + touch under one module. Future input modes (gesture, voice command, eye tracking) extend `input`.
- **Phone-surface grouping: Option C with battery split.** `session.system` for imperative phone-OS utilities; `session.phone` for phone-data events; `session.glasses.onBattery` and `session.phone.onBattery` separately.
- **`session.events` shrinks to escape hatch.** `subscribe(rawStreamType, handler)` only, undocumented, for forward-compat.
- **Module naming uses flatter form.** `session.glasses.onBattery`, not `session.glasses.battery.onChange`.
- **Stream subscriptions stay ref-counted via shared internal registry.** Today's behavior preserved across the new module split.
- **Backwards compatibility: clean break at `0.2.0`.** No deprecated aliases.
- **React hooks expansion deferred.** Land the core surface first; `useTranscription` etc. come in a follow-up.

Final surface: 14 modules — `layouts`, `audio`, `microphone`, `input`, `location`, `imu`, `glasses`, `phone`, `system`, `camera`, `led`, `dashboard`, `storage`, `stream`. Plus a tiny `events.subscribe()` escape hatch.

---

## Specs that need their own brainstorm later

### `miniapp-browser-testing-simulator-spec.md`

This spec is intentionally a stub. Stage-1 (MockTransport) shipped as part of quick-fixes. Stage-2 (full simulator) needs its own brainstorm — likely after the surface-alignment spec lands so the simulator's event-injection API targets the final module shape.

---

## Items deferred from this round

### npm publish (item #4 in the feedback round)

The original feedback was "SDK doesn't work outside the monorepo, had to bun-link everything." The actual fix is publishing `@mentra/miniapp`, `@mentra/miniapp-cli`, `create-mentra-miniapp` to npm.

Reasons to defer:

- The packages are at `0.1.0`. The SDK surface is going to change as part of `miniapp-sdk-surface-alignment-spec.md`. Publishing now means publishing a version we'll break in two weeks.
- Publishing to npm is a release-engineering project on its own (changesets, npm 2FA, ownership of `@mentra` org, automated publish from CI, version tagging, deprecation policy for older versions). Not in scope for the dev-ex improvement round.
- The "scaffolder rewrites `workspace:*`" hack I floated in the feedback discussion isn't worth the maintenance burden until we have a publish target. Drop it.

When we're ready: track as its own dedicated effort. The example template's `package.json` and the `create-mentra-miniapp` template both reference `"@mentra/miniapp": "workspace:*"` — those need to flip to a real semver range as part of the publish task.

### React hooks expansion

`useTranscription`, `useButtonPress`, `useLocation` etc. wrapping the new domain modules. Land the core surface alignment first; hooks come in a follow-up PR.

### Full simulator (Stage 2)

Multi-week project. Needs its own brainstorm + spec. Scheduled after surface-alignment spec lands.

---

## Implementation plans written

- [`miniapp-quick-fixes-1-5-plan.md`](./miniapp-quick-fixes-1-5-plan.md) — Live reload + WebView console bridge. Sidecar dev server (Bun.serve on `<userPort+1>`), DevServerBridge service on phone, console-tap injection in `miniappGlobals.ts`, SDK auto-injected reload listener. 11 files touched, 3 new. ~5-7 days. **Shipped.**
- [`miniapp-quick-fixes-2-plan.md`](./miniapp-quick-fixes-2-plan.md) — Permission/hardware CLI + manifest wizard. Shared backend (`manifest-mutate.ts`, `manifest-format.ts`); `permission.ts`, `hardware.ts`, `manifest-wizard.ts` for surfaces. ~2-3 days. **Shipped.**
- [`miniapp-sdk-surface-alignment-plan.md`](./miniapp-sdk-surface-alignment-plan.md) — Round-1 module split. **Shipped at 0.2.0.**
- [`miniapp-speaker-state-and-notif-dismissed-plan.md`](./miniapp-speaker-state-and-notif-dismissed-plan.md) — `session.speaker.onStateChange` + Android notifications.onDismissed. **Shipped.**
- [`miniapp-dev-applets-as-installed-apps-plan.md`](./miniapp-dev-applets-as-installed-apps-plan.md) — Persisted dev applets, bundle caching, orange-dot indicator, removal flow. 5 PRs, ~8-12 days. Ready to implement.
- [`miniapp-less-reacty-example-plan.md`](./miniapp-less-reacty-example-plan.md) — Restructure example with CaptionsController + Zustand store. 3 PRs, ~3-4 days. Ready to implement.

Sections **#3** (PERMISSION_NOT_DECLARED warning), **#4** (JSON Schema), **#6** (MockTransport) don't need plan docs — the spec sections are detailed enough to implement directly. **Shipped.**

`miniapp-sdk-v3-alignment-spec.md` was detailed enough to implement directly without a separate plan doc — **shipped at 0.3.0.**

## Process

1. Pick a spec, brainstorm with me (the user) interactively.
2. After brainstorm, write an implementation plan (separate doc, plain markdown in `agents/`).
3. Execute in tracked PRs.

Specs in this folder are the *what* and *why*; implementation plans are the *how*. Don't conflate them — keep specs stable as anchors, let plans churn during implementation.
