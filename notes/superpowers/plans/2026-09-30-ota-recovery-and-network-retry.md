---
status: active
owner: philippe
---

# Fix OTA recovery handoff and investigate persistent network retries

Spec and evidence: [OTA recovery and network retry](../specs/2026-09-30-ota-recovery-and-network-retry.md).

Base: `e09a07ee7b71972e75a5051003ec561c12e6cb9b` (`origin/staging` at investigation start). Branch: `codex/os-2046-os-2047-investigation`.

## Completed investigation

- [x] Read the original Slack thread, all four OTA screenshots, and the original phone/glasses log ZIP. Treat these as authoritative over the AI-paraphrased tickets.
- [x] Capture initial device/package/network state and verify exact published source/target APK hashes and signers.
- [x] Reproduce the 180-second timeout with an unavailable recovery worker and the redundant 110 MB retry download.
- [x] Complete the exact ASG downgrade with recovery available; compare all 74 existing gallery-file hashes.
- [x] Demonstrate `no_internet` from a stalled server on connected, validated Wi-Fi, followed by successful retry without reconnect.
- [x] Verify that the existing include-stopped intent reaches a force-stopped enabled worker during a real CDN-backed downgrade.

## Implementation status

The implementation uses an explicit ordered broadcast query rather than another long
startup watchdog. Recovery v11 answers queries on the same control executor as handoff
decisions and returns a request nonce, protocol version, transaction identity, target,
hash, busy state and last terminal reason. The existing signed broadcast verdict remains
compatible with older ASG; the new updater uses it only to trigger a correlated durable
query. A missing response does not release ownership. The updater checks recovery again
before any artifact/firmware work after its own process restart.

The current patch deliberately contains no MTK driver/routing reset and no automatic
Wi-Fi toggle: the original persistent network condition still lacks a captured cause.
The safe, evidence-backed changes are accurate error classification, unconditional
request cleanup, fresh requests on retry, and retained diagnostics. The 32-entry history
survives ordinary ASG restarts, but ASG uninstall resets its preferences.

## 1. Recovery readiness and repair

- [x] Add a readiness/status protocol to recovery, with a correlated request ID and advertised protocol version. Increment the worker version and synchronize the bundled-version and minimum-version gates.
- [x] In `RecoveryWorkerManager`, inspect availability/signers/permissions/receiver state, start or deploy through the supported path, and await readiness. A dispatched broadcast is not success.
- [ ] Verify the OEM path for repairing an explicitly disabled worker. If unsupported, give a specific recovery/support action instead of promising reboot will fix it.
- [x] In `OtaHelper`, complete readiness before downloading or entering install/verifying presentation. Use a bounded readiness timer separate from hashing/enqueue and transaction supervision.
- [ ] Cover missing, old, disabled, stopped, incompatible, and non-responsive workers. Assert that unavailable recovery performs no large download.

## 2. Handoff ownership, cache, and UI

- [x] Persist recovery-owned transaction identity/target/hash/state and expose a read-only status query.
- [x] Make duplicate requests for the same transaction idempotent; report existing ownership for a conflicting request. Preserve claimed-artifact and installer serialization guarantees.
- [x] Correlate all verdicts in `ServiceHeartbeatReceiver`/`OtaHelper`. On acknowledgement loss, reconcile durable state rather than treating timeout as confirmed non-ownership.
- [x] Reuse valid unclaimed staged APKs; never overwrite a claimed artifact. Test corrupt cache, changed target, and a retry concurrent with accepted work.
- [ ] Update `OtaInstallCoordinator` and OTA presentation to follow the authoritative phase/ownership state through retry, reconnect, and remount. Keep exact target-version completion.
- [x] Replace misleading two-minute/two-restart copy. Preserve the reported slow experience as an acceptance concern, with actual per-phase timings and clear install versus download labels.
- [ ] Test late verdicts, lost acceptance, recovery/ASG process death, phone remount, and slow accepted transactions; no duplicate install/download or premature release.

## 3. Network evidence and supported fixes

