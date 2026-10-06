# @mentra/crust

The MentraOS native runtime layer: an [Expo module](https://docs.expo.dev/modules/overview/)
providing the native capabilities the Mentra Engine's miniapp runtime sits on —
per-miniapp JS contexts (QuickJS on Android, JavaScriptCore on iOS), the
native side of the MentraJS bridge, navigation, and device utilities.

You don't call crust directly from app code: it's a **peer dependency of
[`@mentra/engine`](https://www.npmjs.com/package/@mentra/engine)**. A host app
embedding the engine installs crust alongside it and Expo autolinking picks it
up.

## Install

```sh
npm install @mentra/crust@dev
```

> Currently published on the `dev` dist-tag (prerelease channel).

## Config plugin

The package ships an Expo config plugin (`app.plugin.js`) that carries its
Android build contract — Mapbox's maven repository, protobuf exclusions, and
core-library desugaring. Add it to the host app's Expo config:

```json
{"expo": {"plugins": ["@mentra/crust"]}}
```

Building with the navigation feature requires a `MAPBOX_DOWNLOADS_TOKEN` in
the Android build environment (Mapbox's SDK repository is authenticated).

The plugin also raises the host's Android build to Kotlin 2.3.0 (crust's
QuickJS library, `quickjs-kt` 1.0.15, is compiled with Kotlin 2.4) and pins
the root Kotlin Gradle plugin to that version. Every native module in the
host then compiles with Kotlin 2.3. Known incompatibility:
`react-native-gesture-handler` before 2.31.0 fails to compile; use 2.31.0 or
later.

At build time the Android side also reads the MentraJS polyfill bundle from
its [`@mentra/jspolyfill`](https://www.npmjs.com/package/@mentra/jspolyfill)
sibling, which is declared as a dependency.

## Part of MentraOS

Source lives in the [MentraOS monorepo](https://github.com/Mentra-Community/MentraOS)
under `mobile/modules/crust`. Issues and contributions welcome there.
