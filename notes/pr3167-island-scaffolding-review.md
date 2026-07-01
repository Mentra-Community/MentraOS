# PR #3167 island scaffolding review

Branch reviewed: `aisraelov/island-namespace-wifi` at `5919f03fb`
Base reviewed against: `origin/dev`

## Goal

PR #3167 moves a large amount of Mentra App runtime logic into `@mentra/island`
so island can be the toolkit/runtime boundary for MentraOS. The host app should
mostly provide branded UI, login, navigation, and copy. Island should own the
smartglasses OS primitives: device state projection, settings sync, cloud-v2
runtime, miniapp runtime, display, speech, gallery sync, OTA state, permissions,
and bug-report mechanics.

During the merge conflict resolution we accepted some temporary scaffolding so
the PR could stay conflict-free without rewriting every host screen at once. This
doc inventories those places and separates:

- **Scaffolding**: temporary compatibility paths/wrappers added to keep the large
  PR landable. These should be deleted or narrowed.
- **Valid seams**: host-provided UI/login/navigation hooks that are part of the
  intended toolkit/host split.
- **Follow-up design questions**: places where the current code works, but the
  final boundary should be reviewed deliberately.

## Summary judgment

The main scaffolding is the host import compatibility layer. It is useful for
landing the migration, but it keeps host screens consuming raw island internals
through familiar `@/...` paths. That is exactly what we want to remove over time.

The highest-priority cleanup is not every shim at once. `settings` and `glasses`
still have many host importers, so deleting those shims immediately would be a
big UI migration. The better first targets are small wrappers with few callers:
`@/services/cloudClient`, `@/services/ws-types`, `@/types/asg`, and the literal
`REQUEST_WIFI_SETUP_TYPE` workaround.

## Scaffolding inventory

### 1. Host store re-export shims

Files:

- `mobile/src/stores/settings.ts`
- `mobile/src/stores/glasses.ts`
- `mobile/src/stores/display.ts`
- `mobile/src/stores/gallerySync.ts`
- `mobile/src/stores/core.ts`
- `mobile/src/stores/connection.ts`
- `mobile/src/stores/cloudClientStatus.ts`

What they do:

These files re-export stores now owned by `@mentra/island` so existing Mentra App
imports keep compiling. Example: `mobile/src/stores/display.ts` only exports
`useDisplayStore` from `@mentra/island`.

Why they exist:

The PR moved the state ownership into island, but many host screens and tests
still import the old host paths. Caller pressure from a quick scan:

| Host path | Importing files |
|---|---:|
| `@/stores/settings` | 89 |
| `@/stores/glasses` | 40 |
| `@/stores/core` | 14 |
| `@/stores/connection` | 7 |
| `@/stores/display` | 7 |
| `@/stores/gallerySync` | 6 |
| `@/stores/cloudClientStatus` | 2 |

Judgment:

This is real scaffolding. It is acceptable for landing the PR, but it is not the
OEM/toolkit contract. It leaks raw island Zustand state back into host code.

Cleanup path:

1. Keep `settings` and `glasses` shims until the host screens have typed read
   models or toolkit facades for the specific UI needs.
2. Remove smaller shims first:
   `cloudClientStatus`, `display`, `gallerySync`, `connection`, then `core`.
3. For each removal, replace host imports with either:
   - a typed toolkit facade (`toolkit.display.mirror`, `toolkit.gallery.status`,
     `toolkit.session.status`, etc.), or
   - an explicit Mentra App debug screen exported from island if the screen is not
     OEM-facing.
4. Keep `toolkit.stores.*` documented as an internal Mentra App escape hatch only
   while this migration is active.

### 2. Host service/type re-export shims

Files:

- `mobile/src/services/RestComms.ts`
- `mobile/src/services/ws-types.ts`
- `mobile/src/types/asg/index.ts`
- `mobile/src/utils/GlobalEventEmitter.tsx`
- `mobile/src/utils/cloudClient/MmkvSecureStore.ts`

What they do:

These preserve old host import paths for services/types moved into island.

Judgment:

Mixed:

- `RestComms` is scaffolding but tied to cloud-v1 retirement. It can probably
  disappear when v1 sign-in/account/settings remnants are ported to cloud v2.
