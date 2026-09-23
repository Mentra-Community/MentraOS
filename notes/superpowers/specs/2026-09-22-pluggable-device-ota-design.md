---
status: active
owner: Mentra
---

# Device-owned OTA for NIMO, AR99, and Mentra Live

Approved for implementation on 2026-09-22. Execution and validation are tracked in [the implementation plan](../plans/2026-09-22-pluggable-device-ota.md).

## ELI5 / quick version

**Give every kind of glasses its own updater. Give the Mentra App one place to find the right updater.**

- **All three devices become real providers in one OTA system.** There is no permanent special route around the provider interface.
- **Live keeps its proven update rules.** Move its orchestration out of React and into its provider, preserving timings, retries, manifests, Wi-Fi/hotspot behavior, and the normal user experience.
- **NIMO gets a native updater on iOS and Android.** Pair → check firmware → ask to update → update both sides → reconnect and verify → continue setup.
- **AR99 also moves behind the same interface in this project.** Preserve its native resume behavior and stop screen changes from accidentally restarting it.
- **The SGC owns talking to the glasses.** Small device-specific files own release selection and update policy. Shared code owns finding the right implementation and showing its state.
- **“Supports OTA” must stop meaning “open the Live updater.”** Pairing, settings, background checks, and Wi-Fi return navigation all need correct device routing.
- **Approval is for this architecture and staged implementation.** It does not approve a production firmware release or claim that mobile OTA is already tested. This change contains only this design document.

**My assessment: finish the abstraction now, using small, tested migration steps. Share the provider/session contract and UI; retain each device's proven protocol and recovery rules inside its provider. Live's lifecycle extraction is real work and must be tested accordingly.**

## 1. Decision and scope

Adopt a device integration boundary with an optional firmware-update capability. Bundled integrations are registered statically. Engine's new shared OTA service depends on contracts and receives integrations from that registration point. Future packages can supply implementations at the same boundary; dynamic native loading, an external plugin API, and a full SGC factory rewrite are out of scope.

Completion requires Live, AR99, and NIMO to implement the same headless provider/session contract. Device selection, checks, starts, observation, retry, completion, and normal app screens all use that contract. Live's current hook orchestration moves into its provider; AR99's modal orchestration moves into its provider. Native protocol implementations and established update policies are reused.

Migration may use short-lived internal adapters between commits, but the target design has no `existing-flow` binding, `flowId` escape hatch, hidden legacy React controller, or unbounded follow-up to finish Live. Hardware validation can gate enablement of an individual provider; an unfinished migration is not described as a completed architecture.

The reviewed code imposes four requirements on that unified design:

| Earlier simplification | Required correction |
| --- | --- |
| The provider is just a wrapper around a React flow | Extract Live's check/approval/continuation state into a headless provider and give it explicit session lifecycle commands. A wrapper that still needs a hidden hook is not sufficient. |
| A generic retry calls the device's start method | AR99's start wrapper cancels an existing transfer. Retry/reconcile/restart are separate provider decisions. |
| All native “success” events mean the target firmware is running | AR99 currently reports validated-image success, and its UI substitutes the intended version. Verify activation behavior on hardware before changing that interpretation. |
| Reuse the existing generic-looking OTA downloader/checker | Those modules understand APK/MTK/BES manifests and ASG build numbers. NIMO must not be forced through their schemas. |

No implementation should silently redefine existing public `engine.ota`, `useMentraLiveOta`, `MentraLiveOtaFlow`, or Bluetooth SDK OTA APIs to mean a different protocol.

## 2. Evidence and confidence

Source baseline: `9762584dcaa399628e967e30672a41c03f5bd3e5`, reviewed 2026-09-22. This is the current workspace baseline; implementation must recheck any subsequent changes on `dev`.

The review traced both native platforms' AR99 managers and SGC wrappers, Live's check/coordinator/hook/auto-chain/manifest path, SDK release configuration, and the app's routing and connection overlay. Relevant source links are collected in section 12.

Baseline tests run during this review:

| Check | Result |
| --- | --- |
| Six mobile Jest suites: install coordinator, update checks, auto-chain, background checker, pairing success, shared Live flow | **183 passed** |
| Engine `useMentraLiveOta` suite, isolated Bun process | **16 passed** |
| Engine manifest policy suite, isolated Bun process | **5 passed** |
| Public OTA dependency/controller boundary checks | **2 passed** |
| Mobile clock-recovery and OTA event-projection suites | **11 passed** |
| Engine artifact staging and hotspot shutdown suites, isolated Bun processes | **18 passed** |
| Bluetooth SDK public OTA API checks | **2 passed** |
| Public OTA TypeScript consumer fixture | **Passed** |
| Total | **237 tests passed; consumer typecheck passed** |

These are existing-behavior baselines, not tests of the proposed implementation. No mobile builds, Live/AR99 hardware flashes, or new end-to-end runs were performed for this document. No dedicated AR99 OTA test suite was found in the inspected mobile/native test paths; its advertisement tests do not cover updating.

Coverage is uneven: coordinator tests exercise many recovery cases, but `OtaUpdateChecker.test.ts` tests helper/policy functions rather than mounting the background component and exercising its polling, async cancellation, and prompt lifetime. Passing that suite does not establish parity for moving those effects.

Recent history also matters. `f81dc583fd` fixed interrupted-download recovery; `c95248a974` prevented terminal APK failure events from repeatedly rearming the downgrade detour; `80965f43b7` kept legacy rescue inside final release verification; `d7170e29c7` corrected completion after filtering pending MTK updates. These are behavior to preserve, not obsolete complexity to simplify away. The latter fix landed on September 21, immediately before this review.

Earlier in this session, one actual NIMO successfully updated from `0.1.0.14` to `0.1.1.1` using a macOS bench implementation of the supplied vendor protocol:

- Image: `ota-0.1.1.1-20260827164351-537cf1-dirty-dynamic-v1.bin`, 1,857,523 bytes.
- SHA-256: `5e23c574e3dfd8c27172f4f9a33475e6efd0d33e7230bfcce8f4fe8ca59fe433`.
- Device accepted preflight with dual-backup result `3`; both batteries were full.
- Transfer completed in 454 requested blocks, approximately 5½ minutes. Device image validation succeeded.
- Synchronization reported pending once, then complete; reboot was sent only afterward.
- Reconnected and read `FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug` twice.
- Both sides' OTA version fields changed from `000e` to `0001`; the main packed version changed from `0e002000` to `01102000`.

This proves one old-to-new update on one device. It does not prove phone background execution, interruption recovery, every hardware revision, or production suitability of this vendor `dirty`/`Debug` build. Detailed local bench evidence is retained in `.context/nimo-ota-bench/`; the facts above make this spec independent of that gitignored directory.

## 3. Current behavior that constrains the design

### Mentra Live

1. `OtaUpdateCheckService` is ASG-specific. It uses an ASG build number/package, BES/MTK versions, exact APK pins, a downgrade floor, and legacy rescue behavior. It is unsuitable as NIMO's version checker.
2. `useMentraLiveOta` owns check state, approval, multi-pass advancement, Wi-Fi intervention, and completion. It attaches `OtaInstallCoordinator` on entering progress and detaches it on leaving.
3. Coordinator `attach()` can send `ota_start` or query an existing session. `detach()` clears timers/listeners and resets local state, while preserving pending native start ownership. An extra mount/unmount is an execution change.
4. A timeout or missing ACK does not necessarily mean start failed. Existing reconciliation and single-flight ownership prevent duplicate installs. Retry during the APK downgrade recovery detour must not start another transaction.
5. A glasses process SID change can occur without Bluetooth disconnecting. `glasses_session_changed` is necessary for recovery.
6. Pre-37 status/progress handling and pre-39 manifest behavior differ. BES reboot handling, MTK progress/updated-session logic, and the legacy rescue handoff are intentional compatibility behavior.
7. A completed install pass is not final success. The approved auto-chain checks again until no further update is available, with duplicate/downgrade/max-pass guards.
8. `finish()` waits for hotspot teardown before the next Internet-dependent check. Subscription cleanup is not equivalent to finishing the update.
9. SDK/Engine release pins, host deployment configuration, explicit disable values, and Super Mode overrides have existing precedence. Preserve it exactly for Live.
10. `OtaService` is not just passive event projection: a failed clock-skew/eligible SSL event calls `glassesClockSync`, which fixes the clock and directly starts OTA. This recovery operates without a mounted flow and must be included in command ownership.

