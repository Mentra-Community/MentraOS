# Integration Review — Toolkit Boundary PR (#3331)

Date: 2026-07-02
Scope: `integration/toolkit-boundary` vs `dev` (278 files, +14.5k/−10.9k), reviewed
against [README.md](./README.md), [implementation-plan.md](./implementation-plan.md),
and the overall product intent: **host = OEM-brandable views; toolkit = MentraOS
runtime**. Constraint for all follow-up work: **behavior unchanged**.

## Verdict

The boundary the plan targeted — glasses/gallery runtime state — is genuinely
delivered: the raw glasses store is unreachable from host code, the guardrail
passes with an **empty allowlist**, the Cloud V1 device-state mirror is deleted,
island has no upward imports, and 13 of 14 host surfaces (pairing, wifi, gallery,
status UI, devtools) render typed read models. The two things standing between
this PR and the stated end-state are:

1. **OTA install orchestration still lives in host views** (WP 8B–8D never
   landed). `progress.tsx` + `progress-legacy.tsx` are ~2,600 lines of
   watchdogs, retries, and BLE sequencing dressed as screens, and the
   `toolkit.ota` facade had to expose five internal plumbing methods to feed
   them.
2. **The escape hatches beyond glasses/gallery remain wide open**
   (`toolkit.stores.*`, flat store/service exports, `@/stores/*` shims). They
   were out of scope for plan 020, but they are exactly the surface an OEM
   would misuse tomorrow.

Both are fixable with behavior-preserving refactors. A phased program is at the
end of this doc.

## Scorecard vs implementation plan

| WP | Goal | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Devtools boundary | **Mostly done** | CoreStatusBar renders `toolkit.dev.runtimeStatus()`; stress-test/super still call `bluetooth-sdk-internal` debug hooks host-side; no `@mentra/island/devtools` export exists; dead debug links remain |
| 2 | Guardrail | **Done (narrow)** | `check-mobile-runtime-boundary.sh` passes, allowlist empty — but it only patterns glasses/gallery stores |
| 3 | Facade deltas | **Done** | glasses/controller/pairing/ota/gallery/dev facades + `useToolkitSnapshot` |
| 4 | Product UI conversion | **Done** | home/settings/status components read facades |
| 5 | BT-SDK types subpath | **Done** | `@mentra/bluetooth-sdk/types` exists; `GlassesReadiness` + test mock consume it |
| 6 | Pairing/reconnect | **Done** | screens/effects use `toolkit.pairing`; `decideReconnect` in island |
| 7 | Network/gallery plumbing | **Done** | `NetworkMonitoring.tsx` deleted; `DeviceEventRouter` owns hotspot→asgCameraApi |
| 8A | OTA check orchestration | **Done** | `toolkit.ota.checkForUpdates()` owns waits/manifest/clock/mtk-filter |
| 8B | OTA install state machine | **NOT DONE** | full watchdog/retry/reconnect machine in `progress.tsx` (see A below) |
| 8C | Old-build compat in unified model | **NOT DONE** | legacy mapping exists in island, but the behaviors live in a second host screen |
| 8D | Delete legacy route | **NOT DONE** | `progress-legacy.tsx` (~2,000 lines) + `MINIMUM_OTA_STATUS_BUILD` branch alive |
| 9 | Cloud V1 remnant audit doc | **NOT DONE** (audit now exists — see E) | `cloud-v1-remnant-audit.md` was never committed |
| 10 | Delete device-state sync | **Done** | no `/api/client/device/state`, no `updateGlassesState`, battery forwarding gone |
| 11 | Escape hatches | **Done for glasses/gallery only** | `@/stores/glasses` + `gallerySync` deleted; other stores still shimmed + `toolkit.stores.*` exists |

## What is solid (keep, don't churn)

- Facade style: small projections + `onX` subscriptions deduped on projected
  JSON. Consistently applied; `useToolkitSnapshot` keeps view glue uniform.
- Guardrail discipline: empty allowlist means no production host file touches
  glasses/gallery raw state. Rare for a migration this size.
- `DeviceEventRouter` as the single inbound device-event plane, and the island
  self-wiring (`configureRuntime` collapsed to just `wifiSetup`, which is a
  legitimate host navigation adapter).
- Layering: zero island→host imports.
- Reports: host submits user text; island collects diagnostics — matches the
  019 design exactly.

## Findings

### A. OTA install state machine in host views (largest gap; WP 8B–8D)

`mobile/src/app/ota/progress.tsx` (~660 lines) is an orchestrator, not a view.
It owns: global 20-min timeout, no-ack retry (3× / 5s), stuck-at-zero (70s),
progress-stall (120s / MTK 300s) keyed on a progress signature, reconnect-edge
detection (initial mount vs reconnect vs post-APK reboot), `ota_query_status`
fallback with 6s reply watchdog, post-APK 6s settle delay, 10s ping keepalive,
`ota_start_ack` / `mtk_update_complete` GlobalEventEmitter listeners, and
terminal cleanup. `progress-legacy.tsx` (~2,000 lines) re-implements the same
suite plus MTK simulated progress and BES restart lockout for builds < 37.

