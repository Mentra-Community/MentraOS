---
status: draft
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

## 1. Recovery readiness and repair

- [ ] Add a readiness/status protocol to recovery, with a correlated request ID and advertised protocol version. Increment the worker version and synchronize the bundled-version and minimum-version gates.
- [ ] In `RecoveryWorkerManager`, inspect availability/signers/permissions/receiver state, start or deploy through the supported path, and await readiness. A dispatched broadcast is not success.
- [ ] Verify the OEM path for repairing an explicitly disabled worker. If unsupported, give a specific recovery/support action instead of promising reboot will fix it.
- [ ] In `OtaHelper`, complete readiness before downloading or entering install/verifying presentation. Use a bounded readiness timer separate from hashing/enqueue and transaction supervision.
- [ ] Cover missing, old, disabled, stopped, incompatible, and non-responsive workers. Assert that unavailable recovery performs no large download.

## 2. Handoff ownership, cache, and UI

- [ ] Persist recovery-owned transaction identity/target/hash/state and expose a read-only status query.
- [ ] Make duplicate requests for the same transaction idempotent; report existing ownership for a conflicting request. Preserve claimed-artifact and installer serialization guarantees.
- [ ] Correlate all verdicts in `ServiceHeartbeatReceiver`/`OtaHelper`. On acknowledgement loss, reconcile durable state rather than treating timeout as confirmed non-ownership.
- [ ] Reuse valid unclaimed staged APKs; never overwrite a claimed artifact. Test corrupt cache, changed target, and a retry concurrent with accepted work.
- [ ] Update `OtaInstallCoordinator` and OTA presentation to follow the authoritative phase/ownership state through retry, reconnect, and remount. Keep exact target-version completion.
- [ ] Replace misleading two-minute/two-restart copy. Preserve the reported slow experience as an acceptance concern, with actual per-phase timings and clear install versus download labels.
- [ ] Test late verdicts, lost acceptance, recovery/ASG process death, phone remount, and slow accepted transactions; no duplicate install/download or premature release.

## 3. Network evidence and supported fixes

- [ ] Add attempt-scoped network/HTTP diagnostics at manifest and artifact boundaries; preserve a failure/retry ring in incident artifacts without credentials or signed URL queries.
- [ ] Replace the broad `no_internet` mapping with distinct DNS/connect/read-timeout/HTTP/TLS/no-network categories. Synchronize Engine error mapping and app translations.
- [ ] Put all download streams and connections under unconditional cleanup. Verify retries release admission, retain byte-based liveness, and make a fresh request on the intended current transport.
- [ ] Repeat the stalled-server fixture and add DNS, connect refusal, captive portal, validation transitions, AP loss, and hotspot/local-server recovery. Retry should succeed without manual reconnect when connectivity is usable.
- [ ] Capture the persistent failure on the affected network/setup. Only then select any MTK/DNS/routing/reconnection patch; the current fixture does not reproduce that specific cause.

## 4. Ship and qualify

- [ ] Establish delivery to already affected source builds: a compatible source-side ASG bridge plus versioned recovery, or an explicit signed-worker support repair. A fix only in the lower target cannot unblock its own installation.
- [ ] Run focused ASG/recovery JVM and Android compile checks, Engine coordinator/error tests, then physical release-signed qualification. Keep PR evidence separate from hardware evidence.
- [ ] Test exact source/target and bridge-to-staging paths on the RC Mentra App, normal Wi-Fi and phone-served hotspot; include reconnect, background/screen-off, gallery rendering and byte preservation.
- [ ] Read and apply `select-pr-routines` when opening implementation PRs; select existing coverage and state gaps. Obtain the required independent Codex PR review. No PR was opened during this investigation.

## Device disposition and limitations

Final glasses state: ASG `302010058` / 3.2.1, recovery v10 enabled in its original default state, not stopped, and no active downgrade transaction. All 74 pre-existing gallery files still match their original hashes, with no added files. The provided Mentra Wi-Fi connection remains configured.

The supported downgrade reset ASG-owned app state through uninstall/reinstall. It did not flash MTK/BES, change the phone's installed app, or delete gallery data. Local fixture servers were stopped, the investigation's ADB reverse removed, and ADB returned to non-root. The phone was returned home and put to sleep for charging.

The local evidence summary is `incident-logs/ota-investigation-20260930/summary.json`; `key-events.txt` indexes the full captured log and `SHA256SUMS` inventories the evidence. The connected phone is 3.2.0, not the reported RC; the test triggers exercised ASG/recovery directly, so full RC UI qualification remains on the checklist.