**Preservation rule:** preserve Live's protocol, policy, command ordering, recovery decisions, and user-visible flow. Its current file layout and React ownership are allowed to change. Reuse the checker, coordinator algorithms, event projection, manifests, and downloader; move lifecycle ownership into one headless Live provider. Section 8 specifies the extraction and parity tests.

### AR99

1. Release lookup/download live in `mobile/src/services/ar99Ota.ts`; workflow state and event subscription live inside `Ar99OtaModal`.
2. Vendor lookup depends on firmware version, serial number, project name, signing inputs, and environment. It treats vendor code `553` as no update, compares version strings by inequality, honors `force_update`, resolves vendor URLs, and verifies MD5 when supplied. These semantics must not change during structural extraction.
3. Vendor network access is disabled for organization workspaces. Moving code to Engine must retain that policy through an injected host policy/source, without importing app deployment stores.
4. Native managers on both platforms retain firmware in memory and allow a 90-second reconnect window. Reconnection re-enables notifications and negotiates again; the device requests offsets. This is not a host-guessed resume offset.
5. Both SGC `startOtaFromFile` wrappers detach callbacks and cancel an active/paused session before a fresh start. A screen remount or generic retry must not invoke them automatically.
6. Native OTA events contain progress and phase but no device ID or session ID. Singleton manager callbacks and late asynchronous work need explicit ownership before a new provider can safely adopt them. The manager initially remains in `IDLE` while notification setup/negotiation is pending, so `isOTAInProgress()` alone cannot serialize the entire start operation.
7. Settings conditionally renders the modal only while AR99 is connected, and clears visibility when that condition disappears. The native transfer can remain paused/resumable while its UI and subscription disappear. On re-entry, the current modal checks afresh rather than adopting a native snapshot.
8. Native success follows image validation and invokes `onCompleted(false)`. The wrapper discards the reboot flag; the modal sets the displayed current version to the offered target. The actual activation/reboot contract has not been established in this review.

**Preservation rule:** migrate AR99 to the common provider contract within this project while retaining its vendor lookup and native protocol/reconnect behavior. Characterize activation before implementing verified completion. Do not copy NIMO's reboot command/sequence into AR99.

### Routing and shared state

`hasOta` is a capability summary, not an implementation selector. Today pairing uses it to select Live setup, with an explicit AR99 exclusion. NIMO currently reports `hasOta: false`.

The same assumption exists beyond pairing: `OtaUpdateChecker`, `/ota/check-for-updates`, `/ota/progress`, Wi-Fi success navigation, debug entry points, and settings progress presentation. `MentraLiveOtaFlowHost` also explicitly continues through Live onboarding and supplies Live-specific reconnect copy.

New NIMO/AR99 events must not be projected into the existing Live `ota_status`/`otaProgress` stores. They can otherwise trigger Live-specific watchers or stale progress displays even when the wrong screen is not mounted.

## 4. Ownership and file layout

Paths below are proposed additions unless marked existing. This is an implementation boundary, not a requirement to move all existing device files in one PR.

```text
mobile/modules/engine/src/
  devices/
    types.ts                         # Integration definition and registration types
    builtins.ts                      # Only composition point importing bundled integrations
    nimo/
      definition.ts                  # Identity, capability reference, update entry points
      ota.ts                         # Release/compatibility policy and native-session adapter
      firmwareVersion.ts             # Full NIMO firmware identity parsing/comparison
    ar99/
      definition.ts
      ota.ts                         # Managed provider, enabled after AR99 migration gates
      releaseSource.ts               # Existing vendor request/response semantics
    mentra-live/
      definition.ts
      ota.ts                         # Live provider implementing the common contract
      session.ts                     # Check/approval/auto-chain state extracted from React
      availability.ts                # Existing background polling/check/prompt eligibility
      presentation.ts                # Live state/error/action projection, no React effects
  ota/
    types.ts                         # Managed provider/session contracts
    UpdateService.ts                  # Provider resolution, offer/session ownership, observation
    FirmwareArtifacts.ts             # Managed-provider staging; no ASG manifest interpretation
  react/
    useFirmwareUpdate.ts             # Observes managed sessions and invokes permitted actions
    FirmwareUpdateFlow.tsx           # Reusable managed-flow presentation
    useMentraLiveOta.ts               # Public compatibility wrapper over the Live provider
    MentraLiveOtaFlow.tsx             # Public presentation wrapper; no separate controller

mobile/modules/bluetooth-sdk/
  src/firmware-updates/               # Additive public bridge/API and status types
  ios/Source/sgcs/
    firmware/FirmwareUpdater.swift    # Optional native updater contract
    nimo/ota/NimoOtaManager.swift
    nimo/ota/NimoOtaProtocol.swift
    ar99/ota/Ar99OtaManager.swift      # Existing protocol manager retained
  android/src/main/java/com/mentra/bluetoothsdk/sgcs/
    firmware/FirmwareUpdater.kt
    nimo/ota/NimoOtaManager.kt
    nimo/ota/NimoOtaProtocol.kt
    ar99/ota/Ar99OtaManager.java       # Existing protocol manager retained

mobile/src/components/ota/
  DeviceOtaFlowHost.tsx               # Shared provider UI plus app navigation/theme
  MentraLiveOtaFlowHost.tsx            # Forwarding host wrapper if existing imports need it
```

### Native SGC and updater

An SGC exposes an optional updater object; absence means unsupported. Do not add no-op per-model update methods to every SGC. The object owns device preflight, protocol framing, write scheduling, transfer state, device-specific reconnect/reboot/synchronization, and raw firmware inventory. Its commands can carry a device-specific prepared request: Live starts a manifest-driven glasses transaction, while NIMO/AR99 use staged files. The common Engine contract must not require every native updater to accept a firmware file.

Use the SGC's established connection and write infrastructure. NIMO does not create a second Bluetooth client alongside its SGC. Phone-driven NIMO/AR99 transfer work must not depend on React renders or JS timers continuing to fire. Live's existing glasses-side execution remains unchanged; its phone-side orchestration moves from the hook to the Engine provider, using the established runtime facilities.

The SDK retains active native update ownership across transient link loss and guards device replacement/cleanup during unsafe phases. Each provider decides recovery and terminal cleanup. Live keeps glasses-side installation and its existing native commands; its new adapter must not turn it into a phone-to-glasses file-transfer protocol.

Native Swift/Kotlin clients can use the updater contract without importing Engine. The React Native bridge exposes that same primitive through supported public SDK exports; Engine providers must not import SDK internals. Existing Live and AR99 public APIs remain available; managed and legacy AR99 entry points must arbitrate against the same underlying native owner when AR99 is migrated.

### Device provider in Engine

The provider selects compatible releases, parses versions, interprets native status, and decides which user actions are allowed. It receives narrow dependencies: a device-bound native client, an allowed firmware source, artifact staging, and logging. App navigation, app settings stores, and the entire Engine singleton are not dependencies.

Device firmware descriptors/release pins ship with Bluetooth SDK configuration. Engine adapters consume them; firmware URLs do not live in React screens. `definition.ts` can reference existing capability profiles initially, avoiding a wholesale capabilities migration.

### Shared Engine service and app

The new additive Engine facade is `engine.firmwareUpdates`. Existing `engine.ota`, `useMentraLiveOta`, and `MentraLiveOtaFlow` use the same Live provider and its underlying checker/coordinator; they must not create another controller. The low-level compatibility commands retain their Live-specific meaning as detailed in section 8. Exact new exported names can be settled during implementation without changing these responsibilities.

The shared service resolves the integration, serializes checks/starts for its target, exposes snapshots, and reconnects UI observers to existing managed sessions. It does not invent transfer retries, battery thresholds, reboot rules, or a universal completion timeout.

The app owns routes, localization, theme, and onboarding continuation. Providers return semantic requirements and actions, not Expo Router paths. Display and progress components can be reused, but protocol-specific state machines remain device-owned.

## 5. Registration and session contracts

### Static composition with a future extension boundary

Registration uses stable string integration IDs and native identity data. Avoid requiring every future integration to extend a central `DeviceTypes` union. Existing built-in aliases may be normalized at registration/lookup, but Bluetooth display-name substring matching must not authorize a firmware write.

A conceptual registration is:

```ts
interface DeviceIntegration {
  id: string
  // Existing capability profiles and model identity are referenced here.
  firmware?: {
    entryPoints: readonly ("pairing" | "settings" | "background")[]
    createProvider: FirmwareProviderFactory
  }
}
```

This is a boundary sketch, not a finalized published plugin ABI. `builtins.ts` supplies definitions to the resolver; generic service modules do not import individual device implementations. Every factory creates a headless provider. Presentation consumes its snapshot and actions without selecting an alternative legacy flow.

