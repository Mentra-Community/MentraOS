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
