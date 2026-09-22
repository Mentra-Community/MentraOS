# Selected-target MTK full-OTA restoration

`runner/mtk-full-restore.ts` provides two teardown steps for an existing
`LifecycleRoutine`. It has no CLI, worker registration, lease or new executor.
The resolved `FirmwareProfile.mtk` selects the artifact; no PR, release or local
firmware path is hardcoded. Full OTA is the only method in this factory. Flashing
remains a separate explicitly selected recovery adapter.

The factory is tested with fake transports. **Its real transport runtime and a
physical non-wiping restore pass remain unqualified.** Unit tests do not claim
firmware installation or complete fixture restoration.

## Trusted runtime contract

The caller holds the same exclusive lease throughout the routine. Its callbacks
must use recorded argv, timings, exact exit codes and immutable local evidence:

- `read`: independently identify the selected USB path or Wi-Fi endpoint, full
  CID/MAC, both serials, boot/slot and boot completion. Read actual Update Engine
  status, competing ASG/BES/app/stream idle state and power readiness. The owned
  MTK engine READY state is checked separately before activation. Engine IDLE by itself
  is insufficient. The generic identity reader requires the actual full MAC;
  an original January source with an empty persisted MAC is unsupported here
  until an independently validated, explicitly supplied bridge is available.
  Do not reuse the January empty-MAC bridge on another boot. After ambiguous
  admitted ASG 27/31/37 customer work, neither legacy `ota_status` nor Update
  Engine IDLE proves all writers idle; that runtime boundary remains unsupported.
- `verifyArtifact`: check the selected cached ZIP's bytes/size/SHA, authenticated
  producer provenance and real full-payload/non-wiping semantics. A manifest's
  `mtk_full_ota` label or ZIP metadata alone is not a payload verification. Pin
  the actual helper and status-probe bytes too. No download or publication occurs
  inside this factory.
- `transfer`: use only the supplied local file and new operation-owned remote
  path. Check remote absence and invoke `beforeWrite` immediately before every
  transfer write. Verify the completed remote size/SHA. Preserve failures and
  never retry an ambiguous write.
- `stage`: run the supplied exact argv through the existing pinned
  `stage_mtk_ota.py` wrapper. Reuse the January adapter's **two exact** status-JAR
  command remaps to the SHA-named probe; do not replace the generic JAR. Invoke
  `beforeApply` at the helper's single installation broadcast. Preserve its
  fenced log and complete result, including failures. Return that actual result
  as `receipt`, its original `preflight`, exact `argv`, and the persisted
  `sourceIntent` reference; do not synthesize these from an engine status.
- `readStageEvidence`: read the original command/preflight/result under the
  supplied deterministic `outputDirectory`, bound to the persisted source-intent
  reference. Return the same evidence shape as `stage`, or `null` if incomplete.
  Never execute a helper, transfer or device command here. Preserve an uncaptured
  process exit as `exitCode: null`; a successful original helper result and fresh
  READY proof can establish completion without inventing an exit code.
- `reboot`: invoke `beforeReboot` immediately before the one supplied targeted
  reboot. Start the existing boot observer first. It may wait for bounded
  read-only return observations, but must not issue another reboot or firmware
  command. Return the actual command outcome, even if later observations succeed.

The factory closes the transfer with fresh source/idle/power reads before the
helper begins, and the last-moment callbacks repeat the gate before application
and activation. Its postcondition requires the independently observed target
MTK, new boot, opposite slot and idle state. Exact BES/ASG and whole-fixture
return verification remain the outer routine's responsibility.

## Failure and recovery

An already-selected, independently idle MTK skips both steps. Otherwise the
lifecycle journals separate stage and activation intents; activation retains
the original stage owner. Before transfer, the factory exclusively creates and
fsyncs `mtk-full-<operationID>.intent.json` alongside the helper output directory.
It binds the source, target, fixture/config digest, remote path and lifecycle
intent. Immediately before apply it similarly saves
`mtk-full-<operationID>.apply-intent.json`, binding that source record's SHA and
the exact helper argv. These private evidence files are never overwritten.

If the process ends after the helper writes its result but before the lifecycle
dispatch event, reconciliation reads those original records and invokes only
`readStageEvidence`. It checks their owner/config/source/remote/target closure,
then takes a fresh identity and engine read. The original missing dispatch stays
missing in the journal; recovered evidence is recorded as reconciliation. A
missing/failed helper receipt or final apply gate cannot authorize activation
merely because Update Engine reports NEED_REBOOT. No transfer/helper is replayed.

An interrupted activation can settle from a freshly verified target boot under
the original staged operation. It never resends reboot, transfer or application.
Re-entering teardown recognizes that completed owned activation so it does not
wait for the old source boot again. These steps only reconcile their own MTK
work; they do not change the frozen customer-test verdict.

## Concrete local runtime

`createMtkFullRestoreRuntime(inputs, config)` in
`runner/mtk-full-restore-runtime.ts` implements the callbacks. Pass its result to
`createMtkFullRestoreSteps(inputs, runtime)` under the existing lifecycle lease.
There is no standalone hardware CLI. The first fixture serial is the selected
current device serial; its USB path or Wi-Fi endpoint is used exactly as supplied.
It never connects ADB, toggles Wi-Fi/USB or starts the app.

The runtime configuration contains the current lease path, SHA-pinned ADB and
Python, this directory's pinned `bridge.py`, the complete `day1-setup` Python
definition pins, and any additional authenticated modern source profiles. The
selected target profile is always accepted. `read` reuses the existing return
collector with the **actual source profile**, checks the active APK and all source
components, and requires its fresh process/SID/nonce/activity and stopped-stream
proof. Only the separate engine-IDLE check is omitted from competing-writer
checks while the owned MTK payload awaits reboot. The process and admission
generation are retained across transfer and checked again before apply/reboot.

For a non-target source, `bridge.py` reuses the January adapter's MAC-identified
BES heartbeat reader. The subsequent ASG collection closes that BLE read; the
heartbeat must still be fresh, with at least 50% battery and either PMU charging
or the independently identified USB attachment. A current-target idle observation
skips this power probe and requires no firmware artifact verification record.

For writes, `artifactVerification` is a private SHA-pinned JSON record produced
from the trusted offline package verification. It must contain:

```json
{
  "schemaVersion": 1,
  "otaSha256": "<selected ZIP SHA-256>",
  "otaBytes": 123,
  "manifestSha256": "<frozen selected manifest SHA-256>",
  "targetVersion": "<selected MTK version>",
  "fullPayload": true,
  "powerwash": false,
  "payloadSignatureVerification": "passed",
  "targetPartitionVerification": "passed"
}
```

These fields must derive from actual full-payload/signature/target-byte
verification; they are not an operator approval or an assertion to fill in by
hand. A missing record fails before transfer. The runtime rehashes the actual ZIP
and pinned tools. Producing that selected target's verification record and
qualifying the physical non-wiping restore remain outstanding.

The bridge runs the unchanged pinned helper with the January wrapper's exact
status-probe remapping. At its one SystemUI broadcast it waits on a private
stdin/stdout handshake; the parent executes the lifecycle's final gate before
approving that exact command. Command starts/results, source proofs, approvals,
stdout/stderr and original helper files remain private and exclusive. Recovery
only reads the originals. Reboot is sent once, followed by bounded read-only boot
observations; another lifecycle reconciliation must independently prove the
target and idle state.
