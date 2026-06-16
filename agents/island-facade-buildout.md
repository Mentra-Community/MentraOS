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
| speech | STT/TTSModelManager (already island) | 1 | todo |
| logs | MentraJSLogPipeline (already island) | 1 | todo |
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
Buildable/island-resident first (green every commit): glasses-core → speech → logs
→ permissions → incidents → dev. Then the **settings keystone** (own commit). Then
glasses.settings + phoneNotifications. Then pairing, gallery, miniapps WebView,
notifications. Last: `git merge dev`, then session + cloudClientStatus.
