# Miniapp SDK — Quick-Fix Improvements Spec

This spec bundles four small, mostly-independent dev-ex improvements identified in the post-PR-#2512 feedback round. They're grouped because each one is small enough not to need its own spec, and they share the same target audience (miniapp authors using `mentra-miniapp dev`).

Each section is self-contained — they can land as separate PRs and be brainstormed independently. Cross-section dependencies are noted explicitly.

**Status:** Spec, not a plan. Each subsection lists open questions that need user input before implementation.

---

## 1. Live reload for `mentra-miniapp dev`

### Problem

Today, `mentra-miniapp dev` (`sdk/miniapp-cli/src/dev.ts`) runs `bun run --hot server.ts`. Bun's `--hot` reloads server modules in the user's Bun process, but the WebView running on the phone has no reload trigger when the developer changes a source file. The author has to:

1. Make a change.
2. Manually pull-to-refresh the WebView, OR
3. Walk back to the phone, exit and re-enter the miniapp, OR
4. Re-scan the QR code.

This is the single biggest reported friction point in the feedback round.

The example template's `Bun.serve` does enable `development.hmr` (`sdk/example-miniapp/server.ts:25-28`), but in practice this hasn't worked through the React Native WebView — the user has confirmed hot reload doesn't currently work end to end.

### Goal

Editing a source file in the miniapp project causes the running WebView on the phone to reload (or HMR-patch) within ~1 second. No phone-side action required.

### Approach

Inject a tiny **livereload client** into the served HTML. The dev server runs an SSE endpoint. On filesystem change, the SSE endpoint pushes a `reload` event. The injected client calls `location.reload()`.

Why SSE over WS:

- Already a one-way channel from server to browser; matches the use case.
- Trivial to implement on top of `Bun.serve`'s `routes` API — no extra dependency.
- Survives RN WebView quirks more cleanly than WS in our experience.

Why not Bun's built-in HMR:

- Bun's `Bun.serve` HMR depends on Bun's own client runtime being injected at known paths. The RN WebView setup with `injectedJavaScriptBeforeContentLoaded` injects window.MentraOS *before* Bun's HMR client loads, but Bun's HMR also relies on bundling assumptions that don't hold for arbitrary template setups.
- Confirming Bun HMR works in the RN WebView is its own debugging project. A 30-line custom livereload client is faster to ship and own.

### Implementation surface

1. **`@mentra/miniapp-cli` (`dev.ts`)**: when starting the dev server, also start a small SSE server (or wire one into the user's `server.ts`). Reuses the existing port detection / LAN IP logic.
2. **Filesystem watcher**: chokidar or Bun's native `Bun.watch` (if mature enough) on the project's source directory. Debounce ~100ms.
3. **Injection mechanism**: two options —
   - **A. SDK auto-injects.** `@mentra/miniapp` auto-attaches a tiny client when `window.MentraOS.miniappDeveloperMode === true`. Works for any template, zero config.
   - **B. Template owns it.** The `create-mentra-miniapp` template ships with the client snippet pre-installed. Only authors using the official template benefit.
4. **Client snippet**: ~15 lines of vanilla JS that opens an EventSource to `/__mentra_dev/reload` and calls `location.reload()` on receiving a `reload` event.

### Decisions

- **Live-reload client lives in the SDK.** `@mentra/miniapp` auto-injects the reload listener when `window.MentraOS.miniappDeveloperMode === true`. Production miniapps don't ship the bytes (gate is the same dev-mode flag covered in section #5). Authors get live reload transparently — no template-level opt-in.
- **Reload signal flows over the shared `__mentra_dev` WebSocket** established in section #5. The dev-server side ships `{type: "reload"}`; the SDK's auto-injected client calls `location.reload()`. One channel for reload + log forwarding (multiplexed, no second WebSocket).

### Still open

- **How does the watcher know what to watch?** Default to the project root excluding `node_modules` and `dist`. Configurable via `mentra-miniapp.config.ts` later. Recommend: ship the default; defer config until someone asks.
- **HMR vs full reload?** Full reload is V1. HMR (preserving React state, etc.) is a future enhancement. The "Metro-quality" comparison would imply HMR eventually — flag for a later spec round.

### Acceptance criteria

- Editing any file under the project root triggers a WebView reload within 1s.
- Works for the official template out of the box.
- Disabled in non-developer-mode contexts (production miniapps).
- Doesn't cause reload loops (the dev server reloading itself shouldn't trigger a phone reload).
- Survives the WebView going to background and back.