- [ ] Add attempt-scoped network/HTTP diagnostics at manifest and artifact boundaries; preserve a failure/retry ring in incident artifacts without credentials or signed URL queries.
- [x] Replace the broad `no_internet` mapping with distinct DNS/connect/read-timeout/HTTP/TLS/no-network categories. Synchronize Engine error mapping and app translations.
- [x] Put all download streams and connections under unconditional cleanup. Verify retries release admission, retain byte-based liveness, and make a fresh request on the intended current transport.
- [ ] Repeat the stalled-server fixture and add DNS, connect refusal, captive portal, validation transitions, AP loss, and hotspot/local-server recovery. Retry should succeed without manual reconnect when connectivity is usable.
- [ ] Capture the persistent failure on the affected network/setup. Only then select any MTK/DNS/routing/reconnection patch; the current fixture does not reproduce that specific cause.

## 4. Ship and qualify

- [ ] Establish delivery to already affected source builds: a compatible source-side ASG bridge plus versioned recovery, or an explicit signed-worker support repair. A fix only in the lower target cannot unblock its own installation.
- [ ] Run focused ASG/recovery JVM and Android compile checks, Engine coordinator/error tests, then physical release-signed qualification. Keep PR evidence separate from hardware evidence.
- [ ] Test exact source/target and bridge-to-staging paths on the RC Mentra App, normal Wi-Fi and phone-served hotspot; include reconnect, background/screen-off, gallery rendering and byte preservation.
- [ ] Read and apply `select-pr-routines` when opening implementation PRs; select existing coverage and state gaps. Obtain the required independent Codex PR review. The implementation PR and review are tracked in the task.

## Device disposition and limitations

Final glasses state: ASG `302010058` / 3.2.1, recovery v10 enabled in its original default state, not stopped, and no active downgrade transaction. All 74 pre-existing gallery files still match their original hashes, with no added files. The provided Mentra Wi-Fi connection remains configured.

The supported downgrade reset ASG-owned app state through uninstall/reinstall. It did not flash MTK/BES, change the phone's installed app, or delete gallery data. Local fixture servers were stopped, the investigation's ADB reverse removed, and ADB returned to non-root. The phone was returned home and put to sleep for charging.

The local evidence summary is `incident-logs/ota-investigation-20260930/summary.json`; `key-events.txt` indexes the full captured log and `SHA256SUMS` inventories the evidence. The connected phone is 3.2.0, not the reported RC; the test triggers exercised ASG/recovery directly, so full RC UI qualification remains on the checklist.

## Implementation validation, September 30

- ASG Java compile and release-signed APK build passed; 159 focused ASG JVM tests passed.
- Recovery v11 release-signed build and 29 JVM tests passed. The signing certificate matches
  the existing release worker/ASG certificate. CI builds and bundles this worker before ASG.
- 143 focused phone tests passed (coordinator, error mapping and OTA presentation).
- Disabled recovery v11: only the manifest was fetched, followed by
  `downgrade_recovery_disabled`; no APK request occurred.
- Force-stopped enabled v11: readiness woke it. A fixture sent 128 KiB then stalled;
  the updater reported `download_timeout` after its 20-second read timeout while Wi-Fi
  remained connected and validated on the same network. The request history retained
  the phase, byte count, exception classes and before/after network snapshots.
- Removed recovery's control receiver after readiness, during the download: the full
  verified APK remained unclaimed, the updater reported `downgrade_status_unknown`, and
  another OTA request was rejected while admission remained owned.
- Restored recovery and restarted ASG by changing a component setting. The next attempt
  queried durable state and reused the full verified APK without another artifact GET.
  With ASG's verdict receiver disabled, recovery accepted and completed installation of
  target `302010058`. All 74 existing gallery files retained their original SHA-256 hashes.

These are local release-signed ASG/recovery tests through the debug OTA entry point, not
an end-to-end test of the patched Android phone UI. The connected phone remains on 3.2.0.
No MTK/BES firmware was installed. Raw evidence stays gitignored under
`incident-logs/ota-implementation-20260930/`. The fixture initially failed its own component
mutation as non-root (EOF at headers); that run is retained as a fixture failure, and the
handoff-loss test was repeated successfully with authorized root access.

