# Miniapp Browser Testing & Simulator — Stub Spec

## Status

**Stub. Stage-1 stopgap (MockTransport) has moved to [`miniapp-quick-fixes-spec.md`](./miniapp-quick-fixes-spec.md) as section #6.** This doc now covers only the full simulator (Stage 2), which is a multi-week project that needs its own dedicated brainstorm + spec pass before any implementation.

The decision to keep this short on purpose: the full simulator is roughly a multi-week effort that affects three packages (`@mentra/miniapp`, `@mentra/miniapp-cli`, a new simulator package), and several distinct user workflows. Trying to design it inline alongside the smaller dev-ex fixes would either undersize it or bury the smaller fixes. So we capture the goal here, list the architectural questions, and treat the full design as a follow-up.

## What's already shipped (in quick-fixes spec)

`MockTransport` — a ~50-line stopgap that prevents the WebView from hanging when a miniapp loads in a regular laptop browser. Synthetic CONNECT_ACK, fake responses for non-event requests, no event simulation. Unblocks the basic "render my UI in a browser" workflow but doesn't help with anything beyond that.

This spec picks up where MockTransport leaves off: real event injection, glasses-display preview, hardware bridges, dev-tools-grade workflow.

## Goal (high level)

Authors should be able to develop and test miniapps in a laptop browser with **the same code** that runs on the phone. No `if (browser) {...}` branches in app code, no separate "dev mode" SDK API. Just: `bun run dev` opens a browser to the miniapp, the miniapp connects to a *simulator*, the simulator stubs or proxies the host functions, the developer can:

- See the UI render as it would on the phone.
- Trigger events (transcription, button presses, location updates) from a control panel.
- See display layouts the miniapp would push to the glasses, rendered as a 640×200 panel.
- Use the laptop's webcam / mic for camera/microphone testing.
- Open Chrome/Safari DevTools, set breakpoints, inspect state, see console logs.

This is closer to **iOS Simulator + Xcode** than to React Native dev mode. It's a real piece of dev tooling.

## Architecture sketch

A real simulator host process — architecturally **a mock of the phone**, runnable as a CLI command:

```bash
mentra-miniapp simulate
```

…which spawns:

- A WebSocket server on `127.0.0.1:8765` (mimics the phone's `MiniSockets` interface, so the SDK's existing `LocalSocketTransport` connects to it directly).
- A control-panel UI hosted by the simulator (likely on `:8766`) for triggering events and watching display state.
- A glasses-display preview surface (renders `session.layouts.*` calls visually).
- A microphone/camera bridge to the laptop's hardware (so `session.audio.speak()` plays through speakers, `session.camera.takePhoto()` snaps the webcam).

The miniapp opens in the laptop browser and connects via `LocalSocketTransport` to the simulator (which is now reachable because it's on the laptop).

This is a big architectural surface. Open questions below.

## Open architectural questions (need full brainstorm)

1. **Where does the simulator live?**
   - Subcommand of `@mentra/miniapp-cli` (`mentra-miniapp simulate`)?
   - Standalone npm package `@mentra/simulator`?
   - Subcommand is more discoverable; standalone package is cleaner separation. Trade-off depends on simulator complexity.

2. **What does the simulator simulate vs. proxy?**
   - **Stub everything**: simulator generates fake events on a schedule / on button click. Reproducible, doesn't need real hardware, but fake.
   - **Proxy to a real phone over LAN**: simulator forwards real events from a paired phone. Authentic but requires the developer to keep their phone connected.
   - **Hybrid**: stub by default, proxy when a phone is available.

3. **Display rendering.** The glasses are 640×200 monochrome (or color, depending on model). Does the simulator render layouts as faithful 640×200 mockups, or as full-fidelity HTML approximations?

4. **Microphone / camera bridge.** How does `session.audio.onTranscription` work? Three options:
   - Use the laptop's mic + run STT locally (heavyweight, depends on the laptop having the model).
   - Use the laptop's mic + send audio to the cloud STT endpoint (most realistic, requires auth).
   - Stub with hand-typed text from the control panel (simplest, useful for scripted demos).

5. **Auth.** A real session needs a `userId` from auth. Does the simulator stub a userId, or does it require login? (Stub probably for the dev workflow; require login if proxying to real services.)

6. **Hot reload integration.** The simulator should integrate cleanly with the live-reload work in [`miniapp-quick-fixes-spec.md`](./miniapp-quick-fixes-spec.md) #1 + #5 — likely sharing the `__mentra_dev` WebSocket channel.

7. **Multi-miniapp testing.** Does the simulator support running multiple miniapps simultaneously to test inter-miniapp interactions? Probably not for V1, but worth flagging.

8. **Glasses-feature parity.** Some features (LED, button-on-glasses, head IMU) have no laptop equivalent. The control panel must surface these as manual triggers. What's the minimum viable surface — just `onButtonPress` + `onTranscription` + display preview, or full feature parity?

9. **Webview-only mode vs glasses-only mode.** Some miniapps are display-only; others have heavy webview UIs. Does the simulator render both, or focus on glasses-display only?

10. **Recording / replay.** Useful for repro: record a session of events from the simulator, replay later. Trickier to get right.

## Out-of-scope items for the full simulator

- Hardware-accurate rendering. The simulator is a developer aid, not a hardware emulator. Don't promise pixel-perfect glasses-display fidelity.
- Network emulation (latency, packet loss). Future.
- Multi-user / collaborative testing.
- iOS-vs-Android phone-OS-specific behavior. The simulator is one flavor.

## Sequencing

1. **Stage 1 (`MockTransport`) — already in [`miniapp-quick-fixes-spec.md`](./miniapp-quick-fixes-spec.md) #6.** Unblocks browser dev for the basic "my UI renders" workflow.
2. **Full simulator design** — separate brainstorm, separate spec doc, separate implementation. Probably 4-8 weeks of work depending on scope decisions. Dependent on the SDK surface alignment landing first ([`miniapp-sdk-surface-alignment-spec.md`](./miniapp-sdk-surface-alignment-spec.md)) so the simulator's event-injection API is built against the final module shape, not the in-flight one.

## What this spec doesn't decide

Almost everything beyond Stage 1. This is intentionally a placeholder — the simulator deserves its own design doc with its own brainstorm, drawing input from anyone who's built a similar tool (Expo Go, iOS Simulator, etc.). Treating it inline would be a mistake.

## Next step

Schedule a dedicated brainstorm for the full simulator. Likely after the surface-alignment spec ships (so the simulator design can absorb any SDK surface decisions made there).