### Out of scope

- HMR / state preservation. Future enhancement.
- Live reload over the LocalSocketTransport browser path. That's coupled to the simulator work in `miniapp-browser-testing-simulator-spec.md`.

---

## 2. Permission and hardware CLI subcommands

### Problem

Adding a permission or hardware requirement to a miniapp today means hand-editing `miniapp.json`. The CLI validates on `dev` and `pack` (`miniapp-cli/src/manifest.ts:68-160`) and prints a list of allowed values when validation fails, but there's no add/remove/list workflow. New authors don't know the permission strings without reading the source.

### Goal

A guided workflow that:

- Lists currently declared permissions and hardware requirements.
- Adds a new entry with prompts for type, optional description, and (for hardware) level.
- Removes an entry by type.
- Updates `miniapp.json` in-place, preserving formatting and comments.

### Approach

Two surfaces — both ship together. Both use `@clack/prompts` for any interactive flows (already in `create-mentra-miniapp` deps; consistent with house style — see user memory `feedback_cli_prompt_library.md`).

**Surface A: object-verb subcommands.** Scriptable, discoverable via `--help`, matches `git remote add` / `npm config set`. Used when the developer knows exactly what they want.

```bash
mentra-miniapp permission list
mentra-miniapp permission add               # interactive: pick type, optional description
mentra-miniapp permission add MICROPHONE    # non-interactive shorthand
mentra-miniapp permission remove MICROPHONE
mentra-miniapp hardware list
mentra-miniapp hardware add                 # interactive: pick type + level
mentra-miniapp hardware add CAMERA REQUIRED
mentra-miniapp hardware remove CAMERA
```

**Surface C: top-level interactive wizard.** Single entry point that walks the developer through the whole manifest. Used when the developer doesn't know what they want yet — they want the CLI to ask.

```bash
mentra-miniapp manifest
# → "Edit manifest? [permissions / hardware / package metadata / done]"
# → on permissions: "Add / remove / done"
# → on add: clack multiselect of ALLOWED_PERMISSIONS, optional description prompt
# → ditto for hardware (with level selector after type)
# → re-validates and prints the resulting manifest before writing
```

The wizard is the easiest path for someone who's never seen the manifest schema before; subcommands are the right path for everyone else. Both share the same underlying mutation + validation helpers, so behavior is identical.

### Validation rules (both surfaces)

Aggressive type checking before any write — vague error messages are worse than no errors. Specifically:

- **Unknown permission/hardware type**: error names the offending value, lists allowed values from `manifest.ts` constants, and suggests the closest match by Levenshtein distance ("`MICRPHONE` — did you mean `MICROPHONE`?"). No silent acceptance.
- **Duplicate type**: refuse to add a type that already exists in the array. Error says "permission `MICROPHONE` is already declared. Use `permission remove MICROPHONE` first if you want to update its description / required flag."
- **Invalid level for hardware**: `level` must be `REQUIRED` or `OPTIONAL`. Same fuzzy-match suggestion.
- **Removing a type that's not in the manifest**: error says so explicitly, lists current declared types, exits non-zero. Don't silently no-op.
- **Manifest not present**: error says "no `miniapp.json` found in current directory" with the absolute path that was checked. No auto-create.
- **Manifest is malformed JSON**: error says which line/column failed, refuses to mutate. Never overwrite a broken file.

After every successful mutation, run the existing `validateManifest` and print the resulting permission/hardware lists so the developer sees the new state.

### Implementation surface

1. New files `sdk/miniapp-cli/src/permission.ts`, `sdk/miniapp-cli/src/hardware.ts`, `sdk/miniapp-cli/src/manifest-wizard.ts` (Surface C). Shared helpers in `sdk/miniapp-cli/src/manifest-mutate.ts`: `addPermission(manifest, type, opts)`, `removePermission(manifest, type)`, `addHardware`, `removeHardware`, `closestAllowedValue(input, allowedList)` (Levenshtein).
2. JSON write helper that preserves indentation. Use `JSON.parse` + `JSON.stringify(_, null, 2)` and accept that comments aren't preserved (miniapp.json is pure JSON, no JSONC).
3. Reuse `validateManifest` from `manifest.ts` after every mutation; print the manifest validation result so the user sees the after-state.
4. Wire into `sdk/miniapp-cli/src/index.ts` switch statement: dispatch on `permission`, `hardware`, `manifest`.