Required providers at completion:

| Integration | Provider implementation | Entry policy |
| --- | --- | --- |
| Mentra Live | Extracted headless Live session + existing checker/coordinator/native commands | Preserve current pairing, settings/debug, background-check and Wi-Fi return behavior |
| NIMO | Managed native updater | Pairing + settings; deduplicated connected-device checks after validation |
| AR99 | Extracted vendor workflow + existing native managers with explicit ownership | Settings-only initially; adding mandatory pairing checks is a separate product behavior change |
| Unsupported/unimplemented | No provider | Never fall back to Live because `hasOta` is true |

The common contract describes update behavior, not a universal firmware algorithm. Live may have APK/MTK/BES passes, NIMO may synchronize two sides, and AR99 may resume device-requested offsets. Those differences are provider implementations, not alternate entry paths around the service.

Native `DeviceManager` construction switches remain in place for this project. They gain optional-updater delegation, not a dynamic SGC loader. Future compiled device packages can supply native factories and Engine definitions at the composition boundary.

### Managed provider and session behavior

The contract needs these operations and results, without requiring identical firmware protocols:

| Operation/state | Required meaning |
| --- | --- |
| Enter flow | Explicitly open/adopt a check or recovery flow for a device and entry context. Initializing or subscribing alone never authorizes a flash. |
| Check | Read current device identity/firmware and resolve an offer; never enter upgrade mode or transfer firmware |
| Offer | Bound to device identity, connection/check generation, release/manifest fingerprint, available artifact integrity metadata, compatibility policy, and required/optional status. Preserve legacy Live manifest support; NIMO always requires its pinned hashes. |
| Start approved offer | Revalidate identity, offer, source policy and prerequisites; serialize the operation; return/adopt one provider session backed by the appropriate native/glasses execution |
| Snapshot/subscribe | Observe state without starting, restarting, cancelling, or resetting it |
| Reconcile | Query/adopt the existing native session after reconnect or observer remount |
| Retry | Provider-selected recovery action; never a generic alias for start |
| Cancel | Available only when native/provider state explicitly permits it |
| Finish/acknowledge | Acknowledge a provider-authoritative result and continue the host flow; safe resource cleanup is provider-owned and must not require this button press. Legacy Live pass-level `finish()` remains an internal/compatibility operation. |

Managed snapshots include integration ID, opaque device ID, session ID, phase, phase-specific progress, observed/target version, structured error, requirements, and allowed actions. Required phases include preparing/downloading/transferring/synchronizing/restarting/verifying/complete/failed/interrupted where supported. Phase progress may be indeterminate; the UI must not invent a whole-update percentage from file bytes.

Keep three identities distinct: the user-approved flow, an individual install pass/attempt, and the native/glasses transaction. A Live flow can span multiple passes and SIDs; retry can reconcile the same native transaction or deliberately create a new attempt. Neither a reconnect nor a changed SID creates a new user approval. Check outcomes also distinguish a completed no-update result from unavailable information, unsupported updater, disabled source and incompatible/unknown firmware. The common UI cannot collapse these into “up to date”; Live's existing dev-build/unofficial-client exit behavior remains its explicit policy.

Live's existing coordinator can prove completion without a modern terminal status (authorized BES reboot, legacy APK build increase, or exact downgrade target convergence). Reconcile that verified result into the native recovery record before releasing the flow or chaining another pass. Completion evidence includes native device, updater, session, connection generation and revision; native rejects stale evidence and pending commands and persists the terminal record before releasing ownership. Bind the native transaction when observing/admitting the attempt, never by adopting whichever transaction is current at completion. This does not duplicate Live's completion algorithms in the transport or treat a generic reconnect/step-complete event as success. File-based updaters reject host completion evidence and keep their own native readback requirements.

Subscription must provide an initial snapshot and ordered revisions without losing a transition between snapshot lookup and listener registration. Use a native/session revision or equivalent atomic subscribe-and-snapshot mechanism. Retain terminal results for reattachment, and ignore older revisions. Test completion before Start returns, a lost bridge response with native work already active, and reattachment during the final event. Retrying an uncertain Start first adopts/reconciles the native operation rather than issuing a new transfer.

Device ID stays stable across reconnect; connection generation changes with each connection. Events must match the active device/session and a provider-admitted connection generation. An old callback cannot advance a new update. Expected Live SID changes, pending-command outcomes and reconnect adoption remain governed by its existing reconciliation rules; a generic equality check must not discard valid recovery evidence. Add context at the native transport/operation boundary where its origin is known, not by labeling a late event with whichever device is currently selected. Revalidate identity after asynchronous lookup/download and before the first destructive command.

For managed updates, duplicate Start for the same approved offer adopts the active session; a different offer/device gets a busy/conflict result. For phone-driven NIMO/AR99, a JS-side lock alone is insufficient: acquire native ownership before notification setup and keep it through preparing/transfer/verification, including periods when the existing manager still reports idle. Enforce it before native legacy wrappers can cancel or replace work. Live retains its existing native pending-command guard and authoritative glasses session protocol; Engine admission surrounds its existing coordinator rather than replacing its ACK/query arbitration.

### Lifetimes and recovery

- One active glasses update is admitted through the app at a time. Route/device switching cannot silently abandon it. Preserve the current single-active-glasses product model.
- UI unsubscription leaves managed native work intact. Returning to the screen reads the current snapshot, including a retained terminal result.
- Distinguish unexpected link loss from expected reboot. Reconnection is directed to the same device, and readiness is specific to the operation.
- Store managed session metadata and verified artifact identity before entering upgrade mode. It is evidence for recovery, not proof that the transfer can resume.
- JS reload with native work alive: adopt its snapshot. Process death: inspect the device and journal; do not resume from a guessed offset or automatically reflash.
- NIMO interrupted-transfer recovery is not established by the bench success. If no documented safe recovery is available, expose an interrupted state and explicit recovery instructions. Do not blindly send reset or exit-upgrade commands.
- Preserve AR99's documented current 90-second reconnect behavior and device-requested offsets. A cold process restart is not equivalent to that in-memory resume path.
- Carry Live's pending-start ownership, multi-pass approval, seen-offer fingerprints, and reconnect deadlines into its provider session. Its recovery still uses authoritative glasses status/SID/version checks; a generic journal must not override those decisions or invent authorization to resume a chain after process death.

**Execution outcome, safe resource release, and UI acknowledgment are separate.** A timeout or displayed error does not prove the glasses stopped writing. Providers explicitly decide whether retry, disconnect, replacement or cleanup is safe. Release owned resources automatically at the safe transition even if no screen is mounted; retain the result until acknowledgment. Done acknowledges/navigates and must not be the only path that stops a server or releases a transport. Keep Live's established per-pass teardown ordering and legacy explicit `finish()` semantics.

The recovery record is versioned and device-bound: integration/provider format version, flow/attempt/native IDs, source or artifact identity where applicable, last confirmed phase, and unresolved cleanup/recovery state. Write it before native upgrade entry and retain it across JS reload. Missing/corrupt/unsupported records cannot authorize a flash or override an active native session. A cold process start re-reads device state; cached bytes or a prior approval flag alone are insufficient. Do not add persistence of Live auto-chain approval as an incidental refactor.

### Interaction with other device users

One OTA at a time does not protect resources from gallery, calls, streams or logout. Source review found that Live hotspot OTA and gallery share `localNetworkTransport`, gallery cleanup calls `disconnect()` unconditionally, and the existing `GlassesHotspotLease` is used by ACS/managed relay but not those two paths. This is a current ownership gap, not evidence of a new regression already introduced by this design.

Extend the existing admission/ownership boundary only as needed: reserve the glasses hotspot and phone local-network route before preparing a Live hotspot update, include gallery/ACS/relay users, and let cleanup release only the caller's reservation. A conflicting start reports busy before altering either feature's connection. Do not silently stop a call/gallery operation or globally pause unrelated miniapps. Live's normal glasses-Wi-Fi path should not reserve a phone hotspot it does not use. NIMO/AR99 reserve their required device command channel and preserve their provider-specific traffic restrictions. These are scoped admission/cleanup changes; do not redesign the transports or their retry algorithms.

