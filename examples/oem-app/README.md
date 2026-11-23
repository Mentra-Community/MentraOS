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

| File                  | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `App.tsx`             | Single screen: state, miniapp buttons, console                          |
| `src/ui.tsx`          | `Section` / `ActionButton` / `StatusRow` presentational helpers         |
| `src/useLog.ts`       | Tiny in-memory console hook (`run` wraps an engine call)                |
| `src/miniappLinks.ts` | Miniapp links: hands a tapped link to `engine.miniapps.installFromLink` |
| `app.json`            | Expo config: bluetooth-sdk and engine plugins, build properties         |
| `metro.config.js`     | Watches `mobile/modules` so the SDKs resolve from the monorepo          |

## Running

This app pulls in native code (via engine's bluetooth-sdk dependency), so
**Expo Go cannot load it** — you need a development build on a physical phone.

The app is a member of the `examples/` Bun workspace
([`examples/package.json`](../package.json)), which links the `@mentra/*`
packages (`workspace:*`) to their source in this monorepo (`mobile/modules`,
`cloud-v2/packages`). Install from `examples/`; installing runs the linked
packages' `prepare` scripts, which build them:

```sh
# from the MentraOS root
cd examples && bun install && cd ..
(cd mobile/modules/engine && bun run build)
cd examples/oem-app
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

- **Miniapp links.** The `@mentra/engine` plugin in `app.json` claims
  `https://apps.mentraglass.com/open?url=<miniapp URL>`, and `src/miniappLinks.ts`
  hands a tapped link to `engine.miniapps.installFromLink`. The `https` link opens
  an app only once Mentra lists it on that host, which it doesn't for this example;
  the app's own scheme works without that:
  `adb shell am start -a android.intent.action.VIEW -d "exampleoemapp://open?url=https://notes.example.com/"`.
  See "Miniapp links" in the
  [engine docs](../../mintlify-docs/glasses-oems/engine.mdx).

- The **Start** button launches the first registered app. In a real OEM
  integration you configure the engine with `engine.configure()` and install
  miniapps; this demo simply drives whatever the
  registry already holds, so with no host wiring the registry starts empty and
  the buttons report "no miniapps registered."