### Decisions

- **Both surfaces ship together (Surface A object-verb + Surface C interactive wizard).** Different audiences, shared backend. No either/or.
- **Strict validation:** unknown types and duplicates fail loudly with closest-match suggestion. See the validation rules section above.
- **`required` flag prompting:** the wizard prompts (default: yes-required) for permissions; the non-interactive `permission add` form omits the field unless explicitly passed (keeps the manifest minimal). Default-omit means runtime treats it as required, matching today's CLI behavior.
- **Missing/malformed manifest handling:** errors out with file path / parse-error location, never auto-creates, never overwrites a broken file.

### Acceptance criteria

- All three forms (interactive, non-interactive, list/remove) work.
- Mutations preserve 2-space indentation (matches the rest of the codebase).
- Invalid additions (unknown permission type) error out before writing the file.
- Output after every mutation: print the new permission/hardware list and any validation warnings.

### Out of scope

- Migration of existing miniapps to a new manifest schema. The shape is stable.
- A web UI for editing permissions. CLI only.

---

## 3. Phone-side `PERMISSION_NOT_DECLARED` warning

### Problem

When a miniapp calls `session.events.subscribe(...)` or any action requiring an undeclared permission, `LocalMiniappRuntime` rejects it with a `PERMISSION_NOT_DECLARED` error. Today this surfaces only as a `session` `error` event in the SDK, which most authors ignore.

The author then sees: nothing happens. They have no idea why. The only way to debug is to read the source of `LocalMiniappRuntime` and notice the rejection path.

### Goal

When a permission rejection happens, the developer sees a clear message **in the place they're already watching for output**, with enough context to fix it.

### What "the place they're already watching" means

There are three log surfaces, in decreasing likelihood the developer is watching them:

1. **The `bun run dev` terminal** — where the miniapp's own server logs appear. **The dev is definitely watching this.** But it only shows logs from the user's `server.ts`, not from the phone-side runtime. Bridging is hard (see open questions).
2. **Safari Web Inspector / Chrome DevTools attached to the WebView** — where `console.warn` from miniapp JS appears. The dev *can* attach to this, and most who hit this issue will. Reachable via SDK `session.on("error")` → `console.warn` in the miniapp's own code.
3. **Metro / `adb logcat` / Xcode console** — where the phone-side React Native logs appear. Only visible to engineers who have the MentraOS app source and are running it from a debug build.

### Approach

Hit two surfaces on every rejection:

**A. Phone-side `console.warn`** in `LocalMiniappRuntime.ts` — visible in Metro / native console for MentraOS app developers running from source. One-line, actionable:

```
[LocalMiniappRuntime] com.example.app tried to subscribe to "transcription:auto" but permission MICROPHONE is not declared in miniapp.json. Add: {"type": "MICROPHONE"} to the permissions array.
```

**B. SDK delivers a structured error to the miniapp** — the miniapp can opt in to logging by adding `session.on("error", e => console.warn(e))` (which the example template should already do). The error payload includes `{code: "PERMISSION_NOT_DECLARED", permission: "MICROPHONE", subscription: "transcription:auto"}` so the miniapp can format its own message.

This is a `console.warn` from inside the miniapp's WebView JS — visible in DevTools when the dev attaches. Not visible in `bun run dev` terminal (different process), but the SDK can include the package name and a hint to attach DevTools when this happens.

### Implementation surface

1. **`mobile/src/services/LocalMiniappRuntime.ts`**: at the existing rejection sites, add `console.warn` with the structured message.
2. **SDK protocol**: ensure the error envelope sent from the runtime includes `permission` and `subscription` fields. Already partially supported via `MiniappRequestError` (`sdk/miniapp/src/session.ts:72-75`), but message formatting needs to be standardized.
3. **`@mentra/miniapp` session error handler**: include a default `console.warn` for `PERMISSION_NOT_DECLARED` and `HARDWARE_NOT_DECLARED` errors. Authors who don't subscribe to `error` still get the message in DevTools.
4. **Example template**: `MentraProvider` (`sdk/miniapp/src/react/MentraProvider.tsx`) can `useEffect(() => session.on("error", console.warn), [session])` so React-template authors get it for free.