- `ws-types` and `types/asg` are easy scaffolding. They should be removed once
  host imports point at `@mentra/island` or domain-specific toolkit types.
- `GlobalEventEmitter` is scaffolding with higher risk. It keeps the deprecated
  process-wide event bus alive across host and island. New code should use typed
  subscriptions/facades.
- `MmkvSecureStore` currently has no host importers in the scan. It is a good
  candidate for immediate deletion after confirming no platform-specific import
  path uses it indirectly.

Cleanup path:

1. Delete `MmkvSecureStore` shim if a full repo grep stays at zero host imports.
2. Move `ws-types` importers to island/typed facade and delete the host shim.
3. Move `types/asg` importers to island or a gallery facade type export.
4. Replace `GlobalEventEmitter` use sites with typed Bluetooth SDK or toolkit
   subscriptions; delete only after OTA/gallery/settings screens are off it.
5. Keep `RestComms` only as long as cloud-v1 host remnants still call it.

### 3. `@/services/cloudClient` delegating wrapper

File:

- `mobile/src/services/cloudClient.ts`

What it does:

The actual `CloudClient` singleton now lives in island
(`cloudClientService`). The host wrapper still resolves dev/default cloud-v2
endpoint URLs from host settings/env/Metro, exposes `cloudConfigValues()` for
`toolkit.configure({config})`, and delegates runtime calls to island.

Current host callers:

- `mobile/src/services/MantleManager.ts` uses `cloudConfigValues()`.
- `mobile/src/components/dev/CloudUrl.tsx` uses `resolvedEndpoints()` and
  `cloudClient.reconnect()`.
- `mobile/src/services/miniapps/preinstalledMiniappSync.ts` uses
  `cloudClient.getPreinstalledMiniappRegistry()`.

Judgment:

This is scaffolding, but it also encodes a real open design question: where
should dev endpoint resolution live? The cloud client itself belongs in island.
The dev UI belongs in the host. The URL resolution logic currently sits between
those two.

Cleanup path:

1. Move preinstalled registry access to a `toolkit.miniapps` or
   `toolkit.dev` method so `preinstalledMiniappSync` does not need the wrapper.
2. Move reconnect/resolved endpoint read-model into a toolkit dev facade:
   `toolkit.dev.cloudUrls()`, `toolkit.dev.resolvedCloudUrls()`,
   `toolkit.dev.reconnectCloud()`.
3. Decide whether Metro/env resolution remains host-provided config or becomes an
   island dev helper. For OEMs, this should not be part of the public contract.
4. Delete `mobile/src/services/cloudClient.ts` once the three host callers are off
   it.

### 4. `toolkit.stores.*` raw store escape hatch

Files:

- `mobile/modules/island/src/island.ts`
- `docs/glasses-oems/toolkit.mdx`
- `mobile/modules/island/src/index.ts`

What it does:

The toolkit exports raw Zustand stores under `toolkit.stores.*` and re-exports
them from the island barrel so the first-party Mentra App can continue to use
store internals during migration.

Judgment:

This is intentional scaffolding. It should not be the OEM contract, but it may be
the right short-term bridge for Mentra-owned screens and dev/debug screens. The
docs already warn that it is not public API.

Cleanup path:

1. Keep the docs warning.
2. Add new typed read models as host screens migrate.
3. For dev-only screens, consider exporting whole island-owned debug views rather
   than forcing OEM host code to reach into raw stores.
4. Remove stores from the OEM docs before toolkit release if they are still only
   Mentra-internal.

### 5. `configureRuntime({wifiSetup})`

Files:

- `mobile/modules/island/src/runtime/config.ts`
- `mobile/src/services/MantleManager.ts`
- `mobile/modules/island/src/services/LocalMiniappRuntime.ts`

What it does:

Island handles `session.glasses.requestWifiSetup`, but the actual UI/navigation
to `/wifi/scan` is still provided by the host through `configureRuntime`.

Judgment:

This is a valid seam in shape, but the mechanism is scaffolding. Miniapps need a
toolkit primitive for "request the host to show Wi-Fi setup UI." The host owns
the screen and branding; island owns the miniapp request dispatch and response.
That should probably be represented in the primary `toolkit.configure(...)`
contract, not a side-channel `configureRuntime`.

Cleanup path:

1. Fold this into `toolkit.configure({ui: {requestWifiSetup}})` or another named
   host-UI adapter section.
2. Keep it structured and narrow; do not generalize it into arbitrary host
   runtime hooks.
3. Delete `configureRuntime` once no other hooks remain.

### 6. `REQUEST_WIFI_SETUP_TYPE` literal workaround

File:

- `mobile/modules/island/src/services/LocalMiniappRuntime.ts`

What it does:

The dispatcher checks the literal `"miniapp_request_wifi_setup"` instead of
`MiniappRequestType.REQUEST_WIFI_SETUP`.

Judgment:

This is pure rebase/build scaffolding. The source and rebuilt generated package
now contain `MiniappRequestType.REQUEST_WIFI_SETUP`, so the literal should not
remain.

Cleanup path:

Replace the literal case with `MiniappRequestType.REQUEST_WIFI_SETUP` and remove
the local constant. This is a tiny standalone cleanup.

### 7. `mentraJsBootstrap` host wrapper

File:

- `mobile/src/services/mentraJsBootstrap.ts`

What it does:

Island owns the miniapp engine, router, launcher, and crash-loop controller. The
host wrapper attaches Mentra App telemetry and UI:

- Sentry capture/breadcrumbs
- automatic incident submission
- user-facing alert text

Judgment:

This is mostly a valid host seam, not bad scaffolding. The host owns Sentry
project wiring and user-facing alert copy. However, the automatic incident filing
belongs to island/runtime policy more than OEM UI. We already moved incident
submission into the toolkit in the incident migration work, so this should be
reviewed once the stacked incident/cloud-v2 branch lands under this PR.

Cleanup path:

1. Keep host alert and Sentry wiring host-side.
2. Move automatic crashloop incident filing into island once the incident facade
   is available on this branch.
3. Consider replacing `bootstrapMentraJS()` with `toolkit.miniapps.onCrashloop`
   / `toolkit.notifications` subscriptions plus host UI handlers.

### 8. App-start `beforeStart` host hook

Files:

- `mobile/modules/island/src/stores/apps.ts`
- `mobile/src/services/miniapps/BuiltInMiniappCatalog.ts`

What it does:

Island app store calls a host-installed `beforeStart` hook. The hook handles
Mentra App behavior before launching local miniapps:

- branded hardware-incompatible alerts
- offline speech model alert/navigation
- host navigation/open animation
- `has_ever_activated_app` setting

Judgment:

This is mixed. Host alerts/navigation are valid host responsibilities. But the
name and location (`installAppStoreHooks`) make it feel like a broad arbitrary
escape hatch. The hook also duplicates some compatibility gating that island now
does natively after the hook.

Cleanup path:

1. Split the hook into explicit concerns:
   `onIncompatibleMiniapp`, `onMissingSpeechModel`, `onMiniappOpenRequested`, or
   equivalent structured notifications.
2. Keep the actual compatibility decision in island; host only renders the
   notification and chooses navigation.
3. Remove broad `beforeStart` once structured hooks exist.

### 9. Gallery host gates and notices

Files:

- `mobile/modules/island/src/facades/gallery.ts`
- `mobile/modules/island/src/services/asg/galleryNotices.ts`
- `mobile/src/components/glasses/Gallery/GalleryScreen.tsx`

What it does:

Island owns gallery sync and emits structured notices. The host renders alerts,
deep-links, and localized copy. The host also runs a pre-sync connectivity gate
for Bluetooth and Android location UI before calling `toolkit.gallery.sync()`.

Judgment:

The structured notice design is a valid seam. The host pre-sync connectivity
gate is more questionable: connectivity and permissions are OS/runtime facts,
but alerts and deep-links are host UI. The final boundary should probably move
the checks into island and emit structured notices before sync starts.

Cleanup path:

1. Keep `GalleryNotice` as the host UI surface.
2. Move the pre-sync connectivity/permission checks from `GalleryScreen` into
   island if they can be represented as structured notice codes.
