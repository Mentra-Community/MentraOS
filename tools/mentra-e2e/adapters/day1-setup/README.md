# January full-OTA setup adapter

This Python adapter prepares the January 13 factory baseline beneath an existing
routine lease. It has two mutating entry points: **stage** (transfer and apply),
and **activate** (one reboot, bounded network recovery and baseline checks).
It does not acquire a lease, run the customer routine, restore the selected
modern firmware, publish results, or mark a fixture ready.

The normal path was extracted from the recorded private setup controller. The
tracked extraction has fake-transport coverage; it has not itself been qualified
on hardware. Historical resume/reconciliation workarounds remain private.

## Frozen inputs

Before creating a lifecycle intent, the trusted worker writes a private, regular
0600 JSON file and freezes its SHA-256. `config.load(path, sha256)` requires exactly
these fields. Paths must be absolute; all hashes are lowercase SHA-256.

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `profileId`, `profileSha256` | `config.PROFILE['id']`, `config.PROFILE_SHA` |
| `fixture` | `{cid, serial, mac, bootSerial, serialAliases}`: full CID, full uppercase Bluetooth MAC, unique primary serial, explicit allowed transport serial aliases |
| `claimsRoot` | Existing worker-owned 0700 directory stable across runs; never a run-specific retry directory |
| `credential` | `{path, sha256}` for a preserved 0600 fixture credential file |
| `ota` | `{path, sha256, size}` for the exact qualified full January ZIP |
| `verification` | `{path, sha256}` for its independent signature and target-partition verification receipt |
| `stagingHelper` | `{path, sha256}` for the existing audited `stage_mtk_ota.py` |
| `statusProbe` | `{path, sha256, size}` for the audited 2143-byte UpdateEngineStatus JAR |
| `python`, `adb` | Absolute runtime executable paths. Python 3.10+ with Bleak; ADB on PATH must resolve to the same selected executable because the pinned helper also launches logcat. |
| `lease` | `{path, ownerPid}`: existing global harness lock file and live outer worker PID. The Python controller must be its immediate child. Nested BLE children verify the same outer parent. |
| `definition` | Map every filename in `config.DEFINITION_FILES` to its actual source SHA-256, frozen by the trusted routine definition |
| `managedAppExecutableName` | `Mentra`; its actual process must be absent before dispatch/BLE recovery |
| `sourceEndpoint` | The already identified private IPv4 network-ADB endpoint, port 5555 |
| `besInstallProof` | `{path, sha256}` for the accepted January BES install-continuity input described below |

`PROFILE` fixes the Sep21 source build/epoch, January MTK target, factory ASG27
bytes, full ZIP/payload/verification hashes, and `powerwash=true`. These are not
free-form firmware-selection options. Full OTA does not inherently wipe data;
this specific downgrade has **`POWERWASH=1`** to expose the bundled factory ASG27.
No separate initial ASG installation is performed. The normal January first
boot may install the exact bundled backup into `/data/app`; active, system and
backup APK hashes must all match.

The credential file retains the existing schema:
`{schemaVersion:1, fixture:{cid,serial,mac,mtk,slot,boot}, endpoint, ssid, password}`.
Its fixture MTK is January; boot/slot describe the preserved credential capture,
not a claim about the current source boot. The worker supplies the actual file;
there are no checked-in credentials, firmware binaries, helper binaries or live
fixture identities. Do not copy raw child evidence to public reports. The
redacted `Config.public_inputs()` includes only the credential digest.

BES input uses the unchanged strict `bes_continuity.validate_input` schema:
`{schemaVersion:1, kind:'verified-install-continuity', sourceBoot, besOwner,
installIntent:{path,sha256}, installLog:{path,sha256}, versionLog:{path,sha256}}`.
It requires the exact trimmed January raw/OTA artifacts, accepted install owner,
apply acknowledgement and successful verification on the current source boot.
The MTK stage obtains fresh UART proof and brackets the update with the same ASG
APK/process/SID/admission generation. Post-wipe continuity is setup-only; it
never substitutes for fresh final BES verification against the selected return
manifest.

## Calling from the existing lifecycle

The caller holds the one global lease and records its mutation intent first.
Use argv arrays, without a shell:

```text
<python> <adapter>/full_january.py stage
  --config <frozen-config.json> --config-sha256 <sha256>
  --run <new-stage-evidence-directory> --owner <lifecycle-operation-UUID>

<python> <adapter>/full_january.py activate
  --config <same-frozen-config.json> --config-sha256 <same-sha256>
  --run <same-stage-evidence-directory>
```

Activation preserves the stage owner and accepts no replacement `--owner`.
The stage boot/slot are actual first-read observations. Every existing mutation
guard rechecks config/source hashes, lease, process absence, credentials and
exact device identity. Files and phase directories are created exclusively;
source boot + full ZIP digest claims live under `claimsRoot/<cid>/stage/`.
Changing the run directory or owner cannot repeat a claimed operation. A
separate `claimsRoot/<cid>/provision/<owner>.json` prevents a second credential
write after an ambiguous response.

