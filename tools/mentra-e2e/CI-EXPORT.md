# Exporting a consumed CI routine

`runner/ci-run-exporter.ts` prepares private files for the existing
`publishTestRun` uploader. It does not consume a request, dispatch hardware,
change fixture readiness, publish, or infer a pass from a process exit code.
The adapter must already have passed the worker's local registration checks.

The inputs are SHA-256 references to the original durable claim and its private
trust policy. The claim must retain the worker's `claims/<requestId>.json`
layout. The exporter reads the corresponding original worker result and
`runs/<requestId>/{run.json,events.jsonl,state.json,result.json}` itself. A replay
response, interrupted intake, partial journal, missing registration, conflicting
checkpoint, or result for another claim is rejected.

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

After the worker has durably written `status: "routine-finished"`:

```ts
const exported = await exportCiRun({claim, trust, outputDirectory})
```

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