Consequences visible elsewhere:

- `toolkit.ota` grew host-facing plumbing to serve these screens:
  `queryStatus()`, `ping()`, `markMtkUpdatedThisSession()`,
  `clearBuildNumberForNextCheck()`, `replacePendingUpdateSequence()`, and
  `legacyProgress` inside the public snapshot ([ota.ts:33,59,61,77,90,95](../../../../mobile/modules/island/src/facades/ota.ts)).
  An OEM could call any of these out of order.
- Host OTA UI types come from the SDK's internal surface
  (`OtaProgress`/`OtaStatus` from `@mentra/bluetooth-sdk-internal` in
  `progress.tsx`, `deriveOtaDisplayState.ts`, `otaErrorMapping.ts`,
  `OtaProgressSection.tsx`) instead of from `toolkit.ota`.
- Timer policy lives in host (`otaProgressTimeouts.ts`).
- `progress-legacy.tsx` imports flat island OTA utilities (`checkBesUpdate`,
  `findMatchingMtkPatch`, `fetchVersionInfo`).

**Recommendation (the one big refactor worth doing):** finish WP 8B→8D as
specified. Build an island `OtaInstallCoordinator` state machine that owns every
timer/retry/sequencing rule above (durations moved verbatim so behavior is
identical), expose `snapshot()` with a `displayState`-grade projection plus
`install()/retry()/acknowledgeContinue()` commands, rewrite `progress.tsx` as a
pure renderer, cover the legacy behaviors with the unit tests enumerated in WP
8B/8C, then delete `progress-legacy.tsx` and the `< 37` branch. The plan's test
list is already the characterization-test spec.

### B. `toolkit.ota` public surface (do together with A)