### Open questions

- **Default-warn vs opt-in?** I recommend default-warn-in-developerMode, silent in production. The mode is already known via `window.MentraOS.miniappDeveloperMode`. Confirm.
- **Should we *also* try to bridge phone logs back to `bun run dev` terminal?** Possible via the WebSocket session — phone-side `console.warn` could be wrapped to also send a `dev_log` envelope upstream, which the dev server prints. This is more plumbing than it sounds (need to log-route per miniapp, handle multiple connections, deal with verbosity), and arguably belongs in the simulator work. Recommend **no** for this round.
- **Same treatment for `HARDWARE_NOT_DECLARED`?** Yes, same code path. Cite which hardware type and where to add it in `miniapp.json`.

### Acceptance criteria

- Calling a method requiring an undeclared permission produces:
  - A `console.warn` in Metro / native console for MentraOS engineers.
  - A structured `error` event on the session that includes `code`, `permission`/`hardware`, and the offending subscription / call.
  - Default-suppressed in production.
- Message includes the exact JSON snippet to add to `miniapp.json`.
- Doesn't spam — multiple identical rejections in quick succession should warn once per `(packageName, permission)` pair until the next session.

### Out of scope

- Bridging phone logs to the dev terminal. Future, simulator-adjacent.
- UI toast on the phone. Not a UX surface for developers; rejected explicitly in the feedback round.

---

## 4. Manifest JSON Schema

### Problem

`miniapp.json` is hand-edited. There's no IDE autocomplete, no inline validation in VSCode, no "did you mean MICROPHONE?" feedback at edit time. The CLI catches errors at run-time, but the feedback loop is "save → run dev → read error → fix → repeat" instead of "type → see red squiggle".

### Goal

VSCode / Cursor / Zed autocompletes permission types, hardware types, and field names in `miniapp.json`. Invalid values get inline red squiggles before the file is ever saved.

### Approach

Generate a JSON Schema from the same allowed-values lists in `sdk/miniapp-cli/src/manifest.ts`. Ship it via the local CLI install (no hosted URL infrastructure for V1):

1. **Inside `@mentra/miniapp-cli`** at a stable path: `sdk/miniapp-cli/schema/miniapp.schema.json`. Editors resolve via `$schema: "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json"`.
2. **Auto-injected `$schema`** by `create-mentra-miniapp` and by `mentra-miniapp permission/hardware` commands when they touch `miniapp.json` — so authors get autocomplete without having to know it exists.

### Implementation surface

