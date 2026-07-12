# Island facade buildout — tracking spec

Goal: build the OEM-facing `engine.*` typed facades by moving the backing logic
into `@mentra/engine`, domain by domain, on branch `aisraelov/island-namespace-wifi`
(PR #3167). One branch, one commit per domain, green at every commit.

## Two move-patterns
1. **Self-contained logic** — move the file into island, fix relative imports
   (btsdk types via `../../../bluetooth-sdk/build/_internal`), wrap in a facade.
   Shim the old host path if the app still imports it. (Stores, speech, logs,
   permissions, incidents.)
2. **Host-service-coupled** — move the logic in. Where it needs a host capability,
   prefer **owning it in island** (the keystone moved storage + the status store +
   the client itself in; only `auth` + endpoints come from the host, via the
   permanent `configure()` front door, NOT a `configureRuntime` adapter). Per
   OS-1622, every `configureRuntime` adapter is transitional scaffolding that
   **deletes itself** as its domain lands — "zero permanent adapters remain." So a
   `configureRuntime` bridge is a temporary means, not the destination; aim
   adapter-free. The one permanent seam is `auth.getSubjectToken`.

Rule: stores are the Mentra-app escape hatch (`engine.stores.*`), NOT the OEM
contract. OEMs use the typed facade functions.

## cloud-v2 mobile-CI integration (was fully broken on dev)
The cloud-v2 merge left the mobile CI red on dev (install died on a 404, so the
typecheck never even ran). Three fixes, all on this branch (they un-red dev too):
1. **Spurious dep** — `mobile/modules/engine/package.json` declared
   `"@mentra/cloud-client": "*"`; cloud-client is resolved via metro+tsconfig path
   aliases, not npm, so the `*` 404'd. Removed it.
2. **island standalone build** — `postinstall` builds island via `expo-module`
   (`build:module`), whose isolated tsconfig lacks the cloud-v2 aliases → fails on
   cloud-v2 imports. But island's `build/` is unused (metro + tsconfig resolve
   `@mentra/engine` → src). Made it non-fatal in `mobile/scripts/postinstall.mjs`.
3. **cloud-v2 deps** — the mobile typecheck follows the aliases into cloud-v2
   SOURCE (`../cloud-v2/packages/*`), which import `zod`/`tweetnacl`; resolution is
   file-relative so they must be in `cloud-v2/node_modules`, never installed (cloud-v2
   is a separate bun workspace). Added a `bun install` in `../cloud-v2` to the mobile
   postinstall.
Don't re-introduce island's `@mentra/cloud-client` package.json dep, and keep
`island/tsconfig.json`'s cloud-v2 `paths` (a local `build:module` regenerates and
strips them — don't commit that).

## Host-coupling reality (corrects the earlier "mechanical" optimism)
Only facades whose logic is ALREADY in island are quick wraps (done: glasses, wifi,
display.mirror, speech). The rest are HOST-SERVICE moves whose services are coupled
to host utils (i18n, theme, AlertUtils, storage, RestComms), so they need the
adapter-injection pattern (#2), not a trivial move:
- `permissions` — PermissionsUtils.tsx (1008 LOC, 24 consumers): imports i18n, theme,
  AlertUtils, NotificationServiceUtils, storage. Adapter-coupled.
- `settings` — the keystone (RestComms + storage + react-native-localize + expo-device).
- `incidents`, `dev`, `gallery`, `phoneNotifications` — similar host coupling.
These are real per-domain efforts, each its own careful commit.

## Docs (keep current as we go)
Each shipped domain is documented in the OEM docs at `mintlify-docs/glasses-oems/engine.mdx`
(Mintlify). When a facade lands, add its surface there in the same commit. The page is
nav-linked in `mintlify-docs/docs.json`; keep the public surface and its preview status
current as the engine evolves.

## Verification per commit
`npx tsc --noEmit -p .` (resolves `@mentra/engine`→src, validates the real code) +
`bun run test`. The island standalone build can't run locally (cloud-v2 `zod` not
installed in this checkout) — CI confirms it; use the proven relative-`_internal`
pattern for btsdk types.