The phase process exits zero only after its normal result exists. A nonzero
exit or absent result is an observation gap, not authorization to resend.
`failure.json` retains the error class/guard, `resendAllowed:false` and the
unavailable-fixture boundary. Keep the lease and use read-only reconciliation
when a writer may still be active. No resume, flash, arbitrary command, retry,
force, or ignore-proof option exists here.

## Receipt contract

- `<run>/operation.json`: source identity, original owner, endpoint, remote ZIP,
  full artifact digest, config/profile digests, immutable BES input reference,
  credential digest and shared claim reference.
- `<run>/stage-result.json`: `status:'staged-awaiting-explicit-activation'`,
  `payloadApplied:true`, `activationCount:0`, exact operation/helper/BES-proof
  digests, source and inactive target slot. It requires observed
  `UPDATED_NEED_REBOOT`; it does not claim a boot or baseline.
- `<run>/activation/receipt.json`: digest-bound activation intent/result,
  original owner and credential digest. `activation-dispatched` records only
  the successful return of the one reboot command.
- `<run>/activation/recovery/{after,result}.json`: exact new January boot,
  CID/serials/MTK/slot/factory APK proof and MAC-identified same-SSID BLE endpoint.
  An empty persisted MAC is allowed only through this explicit recovery bridge.
- `<run>/activation/{wipe-proof,bes-continuity-result,result}.json`: owned,
  preverified userdata marker now absent; scoped BES continuity; final
  `status:'january-setup-baseline-verified'` and `setupBaselineReady:true`.

Even that result retains `customerRoutinePassed:false`,
`finalModernFirmwareVerificationPassed:false`,
`fixtureReadyForOtherRoutines:false`. Marker absence is not a claim that every
userdata block was erased. Transfer, apply and activation-to-readiness timings
remain separate; no same-version timing is reported as a rollback benchmark.

## Offline validation

```sh
python3 -m unittest discover -s tools/mentra-e2e/adapters/day1-setup -p 'test_*.py'
python3 -m py_compile tools/mentra-e2e/adapters/day1-setup/*.py
```

Tests use synthetic local configuration and fake ADB/BLE transports; they do not
require Bleak, ADB, firmware artifacts, a network service or attached hardware.
The caller supplies real dependencies only for a subsequent explicitly owned
hardware run. The original private scripts and failure/success evidence remain
unchanged.

## Read-only reconciliation

`reconcile.reconcile(phase, cfg, run, current)` is an importable pure helper,
not another executable workflow. `phase` is `stage` or `activate`; `cfg` is the
same validated configuration and `run` the same durable stage directory. It
reads private receipts but runs no device, process, lease or provisioning
commands. Its result is `{status, reason, owner, evidence, setupOnly:true,
fixtureReadyForOtherRoutines:false}`. The outer lifecycle still owns its intent
and no-repeat rules.

`current` must come from a trusted caller-owned read callback, never request
JSON or copied historical results:

```text
{
  startedAt, finishedAt,                 // host epoch seconds; at most 30 seconds
  bootBefore, bootAfter,                // actual enclosing boot reads
  identity,                             // exact existing source_identity/recovery.identity result
  engineStatus                          // actual UPDATE_STATUS_* value
}
```

For fresh post-reboot target satisfaction also provide:

```text
{
  stateReadsFinishedAt,                  // closes actual identity/engine reads
  januaryLog: {
    text,                               // complete current ASG boot log, successful read
    pidBefore, pidAfter,                 // actual ASG PID reads around capture
    startTicksBefore, startTicksAfter,   // actual /proc/<pid>/stat start-time reads
    bootEpoch, deviceEpoch,              // observed device epoch minus uptime, closing epoch
    capturedAt                          // host capture time after state reads, inside batch
  }
}
```

The caller must preserve raw argv/output/exit statuses and use the existing
exact identity readers; metadata fields do not themselves authenticate a read.
The helper requires the original accepted receipt, hashed normal stage/result,
recovery and wipe proof, scoped BES continuity, and fresh same-new-boot January
identity/engine/factory APK proof. The current startup log must show the actual
January autonomous-OTA-disabled branch and contain no later update admissions.
A truncated or stale log is an honest unknown state, not a prompt to restart ASG.

Before stage, only exact source + idle engine + no prior run or boot/artifact
claim gives `settled`. Before activation, only the owned completed stage and
current `UPDATED_NEED_REBOOT` give `settled`. Once the activation directory
exists, it cannot become permission to resend. A known busy engine on the exact
owned source is `active`; missing/stale/contradictory evidence is `unknown`.
A successful setup remains separate from final selected-manifest return checks.