Remove from the public facade once the state machine owns them: `queryStatus`,
`ping`, `markMtkUpdatedThisSession`, `clearBuildNumberForNextCheck`,
`replacePendingUpdateSequence`, `legacyProgress` (fold legacy progress into the
unified snapshot projection). Export OTA snapshot/status types from the facade
so host UI stops importing `bluetooth-sdk-internal` types. Also fold the
`OtaUpdateChecker.tsx` pending-update cache ("update found while user was
elsewhere → resurface on home/Wi-Fi") into the snapshot so the effect becomes a
renderer decision, and make `checkForUpdates()` internally coalesce concurrent
calls so `check-for-updates.tsx` can drop its generation-ref machinery.

### C. Facade snapshots that return live store references (small, do now)

Same bug class the bots caught on `glasses.info().wifi` (already fixed):

- `glassesWifi.status()` returns the live `wifi` object — [glassesWifi.ts:44](../../../../mobile/modules/island/src/facades/glassesWifi.ts)
- `gallery` projection returns live `queue` and `processedFiles` (note
  `processingFiles` IS copied one line above) — [gallery.ts:23,27](../../../../mobile/modules/island/src/facades/gallery.ts)
- `pairing.searchResults()` returns the live array — [pairing.ts:185](../../../../mobile/modules/island/src/facades/pairing.ts)

One-line copies each. Consider a `freezeInDev()` helper or a facade unit test
that asserts snapshot mutation never reaches the store, so the class dies.

### D. Remaining escape hatches (the next boundary campaign)

The glasses/gallery discipline does not yet extend to the rest of the runtime
state. Present today:

- `toolkit.stores.{display, core, connection, cloudClientStatus, settings}` —
  self-described "temporary host migration" hatch ([island.ts:148–154](../../../../mobile/modules/island/src/island.ts)).
- Flat index.ts exports of the same stores plus service singletons
  (`appRegistry`, `cloudClientService`, `restComms`, `gallerySyncService`,
  `asgCameraApi`, `localStorageService`, `mediaProcessingQueue`,
  `miniappRunningRegistry`, `localMiniappRuntime`, `miniappLauncher`,
  OTA check helpers, clock-fix helpers…).
- Host shim files `@/stores/{core, connection, display, settings,
  cloudClientStatus}` re-exporting island stores; ~36 host files /
  150+ accesses, heaviest: `useSettingsStore` (~38 files), `useAppStatusStore`
  (~24 files), `useCoreStore` in pairing/status UI.

Not a regression — these predate the PR and plan 020 scoped them out — but they
are the reason the host still can't be handed to an OEM. Recommended shape:

1. Split island entry points: `@mentra/island` (toolkit + types only),
   `@mentra/island/internal` (stores + service singletons, for the host's own
   runtime-adjacent services during migration), `@mentra/island/devtools`
   (stress-test store, running registry, debug BLE hooks).
2. Point the existing shims at `/internal`, freeze new uses via the guardrail,
   then burn down per store: `useCoreStore` reads → `toolkit.pairing`
   (searching/searchResults already exist); `useDisplayStore` →
   `toolkit.display.mirror`; `useCloudClientStatusStore`/`useConnectionStore` →
   `toolkit.session.status()` (+ add the couple of missing fields);
   `useAppStatusStore`/`useApps` hooks → grow `toolkit.miniapps` (it already
   has list/start/stop/foreground; add the hook layer);
   `useSettingsStore` → `toolkit.settings` (biggest, most mechanical).
3. Delete `toolkit.stores` when the burn-down completes.

### E. Cloud V1 legacy bridge (contained, but make it explicit)

The V1 stack is now cleanly host-side: `WebSocketManager` (transport) →
`SocketComms` (message bridge) → relays in `MantleManager`, plus V1 REST in
island's `RestComms`. Nothing island-side depends on V1; nothing posts device
state ✓. What it still is: the **Cloud-SDK-app bridge** (display_event,
photo_request, start/stop_stream, video recording, RGB LED, camera FOV,
settings/calendar/notification endpoints, webview auth, LiveKit token).

Actions, all behavior-safe:

- Commit the WP 9 audit as `cloud-v1-remnant-audit.md` (the audit content now
  exists from this review; the table of ~40 call paths with dispositions).
- Delete the proven-dead paths now: `handle_app_state_change`,
  `handle_app_started`, `handle_app_stopped` (log-and-ignore no-ops),
  `sendLocalTranscription` (deprecated no-op), and — after one grep each —
  `sendVideoStreamResponse`, `sendMessage` (no call sites),
  `RestComms.sendLocationData` (only caller is commented out).
- Rename/annotate the remainder as an explicit `legacy cloud-sdk bridge`
  (folder or file-header contract) so no new feature grows roots in it.

### F. Consistency and hygiene (cheap, high polish value)

- **Facade import idiom:** `ota.ts` uses `@mentra/bluetooth-sdk/internal`;
  `glasses.ts`, `speech.ts`, `dev.ts`, `reports.ts` use the relative
  `../../../bluetooth-sdk/build/_internal` path. Standardize on the package
  subpath (this was an explicit babysitting decision).
- **Guardrail growth:** extend `check-mobile-runtime-boundary.sh` with
  (report-only at first): the remaining store hooks, `@mentra/island/internal`
  (once split), `bluetooth-sdk-internal` in `mobile/src` outside an allowlisted
  devtools set, and the flat OTA helpers.
- **Dead debug routes:** `/test/switcher`, `/miniapps/settings/buffer-debug`
  links in `debug.tsx`; `super.tsx` links `miniapp-developer` while the file is
  `miniapp-dev.tsx`.
- **Naming:** `status()` vs `snapshot()` vs `readiness()` across facades is
  livable; if touched, converge on `snapshot()`/`onSnapshot()` for compound
  projections and keep `status()` for single-domain state. Don't rename for
  its own sake.
- **Tree-shaking:** importing `toolkit` eagerly constructs every facade. Fine
  for the in-repo host; revisit only when the OEM SDK packaging story starts.
- Dropped test coverage: `PhonePhotoCoordinator.test.ts` died with the move
  into island (mobile jest ignores `src/services/photo/`); recreate it in the
  island harness once island's own jest runner is fixed.

## Recommended sequence (all behavior-preserving)

| Phase | Work | Size | Risk containment |
| --- | --- | --- | --- |
| 1 | C (snapshot copies) + F hygiene (import idiom, dead links, guardrail report-mode extension) + E delete-nows + commit WP9 audit doc | S | tsc + jest + boundary script |
| 2 | A+B: OTA state machine into island (`OtaInstallCoordinator`), facade diet, unified snapshot types; characterization tests FIRST from the WP 8B/8C list; timers/durations copied verbatim | L | the new island tests + on-device OTA of both a ≥37 and a <37 build before deleting `progress-legacy` |
| 3 | 8D: delete `progress-legacy.tsx` + `<37` branch + flat OTA helper exports | M | grep exit-criteria from the plan |
| 4 | D: entry-point split (`/internal`, `/devtools`) + shims repointed + guardrail patterns armed | M | no runtime change at all — pure module topology |
| 5 | D burn-down per store (core → pairing; display → display.mirror; session; miniapps hooks; settings last) | L (mechanical) | per-store PRs, boundary script ratchets |

Phase 2 is the one that needs real care: OTA is device-flashing. The plan's own
rule applies — move behavior, never change it; every timer, fallback and
sequencing rule is copied with its current values, and the legacy screen is
deleted only after the unified path demonstrably reproduces old-build behavior
on hardware.
