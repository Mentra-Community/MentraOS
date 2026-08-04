# MentraOS Miniapp SDK — Docs

Per-module reference for the `@mentra/miniapp` SDK. Each page documents one
module on `session.<module>`: what the methods take, what they return, what
events fire, and the error shapes to expect.

> New here? Start at the [SDK developer guide](../README.md) for setup + the
> doc map, or the [package API reference](../../mobile/modules/miniapp/README.md)
> for the full session/module surface.

## Architecture

- [two-layer.md](./two-layer.md) — two-layer miniapp model
  (background JSContext + on-demand UI WebView). Read first if you're
  writing a new miniapp.
- [ui.md](./ui.md) — `session.ui` message bus + the `mentra` global on
  the WebView side.

## Modules

| Module | Doc | Notes |
| --- | --- | --- |
| `session.ui` | [ui.md](./ui.md) | Two-layer message bus to the bound UI WebView. Background-only. |
| `session.navigation` | [navigation.md](./navigation.md) | Turn-by-turn + pivots. Android only. Largest surface. |
| `session.location` | [location.md](./location.md) | 1 getter + 2 methods. Manifest-gated. |
| `session.display` | [display.md](./display.md) | 6 fire-and-forget methods. No permission gating, no responses. |
| `session.input` | [input.md](./input.md) | 2 methods (one with 3 overloads). |
| `session.heading` | [heading.md](./heading.md) | Android only (despite JSDoc claiming both). |
| `session.imu` | [imu.md](./imu.md) | Minimal — one subscribe. Accel/orientation flagged future work. |
| `session.mic` | [mic.md](./mic.md) | Has `stop()` aggregate teardown + permission getter. |
| `session.speaker` | [speaker.md](./speaker.md) | Full state machine + normalized TTS error codes. |
| `session.camera` | [camera.md](./camera.md) | `hasPermission`, `setFov`, `takePhoto`. No sync permission throw. |
| `session.dashboard` | [dashboard.md](./dashboard.md) | Deferred in v1 — `setContent` is a noop+warn. |
| `session.glasses` | [glasses.md](./glasses.md) | No manifest gate. |
| `session.led` | [led.md](./led.md) | All methods are fire-and-forget despite `Promise<void>` signatures. |
| `session.storage` | [storage.md](./storage.md) | No manifest gate. |
| `session.stream` | [stream.md](./stream.md) | Wire path bridged but daemon side not live in v1. |
| `session.system` | [system.md](./system.md) | Share / download helpers. |
| `session.translation` | [translation.md](./translation.md) | Smallest module — 1 subscribe + `stop()` + permission getter. |
| `session.transcription` | [transcription.md](./transcription.md) | MICROPHONE-gated but rejects async via session error event, not sync throw. |
| `session.permissions` | [permissions.md](./permissions.md) | Read-only observation surface. `has()` is "any form declared". |
| `session.phone` | [phone.md](./phone.md) | Composite — `notifications` + `calendar` sub-modules + flat `onBattery`. |

## Conventions

- All examples assume `session` was obtained via `new MiniappSession({...})`
  and `await session.connect()`.
- Permission-gated APIs throw `{code: "PERMISSION_NOT_DECLARED", message}`
  **synchronously** if the relevant manifest permission is missing — they
  never return a rejected Promise for that case.
- Subscribe APIs (`onUpdate`, `onRoute`, `onPivot`, etc.) return an
  `UnsubscribeFn`. Call it to detach.
- All wire-level requests resolve with an ack from the phone-side daemon.
  `ok: true` means the request was accepted, **not** that the underlying
  operation succeeded — watch the corresponding stream for the real result.