Intentional logout, unpair, factory reset, device switch, and deployment switch need an admission check before destructive cleanup begins. `LogoutUtils` currently clears authentication first and catches disconnect/forget errors before continuing to clear state; a rejection from `disconnect()` alone cannot protect OTA. For a user-requested action, either perform the provider's safe cancellation/cleanup and then proceed, or report that the device operation is still busy before starting logout/reset. If authentication is revoked externally, clear auth promptly while retaining only the device-local work needed to leave an in-flight update safe; do not continue optional checks/new passes under the revoked account or reuse its credentials. The provider needs a recovery surface independent of the signed-in app tree. Tests must cover both cases without changing the established auth-unmount ordering after admission.

## 6. Routing and onboarding

All OTA entry points resolve the intended integration and device identity before observing or commanding its provider. The paired identity remains available during reboot. Temporary `connected=false` or a UI unmount must not dispose the Live session or select another device.

Required routing work:

1. Replace `hasOta`-based dispatch in pairing and automatic update checks with integration provider/entry policy.
2. Make `/ota/check-for-updates` and `/ota/progress` dispatch intentionally. Existing Live URLs and their `initialPage` behavior remain valid.
3. Resolve settings and debug entry points through the same provider resolver. Do not show Live progress from its global store for another device.
4. Carry update return context through Wi-Fi setup. Preserve Live's current return behavior; generic Wi-Fi completion must not open Live OTA for another integration.
5. Keep connection-overlay and back-navigation behavior specific to the active flow. NIMO reboot copy cannot say “Mentra Live,” and an overlay Stop action cannot disconnect an unsafe transfer.
6. Keep product onboarding independent from firmware support. Live still gets its existing onboarding; NIMO continues to applicable MentraOS onboarding/home. Preserve AR99's current onboarding behavior until separately changed.

For NIMO, outdated required firmware keeps device setup incomplete until verification succeeds. An optional update may be deferred. A failed check or unrecognized version is not “up to date.” The user can retry or leave device setup; this must not create an inescapable app-wide lock.

This must be enforced at device-operation dispatch as well as navigation. Both NIMO SGCs currently mark the connection ready before version responses arrive; canvas readiness checks TWS/peer readiness without a firmware-compatibility decision. Keep transport/control readiness available for inventory and OTA, and expose a separate operational restriction while compatibility is unknown, required firmware is missing, or an update owns the device. Normal firmware-dependent commands cannot bypass it by reopening the app or launching a miniapp. Compatibility policy comes from the device integration/configuration, not model checks in miniapps. Preserve existing readiness semantics for Live/AR99 and unrelated glasses.

After NIMO verification, refresh device inventory/readiness, restore permitted settings/operations, and then finish setup. Re-evaluate against observed identity/firmware and applicable compatibility policy after reconnect/app restart; do not persist a universal “OTA done” boolean. Known-compatible firmware may use valid bundled/cached compatibility metadata while offline; inability to fetch an optional recommendation does not make a known-compatible device unusable.

Checking starts automatically after pairing; flashing begins only after the user accepts the offer. This is the requested automatic onboarding flow, not silent firmware installation.

## 7. Firmware sources and SDK distribution

Keep release sourcing device-specific while sharing a small artifact descriptor: release ID, target compatibility, URL, size when known, and integrity information.

### Live manifest policy remains unchanged

Keep the existing `otaManifestUrl`/`otaManifestSha256` release metadata, native defaults, Engine resolver, PR packaged pin, legacy fallback, and override precedence. Do not change the current metadata schema or reinterpret a Live manifest as a multi-device catalogue.

Likewise preserve Live's exact APK pin and downgrade floor `51518114`, MTK source-version matching/full-OTA eligibility, BES comparison, firmware-only-manifest legacy behavior, and required-update defaults. Improving any of those is a separate behavior change.

### NIMO uses an additive source

Add a generated device-firmware catalogue/configuration alongside existing SDK release metadata, with matching TypeScript, Swift, and Kotlin values. It references an immutable NIMO manifest and digest. Verify the downloaded manifest's raw-byte digest before accepting its artifact metadata. Existing Live fields retain their meaning and outputs; this new validation requirement does not change Live's current fetch path.

The NIMO manifest specifies supported hardware/firmware family, target full firmware identity, artifact URL/SHA-256/size, minimum compatible firmware or approved compatibility range, and release notes. Distinguish a required compatibility upgrade from an optional newer recommendation. Do not treat arbitrary newer or unrecognized firmware as compatible or automatically downgrade it to the tested image.

Use four-component NIMO version parsing and the detailed build identity; do not pass `0.1.1.1` through a three-component semver parser. Preserve raw device inventory for diagnostics.

Source builds without a configured source do not silently select production “latest.” An explicit debug configuration may select the tested artifact. Broad release requires vendor confirmation of hardware applicability and approval of the supplied build as a distribution target; that decision is not implied by the successful bench run.

Host deployment configuration may explicitly allow, replace, or disable each non-Live firmware source. Unspecified consumer configuration may use the embedded source. Organization workspaces default to no vendor/public fallback unless explicitly authorized. Keep those new per-integration settings separate from Live's existing configuration field.

### AR99 preserves the vendor service

Move its release-source implementation with its provider only when the managed migration is enabled. Inject deployment authorization and vendor configuration; keep the existing signing helper and request semantics. Do not embed app store imports in Engine or silently expand vendor network access.

Do not replace the vendor service with a static NIMO-style manifest, reinterpret version strings using Live comparison, or make an optional vendor digest mandatory as an incidental refactor. Preserve current MD5 behavior; any stronger source-integrity policy is a separate reviewed change.

### Artifact lifetime

Use session-owned staging paths with a pinned integrity descriptor. NIMO requires SHA-256 and size verification before entering upgrade mode. Native start validates that the artifact still matches the approved descriptor; mutable or replaced cache files cannot silently change the image.

Reuse existing low-level native background download support where applicable. Live's `OtaArtifactDownloader` also plans APK/MTK/BES artifacts and rewrites manifests; leave that module in place rather than generalizing it in this project. The managed staging layer must not delete another updater's files or clear a paused session's artifact merely because a screen disappears.

## 8. Device-specific implementation requirements

### Live: complete the abstraction by extracting execution ownership

The existing separation is useful: `OtaInstallCoordinator` is already a headless class, and `OtaFlowFrame` renders an injected controller. `MentraLiveOtaPreview` already renders that frame without mounting the execution hook. The remaining work is primarily to extract `useMentraLiveOta` and the background checker's workflow state, not to replace the update algorithm.

The target dependency path is:

```text
Mentra App / OEM host
  → shared firmware-update service: resolve integration, admit/adopt session
    → Live provider: check, approval, continuation, requirements, final outcome
      → existing Live checker + install coordinator + hotspot transport
        → public Bluetooth SDK → Live SGC → glasses update/recovery services

Views ← snapshots / allowed actions / presentation data
Host navigation ← action results / requirements
```

The service supplies orchestration infrastructure, not a universal sequence of download/install/reboot steps. An individual Live install pass is a child of the provider session. Its `complete` state is not the provider's final `complete` state.

#### What moves, and what remains behaviorally unchanged

| Current owner | Target owner | Required preservation |
| --- | --- | --- |
| Hook initialization effect | OTA runtime initialization + thin hook binding | Await native status hydration before deciding whether to exit. Bluetooth-only hosts still work without auth, cloud startup, or the miniapp runtime; preserve `initializeRuntime: false`. |
| Hook check state and generation refs | Live session | Same check arguments, stale-result guards, minimum checking presentation, skipped/failure handling and retry policy. Changing callbacks must not restart a check. |
| Hook Install action and pending ref | Live session command admission | Same battery/Wi-Fi rules and `prepare → clear progress → activate coordinator` order; one approval starts one chain. |
| Hook progress effect calling `attach/detach` | Explicit Live pass activation/deactivation | Activate the existing coordinator once when entering an install pass. View subscriptions never call its destructive reset/cleanup methods. |
| Module-global `OtaAutoChain` state | One Live session-owned chain instance | Keep approved downgrade, seen fingerprints, pass count, release range, reconnect deadline and admission algorithm. Do not leave an independent module-global chain beside the new instance. |
| Hook completion timer | Live session transition | Keep 750 ms continuation delay and await hotspot teardown before returning to checks. One completion event advances at most one pass. |
| Hook screen/error/action calculation | Pure Live presentation projection | Preserve screen priorities, copy keys, raw support codes, button permissions, release labels, changelog timing and progress calculations. |
| Background component's polling/check refs | Live availability controller under the same provider | Preserve 500 ms initial delay, 60-second manifest polling, version/disconnect invalidation, transport readiness and prompt suppression. |
| Event-service clock recovery | Live recovery policy + the same command owner | Preserve clock-fix eligibility, settle delay, coalescing, cooldown and manifest resolution; no independent start sender outside the provider. |
| Alert rendering, navigation, overlay callbacks | Host adapter / thin React binding | App supplies whether prompts may be shown and whether the user returned home. Provider receives semantic context, not route strings. Theme, localization, Live onboarding and screen lock remain host concerns. |