## Domains
| Domain | Backing logic lives | Pattern | Status |
|---|---|---|---|
| glasses.wifi | btsdk passthrough + glasses store | 1 | DONE (#3167) |
| display.mirror | island display store | 1 | DONE (#3167) |
| glasses (core) | glasses store + btsdk + ConnectionCoordinator | 1 | in progress |
| speech | STT/TTSModelManager (already island) | 1 | DONE (#3167) |
| ~~logs~~ | MentraJSLogPipeline (already island) | — | **NOT a facade** — island's pipeline is internal *miniapp*-log plumbing for MentraJSRouter; the app UI never reads it. The logging the UI uses (bug-report "send logs") is the HOST-side `logBuffer` (`mobile/src/utils/dev/logging.ts`) + `RestComms.uploadIncidentLogs` → belongs to the `incidents` domain, not a `logs` facade. Skip. |
| permissions | `utils/PermissionsUtils.tsx` (host) | 1 | todo |
| incidents | `services/bugReport/*` (host) | 1 | todo |
| dev | `utils/cloudClient/devHost.ts` + core store | 1 | todo |
| miniapps | apps store + LocalMiniappRuntime (island) + MiniappCatalog | 1/hard (WebView) | todo |
| pairing | pairing screens state machine (readiness primitive already island) | 1 (extract) | todo |
| **settings** | `stores/settings.ts` (964 LOC) + `RestComms` + `storage` | keystone | **DONE (#3167)** — settings store moved into island, `engine.stores.settings`. Moved **together with RestComms** (mutually coupled: settings→RestComms cloud-sync, RestComms→settings backend URL). Storage uses island's MMKV (ported `loadSubKeys`). Unblocks glasses.settings + phoneNotifications. The typed `engine.settings` keyed facade (get/set/onChanged) is still TODO on top of the moved store. |
| **RestComms** (v1 REST) | `services/RestComms.ts` (731 LOC) | move-with-settings | **DONE (#3167)** — moved into island with settings (the coupled pair). v1-transitional: deleted in place when v1 retires. Reads backend URL from the now-island settings store directly (no early-auth timing hack). Host `@/services/RestComms` is a shim. GlobalEventEmitter also moved in (one shared instance). |
| glasses.settings | settings store + btsdk | 2 (after settings) | blocked on settings |
| phoneNotifications | settings store + crust + permissions | 2 (after settings) | blocked on settings |
| gallery | `services/asg/gallerySyncService.ts` (~1000 LOC, hotspot) | hard | todo |
| notifications | scattered detectors → new event bus | hard (new) | todo |
| session | `cloud-client` (cloud-v2) | keystone | **DONE (#3167)** — `CloudClientService` owns the CloudClient in island (built from island UDP + MMKV secure store + `getAuth()` + endpoints via `getConfigValues()`); self-wires the `cloud`/`cloudConnection` runtime hooks; `engine.session` exposes status. Account ops (delete/export) deferred (still host RestComms). Host `@/services/cloudClient` is a thin wrapper keeping dev/settings endpoint resolution. |
| cloudClientStatus (store) | cloud-client types | — | **DONE (#3167)** — moved into island, `engine.stores.cloudClientStatus`. |
| cloud secure store (MMKV) | cloud-client KeyValueStore | — | **DONE (#3167)** — moved into island (react-native-mmkv already an island dep; adapter-free). |

## Sequence
**Cheap (logic already in island) — DONE this PR:** glasses-core, glasses.wifi,
speech, display.mirror + 5 device-store moves. `logs` was investigated and is NOT a
facade (see table). So the cheap tier is exhausted; everything below is a
host-service move needing the `configureRuntime` adapter seam.

**Decision point (host-coupled tier):** these move 1000+ LOC host services into
island behind adapters. The mobile engineer already pushed back on moving too much
in (routing/UI) — so align on the adapter contract BEFORE moving permissions/
settings/bugReport, rather than doing it blind. Recommended order once greenlit:
permissions → incidents → dev → **settings keystone** (own commit; unblocks
glasses.settings + phoneNotifications) → pairing → gallery → miniapps WebView →
notifications. Last: `git merge dev`, then session + cloudClientStatus.

This PR (#3167) is a clean, landable foundation at the cheap-tier boundary: the
core `engine.*` facade surface + store escape hatches, green. Land it, then
sequence the host-coupled tier deliberately.