3. Keep host-owned alert copy and settings navigation in the screen.

### 10. Bluetooth SDK internal passthrough

Files:

- `mobile/modules/island/src/index.ts`
- `mobile/modules/bluetooth-sdk/src/_internal.ts`

What it does:

Island re-exports the Bluetooth SDK internal entrypoint for Mentra App-only code.
The PR also replaced deep build-output imports with the declared internal package
subpath.

Judgment:

This is an internal escape hatch, not an OEM toolkit API. It is better than deep
relative `build/_internal` imports, but it should not become a permanent way for
host screens to bypass toolkit facades.

Cleanup path:

1. Keep the declared `@mentra/bluetooth-sdk/internal` subpath.
2. Do not add new host code that imports Bluetooth SDK internals through island.
3. Replace internal passthrough usages with toolkit facades as domains land.

### 11. OTA deferred retry and host orchestration

Files:

- `mobile/modules/island/src/facades/ota.ts`
- `mobile/modules/island/src/services/OtaService.ts`
- `mobile/src/app/ota/check-for-updates.tsx`
- `mobile/src/app/ota/progress.tsx`

What it does:

Island exposes OTA read/observe surfaces, but some orchestration and retry logic
remain host-side. The retry method was deferred to avoid changing view behavior
without preserving the original manifest/status flow.

Judgment:

This is acceptable scaffolding for the PR. OTA is risky enough that the better
move is to preserve behavior and migrate it in a focused OTA cleanup.

Cleanup path:

1. Document the current host-vs-island split in the OTA service.
2. Port manifest compare, retry, and stuck-watchdog orchestration into island in
   one focused commit.
3. Keep host UI as progress presentation only.

## Not scaffolding

These are intentionally host-owned and should not be "cleaned up" merely because
they cross the boundary:

- `toolkit.configure({auth})`: host owns login; island owns token exchange and
  runtime use after receiving a subject token.
- Host alert copy, i18n, theming, and navigation: OEM-branded apps must own this.
- Gallery `onNotice` style structured UI events: this is the right pattern for
  island runtime facts that need host presentation.
- Dev/debug screens if exported intentionally by island as complete debug views.

## Recommended cleanup order

1. **Tiny correctness cleanup**
   - Replace `REQUEST_WIFI_SETUP_TYPE` with `MiniappRequestType.REQUEST_WIFI_SETUP`.
   - Delete `mobile/src/utils/cloudClient/MmkvSecureStore.ts` if the zero-import
     scan still holds.

2. **Small host shims**
   - Remove `@/services/ws-types`.
   - Remove `@/types/asg`.
   - Reduce `@/services/cloudClient` by moving its three callers to toolkit/dev
     surfaces.

3. **Structured hook cleanup**
   - Replace `installAppStoreHooks({beforeStart})` with typed notifications and
     host UI callbacks.
   - Fold `configureRuntime({wifiSetup})` into `toolkit.configure` or a named UI
     seam.

4. **Raw store migration**
   - Move `display`, `cloudClientStatus`, `gallerySync`, `connection`, and `core`
     host consumers onto typed facades or island-owned debug views.
   - Leave `settings` and `glasses` for later because they have the largest host
     caller pressure and need careful UI read models.

5. **Domain migrations**
   - OTA orchestration.
   - Gallery pre-sync gates.
   - Crashloop incident filing after the incident/cloud-v2 stack is in place.
   - Cloud-v1 `RestComms` deletion once sign-in/account/settings remnants are on
     cloud v2.

## Suggested review checklist for future conflict resolutions

When resolving this stack again, flag any new code that does one of these:

- Re-exports an island store/service from `mobile/src/...`.
- Adds a broad host hook into island (`configureRuntime`, `beforeStart`,
  `adapter`, `callback`) instead of a named UI seam.
- Reads raw `useGlassesStore` or `useSettingsStore` in host screens when a typed
  toolkit facade exists.
- Imports Bluetooth SDK internals for a domain that already has a toolkit facade.
- Adds a string literal for a protocol enum that exists in `@mentra/miniapp`.
- Adds user-facing strings or navigation inside island services instead of
  structured notices.