`OtaInstallCoordinator`, its protocol-policy helpers, `OtaUpdateCheckService` comparison logic, `OtaService` event normalization, clock-correction policy, `HotspotOtaTransport`, and `OtaArtifactDownloader` retain their algorithms. Initially keep their files and names. Extract only narrow dependencies needed for ownership and testing, including routing clock recovery through the shared Live command owner; do not rewrite the coordinator as a new generic state machine or rename every legacy helper in the same change.

#### Execution model and ordering

The provider has one explicit state owner. Device events, check results, timer expirations, and user actions enter that owner as events. Apply short state transitions serially and notify observers after the transition. Run asynchronous checks, native commands and teardown outside that transition, then deliver their result with the owning session/attempt/generation. **Do not hold a serial command queue across a long await that itself needs incoming device events to finish.** Keep the coordinator's existing reaction ordering and reentrancy guard.

The normal approved flow remains:

1. Initialize the OTA-only projections and finish status hydration; check the selected Live source.
2. Show the existing offer and requirements. Install below a known 25% battery is blocked; unknown battery remains allowed, matching current behavior. Unknown Wi-Fi status triggers rechecking; known Wi-Fi wins over hotspot, and hotspot requires protocol capability exactly `1`.
3. Prepare the chosen transport, record the approved chain and selected result, clear stale progress, and activate the existing install coordinator exactly once.
4. Let the coordinator own ACK/query/start arbitration, watchdogs, legacy handling, SID recovery and install-pass completion.
5. When a connected pass completes in an active chain, show `finishing`; after the existing 750 ms delay, await the existing coordinator `finish()` and hotspot teardown. Deactivate/reset the finished pass at the corresponding progress-to-check transition, then perform the continuation check.
6. Admit another pass through the unchanged fingerprint/downgrade/max-pass rules, or preserve the chain while waiting for Wi-Fi/readiness. Only the final successful no-update check ends an approved chain and exposes Done/changelogs. Preserve the separate existing recovery presentation when no in-memory approval chain can be reconstructed.

Keep the current check modes distinct:

| Mode | Current arguments/behavior to retain |
| --- | --- |
| Interactive check | Fresh version request; build wait 10 s, BES 5 s, MTK 2 s; `fixClockBeforeCheck: false`; minimum checking display 1.1 s |
| Approved continuation | Interactive rules plus legacy migration wait up to 120 s, bounded reconnect wait 120 s, one network retry after 5 s, maximum eight passes |
| Background availability | Schedule after 500 ms; no fresh version request; build wait 0, BES 5 s, MTK 0; retain the checker's default clock-fix behavior |

Do not deduplicate those modes using only device ID: a background result without fresh versions cannot satisfy final release verification. Coalesce only equivalent requests. An active install/continuation owns the selected offer and suppresses background publication/prompts. An earlier availability check may finish, but must not replace the session's prepared manifest or write stale availability into the global Live store. The existing checker writes that store internally, so it needs a narrowly scoped publication guard/seam as well as a guard in its caller; checking generation only after it returns is insufficient.

Background manifest polling currently pauses on `otaInProgress`, remembers the manifest URL/body actually checked, and re-arms when content changes. Carry those semantics into availability state. Give prompt candidates stable identities and acknowledge presentation/dismissal once. Host adapters keep the existing immediate/deferred Wi-Fi prompt behavior, home-only alerts, Super Mode copy, and Update Later behavior. UI rerenders or multiple observers must not duplicate alerts or silently change when an optional update is offered.

#### Preserve the transport and firmware compatibility details

Live's native SDK already serializes pending `ota_start` requests on both platforms. A resolved/rejected ACK promise is not the lifetime of a glasses install: the coordinator retains additional ownership/activity evidence. Neither layer can replace the other. Keep pending-start adoption, query-first recovery, the live-install-only downgrade detour latch, and SID-change handling exactly as implemented.

Clock recovery is another sender that must join that ownership boundary. Retain the existing eligibility rules (`clock_skew`, or `ssl_error` with an observed drifting clock), 500 ms settle, 30-second cooldown, concurrent-call coalescing, and no-pin refusal. Proactive clock correction during a check must still never start OTA. Keep automatic recovery of an observed failed update working when no flow screen is mounted; it does not create approval for a new multi-pass chain.

Extract the recovery command as an injected Live-owned operation so the event projector does not directly call `BluetoothSdk.startOtaUpdate`. Characterize its overlap with a pending coordinator start, automatic retry, manual retry, detour and disconnect. Admit one recovery attempt and propagate its outcome into the same ownership state; do not add a second retry scheduler or blindly queue a later start after an already accepted command. The current helper resolves the normal manifest URL independently, whereas hotspot uses a local rewritten URL: preserve that distinction in baseline traces and investigate any hotspot clock-recovery mismatch explicitly. Do not silently change its URL policy as part of extraction or assume the existing test suite covers that combination.

Keep pre-37 protocol selection sticky for each pass, even if the ASG version changes mid-pass. Preserve pre-39 legacy manifest rescue/handoff, MTK-installed-but-awaiting-reboot filtering, legacy APK settle holds, BES reboot-edge evidence, padded watchdogs/Continue lockouts, and MTK display-only simulation. Do not strengthen Live's per-pass completion into an unconditional exact BES-version readback: existing tests intentionally accept an authoritative reboot edge despite temporarily stale version metadata. Final chain verification remains the existing fresh check.

Hotspot ordering is also part of the behavior contract: prepare verified artifacts before switching networks; obtain the local address using the established platform path; publish the rewritten manifest on the same server endpoint before `ota_start`; preserve Android Wi-Fi permission handling and iOS native download/local-network support. Teardown retains its delay/retries, stops the server, releases the local-network connection, and cleans artifacts before the next Internet-dependent check. A generic service cleanup or view unsubscribe must not run this sequence early.

#### View lifetime is the deliberate change

An active managed session survives view unsubscription. This deliberately differs from today's hook cleanup, which detaches/reset the coordinator. Normal install decisions and timings should match; remount behavior improves by retaining them rather than restarting timers. Preserve the latest-callback behavior and UI-only `onFirmwareRestartingChange(false, false)` cleanup without interpreting that callback as cancellation of the actual update.

Keep `enterFlow` distinct from `subscribe`: the stock hook can explicitly open/adopt a flow once, while multiple subscribers remain passive. A remount adopts an existing flow instead of resetting its check state, approval or deadlines. A fresh, explicitly requested check after the user finishes starts a new flow. Navigation effects are bound to the initiating host interaction, so a terminal snapshot replay cannot repeatedly navigate newly attached observers.

The existing `initialPage: "progress"` entry needs a compatibility test of its own: today it attaches the coordinator and can start or reconcile, even without a mounted check page. Preserve it as an explicit legacy execution-entry command through the Live owner, with the same initial arbitration; do not pretend it is merely a passive subscription or silently remove it. New generic consumers use approved-offer Start or adoption of an existing session, and an extra observer never repeats that entry command.

Runtime ownership must also be explicit. Today `engine.stop()` stops the status/OTA projections, while `engine.ota.initialize()` can start them without the full runtime. An active provider must hold a lease on the OTA-required projections/transport independently of cloud/UI lifetime. Stopping the unrelated runtime must not quietly remove the input stream mid-update. Release those resources when no runtime/OTA owner remains; explicit device shutdown during an unsafe phase must use the provider's allowed actions. This is a scoped lifecycle change requiring tests, not a reason to redesign all Engine services.

This design does not promise uninterrupted JavaScript execution after process death. Preserve existing iOS background facilities and native/glasses execution, then reconcile on wake/reload. Reconstruct observed progress from authoritative status; do not manufacture the lost approval/range needed to auto-start a further pass.

#### Public API compatibility without a second controller

Keep exported types, screen names, hook actions, `MentraLiveOtaFlow` props and Bluetooth-only initialization. The public hook becomes a binding to the Live provider plus its compatibility presentation projection. The stock Live renderer and the common renderer must consume the same provider decisions; no hidden hook drives a parallel session.

The lower-level `engine.ota` surface requires more care than renaming:

| Existing API | Compatibility treatment |
| --- | --- |
| Snapshot/status subscriptions | Preserve their Live read models and keep observation passive. They never select NIMO/AR99. |
| `checkForUpdates(options)` | Preserve result shape and explicit check options through the Live checker; coordinate publication with the active provider. |
| `install(url)` | Preserve the Live native ACK return type; it is not the new whole-session Start result. Dispatch through the Live command owner to the same native primitive. Do not add a second retry loop or recheck behind this call. |
| `installSession.prepare/attach/detach/retry/finish/discard` | Deprecated explicit controls over the same install coordinator. A legacy-only caller retains its attach/detach cycle; its detach can release only its own execution lease, never a managed flow's lease. Keep the coordinator's existing detach/reset behavior when that legacy lease is the only owner. |
| `clearProgress`, availability/build/MTK mutations | Preserve standalone Live semantics, but do not let a competing legacy driver mutate another active managed session. Internal provider calls use the admitted owner. |

Legacy/manual execution and managed execution are mutually exclusive drivers of one coordinator, not two updaters. Incompatible mixed-driver commands fail with a documented busy/conflict outcome; read-only observers remain allowed. This concurrency guard is an intentional new restriction for conflicting callers, not a claim of byte-for-byte compatibility for unsafe mixed use. Ordinary existing standalone consumers must retain behavior. Retaining these low-level methods does not let the Mentra App skip provider selection.

Direct Bluetooth SDK consumers remain low-level protocol clients; they are not secretly enrolled in an Engine flow and Engine cannot promise to coordinate arbitrary native calls made outside it. Preserve their existing command semantics and pending-request guard. Document one execution owner per device rather than silently changing the native Live protocol API.

#### Shared presentation without flattening Live's behavior

Use reusable checking, offer, requirement, progress, error and completion presentation, driven by provider state/actions. Allow optional step/artifact/release-note data and indeterminate progress. Preserve Live's existing `finishing`, downgrade explanation, Wi-Fi intervention, reboot-required error, update-info-unavailable escape, and button lockouts through its presentation adapter. Common UI must not infer Retry, Cancel, Done or success from phase/progress alone.

The generic renderer does not import Live or switch on model names. Live-specific interpretation belongs in `mentra-live/presentation.ts`; the old public component is a typed forwarding wrapper. Reusing existing visual components and translations is preferable to redesigning the Live screens during this migration.

### NIMO

1. Discover OTA TX `0x2001` and RX `0x2002` on the SGC's main service connection. The separate `Nimo-…_BLE` notification peripheral is not the update transport.
2. Allow identity/version/OTA preflight from the minimal control connection. Do not require dynamic-canvas readiness or an ASG build number to offer the update that enables those capabilities. Verify the old-firmware native pairing path on each phone platform.
3. Preflight checks identity, full firmware inventory, both batteries, TWS/dual-side state, and the firmware slice requested by the device. Respect vendor can-update results; only `0` and `3` authorize entry. Avoid borrowing Live's battery threshold.
4. Acquire exclusive managed-update ownership before entering mode. Pause normal NIMO canvas/mic/control traffic and their competing watchdog/reconnect behavior as required by the vendor protocol. Keep the existing connection; restore ordinary operation only when the updater establishes it is safe.
5. Implement framing, sequence correlation, bounds checks, per-frame CRC32, native write backpressure, and device-requested blocks/delays on both platforms. Use the actual platform write limit; do not assume the Mac's 512-byte limit on every phone.
6. Wait for authoritative end-of-transfer, then successful image validation. Poll synchronization until both sides are synchronized. Bounded pending-sync and communication-failure budgets are separate; timeout does not authorize reboot.
7. Reboot only after synchronization succeeds. Reconnect the same physical device using existing native connection infrastructure. The first failed reconnect is not automatically an update failure.
8. Read firmware after reconnect. Require the full target identity, corresponding main-protocol version, and converged peer state. Keep version representations separate: the bench's OTA TLVs reported `0001` while the image header used `1001`; comparing those directly generated a false mismatch.
9. Publish `complete` only after readback verification. “All bytes sent,” Bluetooth reconnect, and a target copied into a store are insufficient.
10. Persist enough evidence to diagnose an interruption. Safe resume/abort behavior still needs vendor confirmation or controlled hardware validation; no speculative recovery commands.

Normal source checks and retries are not a reason to repeatedly flash the already-updated bench glasses. Testing an old-to-new phone path requires an eligible device or a vendor-confirmed safe reflash/downgrade procedure.

### AR99 managed migration

Start with characterization of current native behavior, then move ownership in small steps:

- Add a native snapshot plus device/session/generation metadata around the existing manager, retaining a terminal snapshot before it clears firmware/progress internals.
- Bind manager transport and callbacks to the intended device. Reject stale callbacks, duplicate starts, and cross-device adoption before reusing the existing singleton managers.
- Preserve protocol bytes, MTU negotiation, platform write scheduling, five-second command timeout, and 90-second reconnect behavior during extraction.
- A managed reattach/reconcile must adopt paused native work. It must not call `startAr99OtaFromFile` and cancel it.
- Preserve explicit user restart behavior through a distinct admitted restart operation. Old and new SDK APIs share native ownership; they cannot independently preempt each other.
- Move vendor lookup, downloads, active file ownership, and UI state out of the modal. Keep the same settings entry and vendor-required/optional policy initially.
- Treat the current native success as image-validation evidence. Establish whether firmware activates immediately, automatically reboots, or requires an explicit action. Only then implement readback verification and final success presentation.

Enable the migrated AR99 provider only after both native platforms pass these cases. Removing its separate modal-owned execution path is required to complete this project. AR99 pairing-time updates remain outside scope; verified completion must respect the vendor's actual activation contract.

## 9. Risk assessment and release gates

| Change | Main risk | Required containment |
| --- | --- | --- |
| Device routing | Selecting the wrong updater; losing a session on a temporary disconnect | Stable provider/session identity and routing/re-subscription tests |
| Live lifecycle extraction | Changed command timing, duplicate start, lost approval/recovery, early cleanup | Extract current decisions into one provider; compare command/state traces; retire React execution ownership |
| NIMO native transfer | Bad frame, wrong image, peer left unsynchronized | Captured protocol fixtures, device/hash guards, real phone updates and readback |
| AR99 ownership extraction | Cancelled resume, lost event, stale singleton callback | Native identity/snapshot boundary and explicit restart semantics before UI replacement |
| New artifact/source configuration | Wrong firmware family or unexpected network fallback | Separate catalogue, deterministic source policy, integrity checks, SDK package tests |
| Shared completion UI | Claiming success before activation or another Live pass | Provider-authoritative completion; Live's existing final no-update check retained |
| App/JS lifetime | Losing progress or replaying a start after remount | Native managed session ownership, passive subscriptions, bounded reconciliation |
| Shared resources / logout | Another feature's cleanup disconnects OTA or clears its identity | Admission before destructive actions; owner-specific hotspot/network release; local recovery independent of authentication |
| NIMO compatibility gating | Pairing succeeds and normal commands run before required firmware is installed | Separate control readiness from operational eligibility; enforce at dispatch and refresh after verification |

**Assessment:** completing Live's lifecycle extraction has meaningful regression risk beyond a routing-only change. That work is justified to reach the requested architecture and needs characterization, parity tests, and hardware validation. NIMO is new hardware-sensitive work; AR99 ownership/activation needs independent validation. A “zero risk” or “100% safe” claim is not supported by this analysis.

### Stage A — characterize Live and establish the contract

- Capture the current hook/coordinator interaction and public API behavior with fake time, scripted status/ACK/SID events and command traces. Add missing background component and mixed-owner cases before moving ownership.
- Add registration, shared admission/observation contracts and presentation types. Prove the contract can express Live's complete flow, not just NIMO's simpler happy path.
- Preserve firmware pins, native command implementation and coordinator algorithms. NIMO remains disabled.
- Gate: reproducible reference traces and baseline tests; explicit expected differences for remount/resource ownership. Do not run two real controllers against hardware for comparison.

### Stage B — finish Live's provider extraction first

- Extract the session and pure presentation from the hook. Move background availability scheduling/state and event-driven clock-recovery command ownership into the provider; leave alert/navigation rendering in the host adapter.
- Drive existing coordinator activation, terminal pass cleanup and continuation explicitly. Replace auto-chain global ownership and add scoped stale-result publication guards.
- Protect shared hotspot/network ownership and intentional logout/reset admission before enabling updates that outlive their screen. Preserve ordinary gallery/call/stream and auth teardown behavior outside active reservations.
- Reduce the old hook/facade/component to the documented shared-owner bindings. Route Live entry points through provider registration. Preserve the stock UI and current onboarding.
- Gate: command/state parity, public consumer compatibility, full hook/background/lifetime tests, platform builds and real Live updates on both phone platforms. Passing only a routing smoke test is insufficient.
- This stage establishes the real abstraction. There is no permanent `existing-flow` binding for Live.

