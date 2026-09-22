# Export a supervised day-one recording

`export-day1-run.ts` converts a **finished** discovery recording into the existing
admin publisher's `run.json`, `assets.json`, video, chapter index and screenshots.
It does not publish, operate hardware, consume a CI request, or establish fixture
readiness. The source run remains unchanged.

This is a monorepo command. Install the tools dependencies and the Cloud V2
dependencies (`bun install` in each directory), plus `ffprobe` and `ffmpeg` on
the host. The exporter reuses Cloud V2's canonical data-only test-run schema.

1. Finish the recording normally. Do not export a running or interrupted record.
2. Write a reviewed assessment using the `Day1Assessment` interface in
   `runner/day1-run-exporter.ts`. Bind `sourceRunSha256` to the final `run.json`.
   Supply the exact PR base SHA and the selected receipt and OTA manifest, each
   with its absolute local path, SHA-256 and published URL.
3. State test, teardown and fixture outcomes separately. A failed update followed
   by a successful failure-inspection step is still a failed test. Use
   `phaseByStep` when a recorded step belongs to setup, verification or teardown;
   unspecified steps are product-test steps. `not-applicable` becomes `not-run`
   in the admin schema, while its original verdict is retained in observations.
4. Export into a new directory, then review the result before publication:

   ```sh
   bun tools/mentra-e2e/export-day1-run.ts \
     --run-directory /absolute/path/to/finalized-run \
     --assessment /absolute/path/to/reviewed-assessment.json \
     --output /absolute/path/to/new-export
   ```

For a passing product test or a ready fixture, `finalState` must reference the
existing firmware-state verifier's profile, fixture, observation and verification
JSON files, with an SHA-256 for each. The exporter recomputes all 14 assertions
against the exact selected manifest. Capture this verification **before ending
the recording**: its timestamp must be within the recorded run. Observations
remain reviewed local evidence; exporting does not authenticate their hardware
origin. A passed test with unverified restoration remains blocked overall.

If only the component versions and active APK were verified, an optional
`componentVerification` hash-bound reference can record those four comparisons
without manufacturing a full return-state assertion. It must name this manifest
and recording interval and explicitly retain `fullFixtureReturnQualified: false`.
It never satisfies the final-state requirement for a passing test or ready fixture.

An optional `relatedRequest` binds an exact CI request JSON file for context.
It must match the PR candidate, and any selected artifacts must match the tested
artifacts. This supervised recording retains its own manual request ID; linking
the CI request does not mark it consumed or executed unattended.

The exporter probes the copied video, decodes each copied PNG, checks chapter and
screenshot freshness, and verifies source and output byte hashes. Each asset must
fit the admin service's 128 MiB limit. Oversize or incomplete media require a
separate diagnostic export or deliberate segmentation; they cannot be labeled
complete here. Output paths must not traverse symlinks. Raw logs, accessibility
trees, HTML, environment files and firmware binaries are not exported.

An export failure leaves no publishable `run.json`; preserve its partial folder
for diagnosis and use a new output directory after correcting the cause. Upload
only after review, using `publish-test-run.ts` and its independent upload journal.
