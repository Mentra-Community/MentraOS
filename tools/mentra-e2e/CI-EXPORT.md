# Exporting a consumed CI routine

`runner/ci-run-exporter.ts` prepares private files for the existing
`publishTestRun` uploader. It does not consume a request, dispatch hardware,
change fixture readiness, publish, or infer a pass from a process exit code.
The adapter must already have passed the worker's local registration checks.

The inputs are SHA-256 references to the original durable claim and its private
trust policy. The claim must retain the worker's `claims/<requestId>.json`
layout. The exporter reads the corresponding original worker receipt, frozen
`runs/<requestId>/run.json`, lifecycle journal and immutable terminal snapshot.
The receipt must have `status: "routine-finished"` and pin its original snapshot;
an interrupted intake without that pin is not exportable. A replay response,
partial selected journal prefix, missing registration, changed snapshot or result
for another claim is rejected.

## Recorded evidence from a trusted adapter

Before capture, set the Report metadata explicitly:

```ts
report.metadata.executionMode = "ci-registered"
report.metadata.modelCalls = 0
report.metadata.ciLifecycle = await ciRecordingBinding({claim, trust})
```

After the recording has stopped normally, the routine's **evidence assertion**
can return:

```ts
return finalizeCiRecording({
  claim,
  trust,
  reportDirectory: report.directory,
  harnessDirectory: "/absolute/pinned/harness/tools/mentra-e2e",
  phaseByStep, // every recorded step ID, with setup/test/verify/teardown
})
```

This helper requires the Report's actual source revision, harness tree hash,
app identity and executable/JavaScript hashes to match the registered run and
selected CI app. It snapshots only the finalized report, video, chapters,
viewer and referenced screenshots/accessibility evidence into the claimed
run's fresh `recording/` directory. It runs that harness's real `verify-run.ts`,
rechecks source and copied bytes, and emits a hashed report/integrity descriptor
through the existing `Observation.actual` and `evidence` fields. No retry
replaces that directory. The descriptor is an artifact-integrity assertion;
a failed product test may still have complete recorded evidence.

The helper intentionally rejects manual discovery. Do not retrofit the binding
onto a supervised run or use a manual recording to fill an unattended CI pass.
The currently installed worker remains unqualified unless a trusted local
registration actually supplies a routine; this exporter adds no registration.

## Terminal export and publication

Each lifecycle completion freezes `terminals/<journal-sequence>.json`. Its
SHA-256 reference binds the terminal phase state, result, generation, previous
snapshot reference and exact journal prefix byte count/hash. `runLifecycle` and
`recoverLifecycle` return the lifecycle result fields plus `terminal`, whose
`path` is relative to the owning run directory. The worker stores the original
result and terminal reference separately in its durable receipt.

After the worker has durably written `status: "routine-finished"`, export that
original completion:

```ts
const exported = await exportCiRun({claim, trust, outputDirectory})
```

Omitting `terminal` always selects the original worker receipt's pinned snapshot.
Later recovery can append to the journal and update working `state.json` and
`result.json`; those files do not replace the original completion. The exporter
validates the selected snapshot against its exact terminal journal prefix.
Re-exporting the original completion after recovery therefore retains the
original canonical identity and outcomes.

To export a later completion from the same frozen run, pass its exact snapshot
explicitly, resolving the returned relative path against the original run
directory:

```ts
const recovered = await recoverLifecycle(frozenOptions)
const recoveredExport = await exportCiRun({
  claim,
  trust,
  outputDirectory: recoveryOutputDirectory,
  terminal: {
    path: join(runDirectory, recovered.terminal.path),
    sha256: recovered.terminal.sha256,
  },
})
```

This export still requires the original finished worker receipt. The supplied
snapshot must belong to its run and follow the validated snapshot chain; it is
not an arbitrary replacement result. Recovery exports have a distinct,
deterministic `runId`, retain the same `requestId`, and include
`provenance.originalRunId`, `provenance.resultGeneration` and
`provenance.previousResultRunId`. The previous result ID identifies the preceding
terminal generation. Re-exporting the same generation uses the same identity;
publishing it creates or resumes that immutable result instead of overwriting
the original run. The admin viewer links a recovery result to its original run.
Successful cleanup or return verification does not turn the original failed
test into a pass.

Use a new output directory. The result contains canonical `run.json`, a relative
`assets.json` mapping, validated video/screenshots/chapters when present, and a
sanitized lifecycle summary. The existing publisher consumes these files; it
has independent authentication, upload and retry handling. Raw claim/evidence
payloads, device logs, adapter errors and accessibility files are not exported.

The exporter recomputes the terminal lifecycle result from its phase state,
checks durable mutation intent/dispatch/reconciliation, and keeps test,
teardown, return verification, fixture and evidence outcomes separate. A
metadata-only terminal export always has incomplete evidence and cannot pass.
Recorded success also needs the routine's independent final and return
assertions and a ready terminal fixture; source failures cannot be erased.
The firmware assertion list is not synthesized from generic booleans: the
summary retains the registered routine's original final/return assertion
verdicts and definition/qualification/profile digests. The local registration
and its qualification remain responsible for the meaning of those assertions.
A terminal fixture result describes that run, not current hardware readiness.

Both exporters share the same bounded media checks: no symlink/path escape,
128 MiB per asset, decoded PNG dimensions, H.264 video duration, fresh screenshot
observations, exact chapter mapping and final byte rechecks. Videos larger than
the upload limit need deliberate segmentation; the exporter never truncates
or silently transcodes evidence. Publishable metadata is written last.