### Stage C — NIMO vertical integration

- Implement Swift/Kotlin updater, public bridge, provider, source configuration and pairing/settings presentation using the contract already exercised by Live.
- Replace remaining accidental `hasOta` dispatch and ensure Wi-Fi return/overlays resolve the active provider.
- Gate: eligible-device updates complete on iOS and Android, including post-reboot readback; readiness, background, interruption and wrong-device cases below are exercised.
- Release firmware/channel choices remain explicitly pinned. Approving code does not publish or repin vendor firmware automatically.

### Stage D — AR99 ownership and migration completion

- Characterize protocol and activation behavior; add native session snapshots and identity before replacing modal ownership.
- Move the vendor workflow behind its provider, preserve the settings-only entry, and adopt paused work on re-entry without invoking the cancelling start wrapper.
- Gate: iOS and Android hardware acceptance, vendor policy parity and verified activation behavior. Remove its separate modal-owned execution path when the new path passes.
- Final audit: all three use the common service; no alternative flow selector, hidden execution hook, duplicated chain, or generic component that imports individual device implementations remains. Update public docs and navigation coverage.

These are reviewable increments of one completed project, not a decision to leave migration unfinished. Temporary adapters are removed as their provider replaces them; disabled unfinished providers do not count as completed support.

Activation/rollback is per integration and evaluated before an update starts. A running flow retains its selected provider implementation. NIMO/AR99 file transfers retain the admitted artifact identity for that attempt; Live retains its existing manifest-resolution, retry and fresh-check-between-passes behavior. Do not impose a frozen whole-flow artifact/release target on Live: its glasses-Wi-Fi path resolves a manifest URL and does not implement a phone-enforced digest pin for every downloaded artifact. Its existing chain admission rules govern subsequent offers. Changing configuration cannot replace a transport/provider mid-transfer. After rollback, unfinished managed sessions still need their recovery/observation path; an older binary that cannot read the journal is not a recovery strategy.

### Diagnostics and enablement evidence

Add the provider's sanitized diagnostic snapshot to the existing report context and log buffer. Today report collection captures the Live glasses store; keeping new provider state out of that store otherwise leaves NIMO/AR99 sessions absent from structured reports. Record integration, flow/attempt/native correlation, phone/SDK/provider versions, observed/target firmware, artifact/manifest identity where known, phase transitions/durations, retries, raw device failure code, and final verification/cleanup outcome. Exclude credentials and signed URL secrets. Use existing reporting infrastructure, not a new telemetry service.

Rollout decisions need per-device/platform evidence for completion, interruption, recovery and false-success failures, with start denominators and the tested source/target versions. A UI reaching 100% is not the success metric. Disabling new starts leaves observation and safe cleanup available for sessions already running.

## 10. Validation required before merge/enablement

### Registration and routing

- Register a synthetic fourth integration with an arbitrary ID, fake native client and provider. Exercise check, approval, requirements, progress, reattachment, failure/retry and completion through the shared service/UI without changing those modules or adding a model-name branch. Only its definition and registration should be needed for this test. Native SGC factory wiring remains explicitly outside this test's scope. This is the acceptance proof that the OTA boundary is pluggable.
- Synthetic unknown integration with `hasOta=true` never selects Live.
- NIMO gets its firmware check without Live onboarding or glasses Wi-Fi requirements; already-compatible devices continue normally.
- Missing/disabled native updater or firmware source is explicit, not an “up to date” response or fallback.
- Preserve Live's iOS Bluetooth Classic step and Android behavior, route order, callbacks, overlay/back rules, and public presentation behavior. Explicitly test the new provider-owned lifetime across UI unmount/remount.
- Verify pairing, settings, automatic reconnect checks, Wi-Fi return, progress recovery, and debug/deep-link entry paths.
- Switching device or deployment during a check/download invalidates stale offers and prevents start on the new target.
- Temporary disconnect during an active session keeps the intended provider selected.

### Live regression gates

Retain the 237-test baseline and public consumer typecheck, then add coverage for the extracted boundaries. Keep native manifest/pending-command tests and SDK package verification. Existing direct coordinator attach/detach tests continue to describe the lower-level coordinator; new provider tests establish that view unsubscription no longer invokes detach.

Use a deterministic trace harness that feeds equivalent fixtures to the reference flow and new provider in separate, isolated test runs. Compare native commands and arguments, relevant timer deadlines, state/action transitions, manifest selection, pass counts and host interaction outcomes. Do not compare every incidental render or log. Approved lifecycle differences must have explicit expectations; a different start count, source URL or release outcome is never dismissed as refactor noise.

| Scenario | Required assertion |
| --- | --- |
| Initialization / standalone OEM host | No exit before hydration; no cloud/auth dependency; explicit runtime-init opt-out still works. |
| Offer and prerequisites | Same required/optional/downgrade result, 25%/unknown-battery behavior, Wi-Fi-status wait and capability-1 transport choice. No new flash from observation. |
| Pending/rejected/timed-out start | At most one pending native start; activity followed by timeout does not cause a duplicate; authoritative failure and silent recovery follow existing policy. |
| Clock-skew / SSL recovery | Preserve eligible automatic recovery without a screen; no start from proactive correction; duplicate failures coalesce; pending start/retry/detour overlap cannot create a second independent sender. Verify ordinary and hotspot manifest arguments. |
| APK process replacement / downgrade | SID without BLE disconnect triggers reconciliation; live-install latch stays sticky through the detour; stale terminal failure cannot rearm it or trigger another install. |
| Legacy APK/BES/MTK | Pre-37 profile remains sticky, pre-39 rescue reaches final pin verification, pending MTK does not falsely finish, settle/reboot/lockout/watchdog behavior matches. |
| Completion and hotspot | Intermediate complete stays `finishing`; no Done/changelog early; delayed teardown blocks the next check; subsequent pass starts once. |
| Chain admission | Duplicate offer, ninth pass and unapproved downgrade stop automation; original reconnect deadline cannot be extended by rerenders; version-info failure/retry retains exactly the current approval behavior. |
| Background availability | Mount actual adapter/provider: manifest changes, home departure/return, unknown Wi-Fi, dismissal, disconnect/version invalidation and stale async completion preserve prompt behavior. No background result overwrites an active approved offer. |
| View lifetime / concurrency | Remount, two observers, callback replacement and Wi-Fi navigation cause no duplicate activation/start/finish. Unsubscribe only removes view effects. Legacy-only attach/detach still works; a competing driver cannot stop a managed session. |
| Runtime / recovery | Cloud runtime stop cannot remove active OTA inputs; JS reload adopts authoritative device work without restoring invented approval; terminal state stays observable until explicitly acknowledged/replaced. |
| Public presentation | Existing exhaustive screen union and action types compile; all error precedence/copy keys, labels, disabled actions, onboarding callbacks and stock screens retain their behavior. |

Hardware acceptance needs actual Live updates on iOS and Android: normal Wi-Fi, capability-supported hotspot, APK/SID recovery, a multi-component/multi-pass release, and old-firmware rescue on suitable test glasses. Exercise screen lock/backgrounding, Wi-Fi intervention and re-entry. Cover the downgrade detour with a known supported test pin/device; do not invent a downgrade solely to populate the matrix. Archive source/target versions and phone/glasses logs, and verify normal functionality afterward.

Mocked tests do not prove old-firmware or phone network behavior. If a hardware case is unavailable, list it as unverified and hold the corresponding release gate; do not label the migration regression-free. Firmware repinning and risky interruption/downgrade experiments require an explicit test setup separate from this design-only review.

### Managed sessions and artifacts

Run the shared contract assertions against the synthetic provider and all three real providers with mocked transports: passive observation, duplicate-start admission, allowed-action enforcement, identity isolation, retained outcomes and safe cleanup. Keep each provider's protocol/recovery expectations in its own suite; passing a universal happy path cannot replace Live's parity tests or native hardware validation.

Test duplicate Start during notification setup/preparing as well as transfer, re-subscription during transfer, JS reload with native state alive, retained terminal snapshots, wrong device/session/generation events, stale check/download completion, missing digest, corrupt/truncated download, source-policy denial, and cleanup while another session owns a file.

Test device replacement/unpair attempts during unsafe phases, concurrent legacy/new AR99 entry points, and observer callbacks arriving after terminal cleanup. Unknown state produces reconciliation/error, not a new flash or inferred success.