The pinned `routine:day1-ota` definition was inspected at harness revision
`90a70edfe2fa17fd766dda3d98977555d6608a05`. It covers multi-component customer OTA on an
existing authorized Mac/lab fixture, but not these lost-verdict/disabled-worker/stalled-server
faults or Android UI. Its label is deferred because this task's hardware authorization is
for the connected phone/glasses, and the shared January/return fixture's authorization and
remaining attempt budget have not been established. Add focused recovery-fault steps to a
reviewed routine before treating those cases as unattended coverage.

## Rollout / already affected devices

The current source build must receive the fix: publishing it only inside a lower target
cannot repair the updater trying to install that target. Use a signed source-side bridge
ASG newer than the affected build, with bundled recovery v11, before offering the lower pin.
The existing CI asset build supplies the worker; standalone remote worker updates remain
explicitly disabled.

For an already stuck support device, first establish that no recovery transaction or OEM
install is active. Verify the release certificate and exact worker artifact, install the
signed v11 worker with the supported installer/authorized USB tooling, and restore the
worker package/control receiver to its enabled default state if disabled. Do not delete a
claimed `.txn` artifact to force a retry. The original ASG handoff remains compatible with
v11, while a bridge ASG adds readiness, correlation and cache reuse. This procedure needs
the existing device/support authorization; a reboot is not a repair for a disabled package.

Remaining release qualification: patched RC Android UI and physical iPhone/Mac hotspot flow,
old worker deployment, network transitions/captive portal/DNS/connect fixtures,
process death at each installer boundary, and capture of the original persistent network
failure. The patch does not claim a diagnosed MTK/DNS/routing root cause for OS-2047.

## Review follow-up

The first independent review found that debug-entry retry had bypassed a normal-phone
restart dead end: after ASG process death, the phone's detour latch suppresses another
`ota_start`, so a new process must resume polling without it. ASG now synchronously
persists the pending request/target/hash before handoff and restores polling at startup.
Only authenticated idle settles that marker. The phone regression covers unknown -> wait
without another start -> recovered idle -> safe Retry. The ASG regression reconstructs
a fresh helper from persisted state and checks the unsolicited idle verdict.

Physical confirmation: killed ASG after `downgrade_status_unknown`; the fresh process
restored the same pending identity and emitted `downgrade_not_owned` after recovery was
restored, before any new OTA command. The marker cleared, and the subsequent retry reused
the cached APK. This specifically closes the gap the first hardware/debug retry missed.

Other review findings were addressed with bounded readiness retries after a transient
query timeout, a separate adoption path that never stages bytes and reports persistence
failure, and preservation of Android's message-only clock-skew diagnosis. Recovery also
backfills a durable identity when v11 encounters an active v10 transaction. The missing-
worker physical test successfully deployed the bundled worker before the artifact GET.


The second independent review identified that a terminal idle result could be lost while
BLE was disconnected after ordinary session expiry. The handoff record now retains its
request/target/hash and terminal outcome independently of the expiring session, committing
before releasing ownership. Both reconnect and status query replay it without consuming
it or rearming polling. A newly admitted OTA worker retires it before even fetching the
next manifest, so a failed new manifest cannot expose the previous outcome. Regression
coverage exercises expiry, disconnected idle, another ASG restart, repeated reconnect/query,
terminal persistence failure, exact-version completion, and admission before manifest failure.
The phone regression reconnects after 31 minutes and permits Retry only after the retained
idle outcome. This edge is covered by automated tests; the earlier physical process-death
run did not include session expiry while disconnected.

The third review reproduced a presentation-only retry gap: the prior attempt's reconnect
flag survived a fresh Retry and immediately labeled the next install as Verifying. Fresh
attempt admission now resets that flag, while reconciliation-only Retry preserves it. The
existing disconnected-terminal regression failed with Verifying before this fix and now
checks Installing -> Restarting -> Verifying for the next attempt; all 143 phone tests pass.

Exact-head CI and the fourth review caught invalid disconnected-state fixture fields that
Jest does not type-check. The fixtures now use the discriminated union's disconnected
shape. After provisioning this checkout's own frozen dependencies, the full mobile
`bun run compile` and all 143 focused Jest tests pass. Earlier temporary shared-dependency
type-check output is not treated as validation of this checkout.
