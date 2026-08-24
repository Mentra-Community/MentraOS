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

The package exposes four entry points (declared in `package.json` `exports`,
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
- **`@mentra/engine/react`** (`src/react/index.ts`) — shared full-screen React
  Native experiences. `MentraLiveOtaFlow` owns the complete check, hotspot or
  Wi-Fi install, APK/MTK/BES progress, reboot, retry, and final verification
  flow so hosts do not implement their own OTA state machines.

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

### Mentra Live OTA flow

Bluetooth-only hosts can render the OTA flow without configuring or starting
the authenticated cloud/miniapp runtime:

```tsx
import {MentraLiveOtaFlow} from "@mentra/engine/react"

<MentraLiveOtaFlow
  onFinished={() => setShowOta(false)}
  onOpenWifiSetup={() => setShowWifiSetup(true)}
/>
```

The component starts only the glasses-status and OTA projections. A host that
already called `engine.start()` should pass `initializeRuntime={false}`. Show
the flow after a Mentra Live connects; `onOpenWifiSetup` is needed only for
older glasses that cannot provide the OTA hotspot transport.

## Imports

Inside `mobile/modules/engine/src/`, use **relative paths** (`./services/...`,
`../utils/...`). The mobile app's `@/*` alias is not configured here — there
is no build-time path rewriter for this module.

## Testing

Run the suite with `bun run test` (from this directory). It executes
`scripts/test.sh`, which runs **each test file in its own bun process** — do
not replace it with a single `bun test src`.

Why: bun's `mock.module` patches one process-wide module registry with live
ESM bindings, last write wins. Several suites mock the same specifiers
(`"@mentra/bluetooth-sdk/internal"` alone is mocked by `audioTestMocks.ts`,
`PhonePhotoCoordinator.test.ts`, and others), so in a shared process one
file's mock clobbers another's and suites that pass alone fail in the
combined run. Per-file processes give every suite an isolated registry.

The same rule applies when writing tests: it is fine to `mock.module` any
specifier your suite needs, but never rely on a mock installed by a
*different* test file — each file must set up everything it imports.
