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

The package exposes its Engine entry points and a supported Bluetooth SDK
facade (declared in `package.json` `exports`,
with the `react-native` condition pointing at `src/` so Metro, tsc and jest
resolve live TypeScript source):

- **`@mentra/engine`** (main, `src/index.ts`) — the OEM-facing surface: the
  `engine` namespace (`configure`/`start`/`stop` + typed domain facades),
  contract/read-model types, and pure helpers host UI renders with
  (`decideReconnect`, `deriveDisplayState`, the `useApps`-style hooks,
  OTA policy constants, hardware capability tables, `BgTimer`). Judgment rule:
  read models, commands, pure functions and types are main; anything that
  mutates runtime state or exposes a store/service is not.
- **`@mentra/engine/ota`** (`src/react/index.ts`) — `FirmwareUpdateFlow` and
  `useFirmwareUpdate` render device-bound providers. Providers own execution
  outside React; unmounting a view does not cancel an update. The compatible
  `MentraLiveOtaFlow` and `useMentraLiveOta` use that same retained Live provider.
- **`@mentra/engine/bluetooth-sdk`** (`src/bluetooth-sdk/index.ts`) — the
  complete public Bluetooth SDK surface, re-exported without a wrapper so it
  has the same singleton identity as `@mentra/bluetooth-sdk`. The supported
  SDK `react`, `types`, `photo-receiver`, `ota-transport`, `firmware-updates`, and `debug` subpaths are mirrored
  below this path. The SDK's `internal` entrypoint is deliberately not exposed.

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
import BluetoothSdk from "@mentra/engine/bluetooth-sdk"
```

- `decideDevLaunchRoute` — pre-flight a dev URL's `miniapp.json` to decide
  whether to mount live or take the user to the offline screen.

### Device firmware updates

```tsx
import {FirmwareUpdateFlow} from "@mentra/engine/ota"

;<FirmwareUpdateFlow entryPoint="settings" onFinished={closeUpdateScreen} onOpenWifiSetup={openWifiSetup} />
```

The flow resolves the paired native device identity and its registered updater.
An explicit `target` can be supplied; model names alone never authorize a write.
Hosts render allowed actions and delegate them to `engine.firmwareUpdates`.
`pairingPolicy(model)` declares Bluetooth Classic, firmware-check and onboarding
requirements independently. An OTA capability does not imply Live's Wi-Fi setup.
For pairing, handle `onFinished(result)` with `result?.outcome === "cancelled"`
by returning to device selection, without completing onboarding. This is a safe
exit before an incompatible device can update; it does not remove the native
firmware compatibility restriction or cancel an unsafe transfer.

`snapshot`/`subscribe` observe a provider; `open` checks or adopts it; `perform`
admits an allowed action against the displayed offer. `safeToRelease` governs
device replacement and cleanup. A displayed failure can still require recovery.
Call `assertSafeToRelease` before intentional logout, unpair or deployment changes.
Runtime stop suspends optional checks/passes while retaining unsafe device work.

`retainedSnapshots`/`subscribeRetained` expose existing Engine sessions without
opening them. `observeNativeRecovery` additionally reads native sessions after a
JS reload or cold process start. It performs local observation only and may be
mounted outside authentication; keep this recovery surface alive when auth is
revoked. Native recovery never restores authorization for another Live pass.

NIMO uses the SDK's `device-firmware.json` catalogue and exact firmware identities.
The catalogue deliberately has no production manifest pin until the firmware is
approved and published. Missing update sources do not disable an already-known
compatible build. Organization deployments disable public fallback by default.
AR99's managed migration requires an explicitly injected vendor source; it has
no default vendor fallback. The Mentra App retains its existing AR99 flow unless
`EXPO_PUBLIC_ENABLE_MANAGED_AR99_OTA=true` is set for deliberate validation.
Failed-transfer recovery must be verified before enabling that migration in
production. A validated image is reported separately from a verified running
firmware version; an arbitrary error never proves that device writes stopped.

### Mentra Live compatibility flow

Bluetooth-only hosts can render the OTA flow without configuring or starting
the authenticated cloud connection or miniapp runtime:

```tsx
import {MentraLiveOtaFlow} from "@mentra/engine/ota"
;<MentraLiveOtaFlow onFinished={() => setShowOta(false)} onOpenWifiSetup={() => setShowWifiSetup(true)} />
```

The component starts only the glasses-status and OTA projections. A host that
already called `engine.start()` should pass `initializeRuntime={false}`. Show
the flow after a Mentra Live connects. Hosts must provide `onOpenWifiSetup`;
the flow invokes it only for older glasses that cannot provide the OTA hotspot
transport.

Apps that need different pages can render the same controller directly:

```tsx
import {useMentraLiveOta} from "@mentra/engine/ota"

const ota = useMentraLiveOta({onFinished, onOpenWifiSetup})
// Render ota.state.screen and invoke ota.install(), retryInstall(), finish(), etc.
```

On `up_to_date`, use `ota.state.completedUpdate` to distinguish a completed
update session from a standalone check. `releaseTransition` is optional release
metadata and is not a completion marker.

Customize presentation only. Engine must remain responsible for OTA ordering,
hotspot staging, restart recovery, retries, and verification. The canonical
stock and custom integration guide is
[Update Mentra Live](https://docs.mentraglass.com/bluetooth-sdk/software-update).

Released Engine packages contain a literal immutable OTA manifest URL and
SHA-256 generated by coordinated release CI. Modern-glasses manifest selection
is developer override, host-app release pin, then Engine release pin. It does
not derive a URL from the Bluetooth SDK version or fall through to a
glasses-reported or mutable production URL. An unpinned source build has OTA
disabled unless an Expo/React Native host explicitly sets
`EXPO_PUBLIC_ASG_OTA_VERSION_URL`; native source hosts use the Bluetooth SDK's
debug `setOtaVersionUrl` surface. Pre-39 glasses retain their separate legacy
path because those clients ignore the URL sent by the phone.

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
_different_ test file — each file must set up everything it imports.

## Phone notification presentation

`engine.phoneNotifications` owns native-notification configuration alongside the existing Android listener kill switch and per-app blocklist. Capture remains independent of presentation. A host starts/stops its presentation owner with `setPresentationActive(boolean)`; the Mentra App uses Notify's running state on both platforms.

- `nativeCapabilities()` distinguishes native presentation, phone content access, app filtering, and removal support.
- `nativeStatus()` / `onNativeStatus(listener)` expose native availability, authorization, desired controls, and failures.
- `usesNativePresentation()` selects firmware presentation. A host forwards its captured event through `presentNative(event)` and skips its local card for that event. This does not replace permission-gated miniapp forwarding.
- `onNativeDelivery(listener)` exposes Android transfer outcomes without message content.

Settings are `native_notifications_enabled`, `native_notifications_auto_display`, `native_notifications_duration`, and `native_notifications_do_not_disturb`. Native presentation defaults off. The Android `notifications_blocklist` is also passed to native configuration so pending work is invalidated when filtering changes. Disconnected events are not retained for replay.

On iOS, G2 receives ANCS directly; the host does not upload the app-identity relay back to the glasses. Full title/body access, editing the firmware app filter, and phone-dismissal synchronization remain unsupported. The existing G2 app-identity event is not evidence of full content access.
