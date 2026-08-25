# Example OEM App

A minimal Expo app that demonstrates consuming the **`@mentra/engine`** SDK —
the on-device miniapp registry and runtime — the way an OEM integrator would.

The screen exposes the core miniapp controls:

- **Start miniapp** — launches the first registered app (`useStart`).
- **Stop miniapp** — stops the running miniapp (`useStop`).
- **List running miniapps** — reads the public `running` state returned by
  `useApps`.

Every button routes through an on-screen console (bottom of the screen) so you
can see each call's result or error without a Metro terminal attached.

> Engine depends on `@mentra/bluetooth-sdk` (its native module + Expo config
> plugin), so that package is still installed and wired into the native build —
> but the app's own code imports only `@mentra/engine`.

## Layout

| File              | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `App.tsx`         | Single screen: state, miniapp buttons, console                      |
| `src/ui.tsx`      | `Section` / `ActionButton` / `StatusRow` presentational helpers     |
| `src/useLog.ts`   | Tiny in-memory console hook (`run` wraps an engine call)            |
| `app.json`        | Expo config: bluetooth-sdk plugin (native module), build properties |
| `metro.config.js` | Watches `mobile/modules` so the SDKs resolve from the monorepo      |

## Running

This app pulls in native code (via engine's bluetooth-sdk dependency), so
**Expo Go cannot load it** — you need a development build on a physical phone.

```sh
# from this directory
bun install
bunx expo prebuild
bunx expo run:ios       # or: bunx expo run:android
```

The SDK is consumed straight from the monorepo (`mobile/modules/engine`). If you
edit the engine source, rebuild it first — it resolves to its `build/` output,
not `src/`:

```sh
cd ../../mobile/modules/engine && bun run build
```

## Notes

- The **Start** button launches the first registered app. In a real OEM
  integration you configure the engine with `engine.configure()` and install
  miniapps; this demo simply drives whatever the
  registry already holds, so with no host wiring the registry starts empty and
  the buttons report "no miniapps registered."