Also cover atomic snapshot/subscription, completion before the Start response, journal write failure before upgrade entry, unsupported journal/bridge versions, resource cleanup without a mounted view, logout/auth revocation, and gallery/ACS/relay contention. Verify owner-specific cleanup: stopping an inactive gallery service must not disconnect an OTA-owned network. A failed/timed-out update must not release an unsafe device merely because its error screen is terminal to the UI.

### NIMO hardware and protocol

Share captured successful exchange fixtures across Swift/Kotlin codec tests: endianness, envelopes, sequence wrap, split/coalesced notifications, invalid lengths/offsets, CRC vectors, negotiated chunk sizes, peer synchronization, and version representation differences. Malformed/timeout cases must not trigger an unauthorized reset.

On both phones: old-to-new update; already-current check; low battery/disconnected peer refusal; lock screen/background operation; expected reboot; delayed reconnect; full firmware readback. A compatibility read must work before dynamic display readiness. Validate normal display/mic operation after terminal success.

Verify that normal firmware-dependent operations remain restricted before compatibility is established, including cold restart after deferred/failed required OTA, and resume after verified success. Test already-compatible firmware with no Internet connection and keep optional update availability distinct from required compatibility.

Controlled interruption tests require a confirmed recovery procedure and suitable test hardware. Until those pass, document recovery limits and keep release exposure constrained; a happy-path flash is insufficient evidence for broad rollout.

### AR99 hardware and protocol

Before migration, capture normal update, vendor no-update/required response, disconnect/resume, explicit paused restart/cancel, and activation behavior on iOS and Android. Add corresponding protocol/session tests. Re-entering settings during resume must attach to the same session, not clear files or start again. Confirm actual running firmware before enabling the stricter completion UI.

Use existing Maestro pairing/onboarding conventions for app navigation coverage; physical transfer/recovery checks additionally require device logs. Run the repository Android compile script and the appropriate iOS SDK/app builds when native implementation changes begin.

## 11. Approval scope and outstanding evidence

Approval of this draft approves completing the common provider architecture for all three devices, including extracting Live orchestration from React, migrating AR99 modal ownership, the additive SDK source/API approach, complete routing scope, and validation gates. It does not approve changing Live's firmware/protocol policy or adding mandatory AR99 onboarding.

No architecture decision here requires a dynamic plugin loader. Keeping generic code independent of bundled device imports, using open integration IDs, and exposing optional native capabilities establishes the useful future direction now.

Outstanding evidence before release:

- NIMO firmware distribution suitability and supported hardware/starting-version range.
- NIMO safe interruption/recovery procedure and phone-platform behavior.
- AR99 activation/reboot/readback contract and regression fixtures.
- Live clock-recovery/coordinator overlap, background prompt lifetime, and provider extraction parity; these are not proven by the current helper-level tests.
- Actual mobile hardware acceptance and package/build checks for the implementation.

These are explicit gates, not assumptions hidden inside the abstraction. After design approval, implement the migration in tested increments. The project is complete only when all three devices use the same headless provider/session contract and the separate Live-hook/AR99-modal execution paths have been removed or reduced to forwarding compatibility wrappers.

## 12. Source map

Paths are relative to this document; function names identify the reviewed behavior.

| Area | Sources |
| --- | --- |
| Live lifecycle and actions | [useMentraLiveOta](../../../mobile/modules/engine/src/react/useMentraLiveOta.ts), [OtaInstallCoordinator](../../../mobile/modules/engine/src/services/OtaInstallCoordinator.ts) (`prepare`, `attach`, `detach`, `retry`, `finish`) |
| Live checks and continuation | [OtaUpdateCheckService](../../../mobile/modules/engine/src/services/OtaUpdateCheckService.ts), [OtaAutoChain](../../../mobile/modules/engine/src/services/OtaAutoChain.ts) |
| Live status/restart signals | [OtaService](../../../mobile/modules/engine/src/services/OtaService.ts), [existing public facade](../../../mobile/modules/engine/src/facades/ota.ts) |
| Live clock recovery and runtime lifetime | [glassesClockSync](../../../mobile/modules/engine/src/services/glassesClockSync.ts), [Engine start/stop](../../../mobile/modules/engine/src/Engine.ts), [status projection](../../../mobile/modules/engine/src/services/GlassesStatusProjection.ts) |
| Live native pending-command ownership | [Swift SDK](../../../mobile/modules/bluetooth-sdk/ios/Source/MentraBluetoothSDK.swift), [Kotlin SDK](../../../mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothSdk.kt) (`startOtaCommand`) |
| Live presentation seam | [stock flow and pure frame/preview](../../../mobile/modules/engine/src/react/MentraLiveOtaFlow.tsx) |
| Live manifests and release configuration | [manifest resolver](../../../mobile/modules/engine/src/services/otaManifestUrl.ts), [manifest policy](../../../mobile/modules/engine/src/services/otaManifestPolicy.ts), [SDK release metadata](../../../mobile/modules/bluetooth-sdk/src/generated/releaseMetadata.ts), [native defaults](../../../mobile/modules/bluetooth-sdk/ios/Source/OtaManifest.swift) |
| Artifact/network ownership | [OtaArtifactDownloader](../../../mobile/modules/engine/src/services/OtaArtifactDownloader.ts), [HotspotOtaTransport](../../../mobile/modules/engine/src/services/HotspotOtaTransport.ts) |
| Other resource owners and destructive lifecycle | [local network transport](../../../mobile/modules/engine/src/services/asg/localNetworkTransport.ts), [gallery sync](../../../mobile/modules/engine/src/services/asg/gallerySyncService.ts), [hotspot lease](../../../mobile/modules/engine/src/services/GlassesHotspotLease.ts), [logout](../../../mobile/src/utils/LogoutUtils.ts) |
| Existing report integration | [diagnostic context](../../../mobile/modules/engine/src/utils/diagnosticContext.ts) |
| Pairing and host navigation | [pairing success](../../../mobile/src/app/pairing/success.tsx), [Live host](../../../mobile/src/components/ota/MentraLiveOtaFlowHost.tsx), [Wi-Fi return](../../../mobile/src/app/wifi/connecting.tsx), [connection overlay](../../../mobile/src/contexts/ConnectionOverlayContext.tsx) |
| Automatic checks and settings | [OtaUpdateChecker](../../../mobile/src/effects/OtaUpdateChecker.tsx), [DeviceSettingsSection](../../../mobile/src/components/settings/DeviceSettingsSection.tsx) |
| AR99 host workflow and source | [Ar99OtaModal](../../../mobile/src/components/settings/Ar99OtaModal.tsx), [ar99Ota service](../../../mobile/src/services/ar99Ota.ts), [vendor configuration](../../../mobile/src/services/ar99ApiConfig.ts) |
| AR99 native protocol | [Swift manager](../../../mobile/modules/bluetooth-sdk/ios/Source/sgcs/ar99/ota/Ar99OtaManager.swift), [Java manager](../../../mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/ar99/ota/Ar99OtaManager.java) |
| AR99 start wrappers/transport | [Swift SGC](../../../mobile/modules/bluetooth-sdk/ios/Source/sgcs/Ar99.swift), [Java SGC](../../../mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/Ar99.java) (`startOtaFromFile`) |
| NIMO connection/readiness/version | [Swift SGC](../../../mobile/modules/bluetooth-sdk/ios/Source/sgcs/Nimo.swift), [Kotlin SGC](../../../mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/sgcs/Nimo.kt) |
| Existing design constraints | [Unified Live update session](2026-08-27-unified-ota-update-session-design.md), [Public hotspot OTA API](2026-08-26-public-hotspot-ota-api-design.md) |
| Live reference behavior tests | [coordinator](../../../mobile/src/__tests__/otaInstallCoordinator.test.ts), [hook](../../../mobile/modules/engine/src/react/__tests__/useMentraLiveOta.test.tsx), [stock flow](../../../mobile/src/app/ota/__tests__/shared-flow.test.tsx), [background helper tests](../../../mobile/src/effects/__tests__/OtaUpdateChecker.test.ts), [clock recovery](../../../mobile/src/services/asg/__tests__/glassesClockSync.test.ts) |
| Public compatibility fixtures | [OTA consumer](../../../mobile/modules/engine/scripts/fixtures/public-ota-consumer.tsx), [Engine boundary](../../../mobile/modules/engine/scripts/public-ota-boundary.test.mjs), [SDK OTA API](../../../mobile/modules/bluetooth-sdk/scripts/public-ota-api.test.mjs) |
