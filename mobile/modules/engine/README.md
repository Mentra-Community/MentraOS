# @mentra/engine

Mentra Engine — the on-device miniapp library.

## Installation

```sh
npm install @mentra/engine
```

> **Peer packages:** the engine's `@mentra/*` peer dependencies (`crust`,
> `cloud-client`, `cloud-protocol`, `miniapp`) must be available to your
> package manager. Until every peer is published to npm, consume the engine
> from this monorepo's workspace (as the example OEM app does).

> **Module format:** the published entry points target **React Native /
> Metro** consumers (the `react-native` exports condition). Loading
> `@mentra/engine` from plain Node (`require`/ESM) is not supported at 0.1.x —
> the `default` condition's build output is ESM with extensionless imports and
> will not resolve under Node's loader.

## Entry points

The package exposes three entry points (declared in `package.json` `exports`,
with the `react-native` condition pointing at `src/` so Metro, tsc and jest
resolve live TypeScript source):

- **`@mentra/engine`** (main, `src/index.ts`) — the OEM-facing surface: the
  `engine` namespace (`configure`/`start`/`stop` + typed domain facades),
  contract/read-model types, and pure helpers host UI renders with
  (`decideReconnect`, `deriveDisplayState`, the `useApps`-style hooks,
  OTA policy constants, hardware capability tables, `BgTimer`). Judgment rule:
  read models, commands, pure functions and types are main; anything that
  mutates runtime state or exposes a store/service is not.
- **`@mentra/engine/internal`** (`src/internal.ts`) — the migration-era
  runtime surface: raw zustand stores (`useCoreStore`, `useSettingsStore`,
  `useAppStatusStore`, …) and service singletons (`appRegistry`, `restComms`,
  `cloudClientService`, the gallery cluster, the miniapp engine, …). The
  host's `@/stores/*` shims re-export from here. New host code should use
  `engine.*` instead; `scripts/check-mobile-runtime-boundary.sh` counts every
  `/internal` import in `mobile/src` (report-only) as the burn-down metric.
- **`@mentra/engine/devtools`** (`src/devtools.ts`) — debug-only singletons
  (`miniappRunningRegistry`, `devServerBridge`) for the internal dev screens.

See `cloud-v2/docs/issues/020-glasses-status-boundary/integration-review.md`
§D for the burn-down plan.

This module owns the pieces of miniapp logic and handling that aren't tied to
the rest of the manager app: the WebView message bus, the in-memory running
registry, and the JS globals that we inject into every miniapp WebView.

The goal is for all miniapp logic to live here over time. Today the move is
incremental — only the self-contained services have moved. Cross-cutting
services (LocalMiniappRuntime, MantleManager, Composer install pipeline) still
live under `mobile/src/` because they reach back into the manager's stores and
sockets.

## Public surface

```ts
import {engine, decideDevLaunchRoute} from "@mentra/engine"
import {webviewBridge, buildMiniappGlobalsScript} from "@mentra/engine/internal"
import {miniappRunningRegistry} from "@mentra/engine/devtools"
```

- `webviewBridge` — registers per-package WebView message handlers so any
  service can `postMessage` JSON into a specific miniapp.
- `miniappRunningRegistry` — session-scoped set of currently-mounted local
  miniapp packageNames (foreground + background).
- `buildMiniappGlobalsScript` — builds the `window.MentraOS` injection script
  (and CSS variables / console-tap shim) used by every miniapp WebView.
- `decideDevLaunchRoute` — pre-flight a dev URL's `miniapp.json` to decide
  whether to mount live or take the user to the offline screen.

## Imports

Inside `mobile/modules/engine/src/`, use **relative paths** (`./services/...`,
`../utils/...`). The mobile app's `@/*` alias is not configured here — there
is no build-time path rewriter for this module.