1. **Schema generator**: a small script in `sdk/miniapp-cli/src/schema.ts` that builds the JSON Schema from the `ALLOWED_PERMISSIONS`, `ALLOWED_HARDWARE_TYPES`, `ALLOWED_HARDWARE_LEVELS` constants. Run as part of the build to produce `schema/miniapp.schema.json`.
2. **CLI subcommand**: `mentra-miniapp schema print` (writes to stdout) and `mentra-miniapp schema install` (adds `$schema` to the user's `miniapp.json`). Optional, low priority.
3. **Update the template's `miniapp.json`** to include `$schema` pointing at the local installed path so scaffolded projects have autocomplete on day one.

### Decisions

- **Local-resolved schema only for V1.** `$schema` points at `./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json`. Works on day one with zero infrastructure. Hosting infrastructure (`schemas.mentra.glass`) is a follow-up if a real "I want autocomplete in `miniapp.json` without a workspace" use case emerges — for now it doesn't exist.
- **Single schema file, no `schemaVersion` field yet.** When we eventually need versioned schemas, introduce `schemaVersion` as part of the next minor SDK bump. Don't pre-bake it.
- **JSON Schema, not JSON Type Definition.** Universal editor support outweighs JTD's tooling advantages.

### Acceptance criteria

- Authors typing permissions/hardware in `miniapp.json` get autocomplete in VSCode.
- Invalid types produce inline diagnostics.
- New projects scaffolded by `create-mentra-miniapp` have `$schema` set.
- Schema is generated from the same constants the CLI validator uses (no drift).

### Out of scope

- Hosted schema URL infrastructure. Follow-up.
- Schema versioning (introducing `schemaVersion`). Decide as part of the next minor SDK bump.

---

## 5. WebView console bridge to `mentra-miniapp dev` terminal

### Problem

Average miniapp developers install the MentraOS app from the App Store / Play Store. They don't have:

- Metro / `react-native-logs` (requires running the app from source).
- `adb logcat` setup (requires Android dev tools + the app signed in dev mode).
- Xcode console attached (requires the iOS app source + Xcode).

So when a third-party developer's miniapp throws an error in the WebView, or when the SDK emits a `console.warn` (e.g. the `PERMISSION_NOT_DECLARED` from #3), the developer has no way to see it. The MentraOS app silently swallows it.

The only realistic surface a third-party developer is watching is the terminal where they're running `mentra-miniapp dev`. The webview's console messages should appear there.

This bridge also makes #3 (the missing-permission warning) significantly more useful. Today that warning lives in Metra logs only. With this bridge, the developer sees it in their dev terminal where they're actually looking.

### Goal

`console.log`, `console.warn`, `console.error` calls inside the dev miniapp's WebView appear in the `mentra-miniapp dev` terminal output, prefixed with the package name, alongside the dev server's own logs.

Limited to **dev miniapps only** (`window.MentraOS.miniappDeveloperMode === true`). Production miniapps must not stream console messages anywhere.

### Approach

Three pieces:

**A. Inject a console-tap into the WebView when in dev mode.**

When `MiniappHost` mounts a dev miniapp (`mountDev` in `mobile/src/components/miniapp/MiniappHost.tsx`), inject a small JS shim before content load that wraps `console.log/warn/error/info/debug` to also forward each call up the existing message bridge as a `dev_log` envelope.

**B. Receive the `dev_log` envelopes on the phone side.**

`LocalMiniappRuntime` (`mobile/src/services/LocalMiniappRuntime.ts`) recognizes a new `dev_log` envelope type. Forward the payload back up the dev miniapp's network connection.

**C. Forward to the dev server.**

The dev miniapp is connected to the developer's laptop via the WebView load URL (`http://192.168.1.50:3000`). The phone needs a way to send messages *back* to the dev server. Two implementation paths:

- **C1. Open a WebSocket from the phone to the dev server.** When the WebView loads a dev URL, the phone also connects to `ws://<dev-host>:<port>/__mentra_dev/log`. The dev server's `Bun.serve` exposes that endpoint. Phone forwards each `dev_log` over the WS. Server prints them to its stdout.
- **C2. Phone POSTs each log line to `http://<dev-host>:<port>/__mentra_dev/log`.** Stateless, no persistent connection. Higher latency per log line (HTTP overhead per message), simpler to implement.

**Recommendation: C1.** Logs are bursty; HTTP overhead per message would be brutal during a noisy session (think a tight loop logging at 60Hz). WebSocket fits the pattern. Same shape we'd use for live reload (#1) — could share the same connection.

**Naturally pairs with #1 (live reload).** Both #1 and this section need a phone→laptop channel. Implementation should establish *one* WebSocket connection from the phone to the dev server and multiplex log forwarding + reload notifications + future dev-only signals over it. Re-architect both into a single `__mentra_dev` channel from the start.

### Implementation surface

1. **`mobile/src/components/miniapp/MiniappHost.tsx`** (or `mobile/src/utils/miniappGlobals.ts` since the inject already lives there): when `miniappDeveloperMode === true`, append a console-tap shim to the injected JS. The shim wraps the four log methods, calls the original, and additionally posts a `dev_log` envelope.
2. **`mobile/src/services/LocalMiniappRuntime.ts`**: handle `dev_log` envelopes — extract `{level, args}`, route to the dev-server bridge.
3. **`mobile/src/services/MiniSockets.ts` (or a new `DevServerBridge.ts`)**: maintain one outgoing WebSocket per dev miniapp to its `devUrl`'s host. Send forwarded logs.
4. **`sdk/miniapp-cli/src/dev.ts`**: add the `__mentra_dev/log` WebSocket endpoint to the dev server. Print incoming logs prefixed with the package name + level. Color-code (warn = yellow, error = red).
5. **Connection lifecycle**: open WS when mounting a dev miniapp; close on unmount or `unregisterDevApplet`. Reconnect if the dev server bounces (developer hits Ctrl-C and restarts).

### Log formatting

```
[14:32:01] [com.mentra.example] log: Subscribed to transcription
[14:32:03] [com.mentra.example] warn: Translation handler not registered yet
[14:32:05] [com.mentra.example] error: Failed to fetch /api/foo: 404
```

Open: include source line number / stack trace? Most tappable consoles strip those. For a first version, plain message is fine; offer a verbose flag later.

### Security / safety

- Only active in dev mode (`miniappDeveloperMode === true`). Production WebViews don't get the shim.
- Log payload size cap (~4KB per line) so a runaway `console.log(hugeObject)` doesn't melt the WS.
- Rate limit (~100 lines/sec) so a tight log loop can't DOS the dev server.
- The dev server bridge is bound to LAN-reachable ports, same as `dev` itself. No additional network exposure.
- Don't forward logs that contain auth tokens. Probably impossible to filter perfectly — accept that dev logs may leak whatever the developer logs, document it.

### Decisions

- **Transport: WebSocket, multiplexed with live reload (#1).** One `__mentra_dev` WebSocket connection from the phone to the dev server, carrying both #1's reload signals and #5's log forwarding. Two reasons: (a) bursty log forwarding would suffer real latency under HTTP-POST-per-line; (b) two parallel implementations of the same phone↔laptop dev channel is wasted code.
- **Wire format: simple JSON-tagged messages.** `{type: "reload"}` (laptop → phone), `{type: "log", level, args, packageName, timestamp}` (phone → laptop). Extend with new `type` strings if/when more commands are needed. No premature protocol design.
- **Object serialization:** `JSON.stringify` with circular-safe handling. Errors get `stack` field included. `console.trace` / `console.table` / `console.group` are deferred — not implemented in V1.
- **Production gate: single `miniappDeveloperMode` flag.** The shim is only injected when the phone mounts via `mountDev` (the QR-scan / URL-load dev path). Store-installed miniapps never get the shim because `mount` (not `mountDev`) is used and `miniappDeveloperMode === false`. A production miniapp wouldn't have a dev-server URL to forward to anyway, so even a worst-case override of the flag from miniapp JS doesn't gain anything.

### Acceptance criteria

- Dev miniapp `console.log`/`warn`/`error` appears in the developer's `mentra-miniapp dev` terminal, prefixed with package name and timestamp.
- Production miniapps never forward logs (no shim injected when not in dev mode).
- The `PERMISSION_NOT_DECLARED` warning from #3 also appears in the dev terminal (because its phone-side warn is now visible — separately, the SDK side `console.warn` already runs in the WebView and gets bridged).
- Dev server restart re-attaches automatically (the phone reconnects).
- Killing `mentra-miniapp dev` doesn't crash the miniapp on the phone.
- Bursty logging doesn't degrade miniapp performance.

### Out of scope

- Forwarding logs from production miniapps to a hosted log service. That's a Sentry-adjacent feature, separate work.
- Bidirectional command channel (reload, devtools-attach, etc.). Designed-for but not implemented in V1.
- Source-mapped stack traces for errors. Future.

---

## 6. MockTransport — browser fallback so the SDK doesn't hang

### Problem

When a developer opens their miniapp in a regular laptop browser (Chrome, Safari) outside the MentraOS WebView, `@mentra/miniapp`'s transport auto-detection (`sdk/miniapp/src/transport/auto.ts`) falls back to `LocalSocketTransport`, which tries to connect to `ws://127.0.0.1:8765`. That endpoint only exists on the *phone* (the `MiniSockets` server in `mobile/src/services/MiniSockets.ts`), so on the laptop it never opens.

`MiniappSession.connect()` waits up to 10 seconds for `CONNECT_ACK`, then rejects. From the developer's perspective, the page loads, hangs, then "crashes" (the user-reported "5-second crash" — closer to 10s by the timeout, but the visible symptom is the same).

This blocks the simplest possible browser workflow: "I just want to see my UI render."

### Goal

Stage-1 stopgap. Loading the miniapp in a regular laptop browser produces a visible UI immediately. No crashes, no hangs, no `if (browser) {...}` branches in app code.

The full simulator (Stage 2 — events, glasses-display preview, webcam/mic bridge) lives in [`miniapp-browser-testing-simulator-spec.md`](./miniapp-browser-testing-simulator-spec.md) and is deferred to its own brainstorm.

### Approach

Add a third transport, `MockTransport`, to `@mentra/miniapp`. Activates when:

- `window.ReactNativeWebView` is undefined (not in the MentraOS WebView), AND
- The first `LocalSocketTransport` connection attempt fails within ~500ms, OR
- The author opts in explicitly via `?mentra=mock` query param / `localStorage.MENTRA_MOCK = "1"`.

Behavior:

- On `open()`: synthesize a `CONNECT_ACK` envelope with a fake `userId` (`"mock-user"`), the package name from `window.MentraOS` (or `"com.mock.app"` if absent), `capabilities: null`, `visibility: "foreground"`, `colorScheme: "light"`. Deliver immediately so `session.connect()` resolves.
- On `send(envelope)`: parse the envelope, log to `console.log` with a `[mock-transport]` prefix, return synthetic results for any request that needs one:
  - `takePhoto` → `{photoUrl: "data:image/png;base64,iVBORw0K..."}` (1×1 placeholder)
  - `location` → `{lat: 0, lng: 0, accuracy: 0}`
  - everything else → `{ok: true, data: null}`
- Does **not** emit any glasses events. Subscribing to `transcription` etc. registers the handler but no events fire. That's V1's accepted limitation — events come in Stage 2.
- Auto-replies `PONG` to PINGs so keepalive doesn't trip.

### Implementation surface

1. New file `sdk/miniapp/src/transport/mock.ts` implementing the `Transport` interface.
2. Update `sdk/miniapp/src/transport/auto.ts` to try `LocalSocketTransport` first with a short timeout; on failure (or explicit opt-in), construct `MockTransport`.
3. Export from `sdk/miniapp/src/index.ts` so authors can construct it explicitly via `new MiniappSession({transport: new MockTransport()})`.
4. Document the `?mentra=mock` opt-in in the overview doc.

### Decisions

- **Auto-fallback on LocalSocketTransport failure** — ~500ms timeout, then quietly switch to mock. Authors who *do* want to talk to a real local socket can pass `transport: new LocalSocketTransport({url: ...})` explicitly.
- **Synthetic CONNECT_ACK with deterministic dummy values.** Mock userId = `"mock-user"` so authors can render UIs that depend on userId without conditional branches.
- **No event simulation in V1.** Subscribing succeeds but no events fire. Stage 2 (full simulator) handles synthetic events from a control panel.
- **Logged to `console.log` with `[mock-transport]` prefix** so the developer can see in DevTools what their miniapp is calling. Useful even without real responses.

### Acceptance criteria

- Opening the example miniapp in Chrome / Safari renders the UI immediately.
- `session.connect()` resolves with synthetic data; no 10-second hang.
- All non-event SDK calls return successfully (with placeholder data) so app code that depends on them doesn't crash.
- Subscribe calls succeed silently (no events fire, but no error either).
- `console.log` shows every envelope sent for debugging.
- Doesn't trigger when running inside the real MentraOS WebView (the `ReactNativeWebView` check still routes to `PostMessageTransport` first).

### Out of scope

- Synthetic event injection. Stage 2.
- Glasses-display preview. Stage 2.
- Real microphone / camera bridge. Stage 2.
- Auth flows. Stage 2 if needed.

---

## Sequencing

Suggested order, smallest-to-largest:

1. **MockTransport** (#6) — ~50 lines of new code, zero external deps. Unblocks browser workflow. Lowest risk.
2. **JSON Schema** (#4) — a few hours of work; benefits everyone immediately.
3. **Permission CLI subcommands** (#2) — 2-3 days for the dual-surface (object-verb + interactive wizard) implementation. Small surface, isolated.
4. **Live reload + WebView console bridge** (#1 + #5) — 5-7 days combined; share the `__mentra_dev` WebSocket channel from day one. Implementing in parallel is cheaper than sequentially.
5. **PERMISSION_NOT_DECLARED warning** (#3) — 1-2 days; trivial after #5 ships, since the warning automatically appears in the dev terminal via the bridge.

#1 and #5 should be one PR or back-to-back PRs by the same author — they share a network channel. Everything else can land independently.

---

## What this spec doesn't decide

- Anything about the larger `dev-applets-as-installed-apps` flow (separate spec).
- Anything about the SDK surface alignment (separate spec).
- Anything about the full simulator beyond MockTransport (separate spec — `miniapp-browser-testing-simulator-spec.md`).
- npm publishing of these packages (deferred — see `HUMAN-TODO-miniapp-improvements.md`).
