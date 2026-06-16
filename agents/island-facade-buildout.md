# Island facade buildout — tracking spec

Goal: build the OEM-facing `toolkit.*` typed facades by moving the backing logic
into `@mentra/island`, domain by domain, on branch `aisraelov/island-namespace-wifi`
(PR #3167). One branch, one commit per domain, green at every commit.

## Two move-patterns
1. **Self-contained logic** — move the file into island, fix relative imports
   (btsdk types via `../../../bluetooth-sdk/build/_internal`), wrap in a facade.
   Shim the old host path if the app still imports it. (Stores, speech, logs,
   permissions, incidents.)
2. **Host-service-coupled** — move the logic in, but inject an adapter for the host
   dependency via `configureRuntime` (the existing seam). Settings → `RestComms` +
   `storage`; session → `cloud-client`.

Rule: stores are the Mentra-app escape hatch (`toolkit.stores.*`), NOT the OEM
contract. OEMs use the typed facade functions.

## cloud-v2 mobile-CI integration (was fully broken on dev)
The cloud-v2 merge left the mobile CI red on dev (install died on a 404, so the
typecheck never even ran). Three fixes, all on this branch (they un-red dev too):
1. **Spurious dep** — `mobile/modules/island/package.json` declared
   `"@mentra/cloud-client": "*"`; cloud-client is resolved via metro+tsconfig path
   aliases, not npm, so the `*` 404'd. Removed it.
2. **island standalone build** — `postinstall` builds island via `expo-module`
   (`build:module`), whose isolated tsconfig lacks the cloud-v2 aliases → fails on
   cloud-v2 imports. But island's `build/` is unused (metro + tsconfig resolve
   `@mentra/island` → src). Made it non-fatal in `mobile/scripts/postinstall.mjs`.
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

## Verification per commit
`npx tsc --noEmit -p .` (resolves `@mentra/island`→src, validates the real code) +
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
| **settings** | `stores/settings.ts` (964 LOC) + `RestComms` + `storage` | **2 (keystone)** | todo — own careful commit; unblocks settings + glasses.settings + phoneNotifications |
| glasses.settings | settings store + btsdk | 2 (after settings) | blocked on settings |
| phoneNotifications | settings store + crust + permissions | 2 (after settings) | blocked on settings |
| gallery | `services/asg/gallerySyncService.ts` (~1000 LOC, hotspot) | hard | todo |
| notifications | scattered detectors → new event bus | hard (new) | todo |
| session | `cloud-client` (cloud-v2) | 2 | needs `git merge dev` (cloud-v2) first |
| cloudClientStatus (store) | cloud-client types | — | rides with session |

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
core `toolkit.*` facade surface + store escape hatches, green. Land it, then
sequence the host-coupled tier deliberately.
