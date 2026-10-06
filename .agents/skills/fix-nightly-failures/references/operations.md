# Nightly operations

These entry points are in MentraOS `dev` and the selected private
Mentra-Automated-Testing revision. Read their current source/help before acting;
the installed worker can differ from the newest branch. Keep credentials in the
provisioned environment/configuration and private diagnostics outside Git.

## Observe and retrieve evidence

GitHub shows request/notification delivery; Core and the host controller show
device execution. Start with the suite result URL and the source workflow:

```sh
gh run view RUN_ID --repo Mentra-Community/MentraOS --json status,conclusion,headSha,jobs
```

The existing Admin API, with the supplied admin credential, exposes:

- `GET /api/admin/test-runs/suites/{suiteId}`: selected members and suite results.
- `GET /api/admin/test-runs/{runId}`: immutable result, definition, asset manifest
  and publication status; a queued request is not a completed run.
- `GET /api/admin/test-runs/{runId}/assets/{encodedAssetId}`: original evidence.
- `GET /api/admin/test-runs/restoration/list`: published restoration history.

Use the result's declared asset IDs, not guessed filenames. Fetch only useful
diagnostics, impose a size limit and verify declared size/digest. Read the first
failure's framework result and relevant setup/teardown journal before expanding
to a recording or command log. Prefer the available API credential over making
a Mini agent sign in to Admin. Host inspection is read-only; controller
mutations use its public API/CLI. Root/coordinator owns hosted Admin verification.

## Dispatch a fresh suite or one affected routine

Manual nightly uses the same catalog/build selection as the scheduled workflow:

```sh
gh workflow run nightly-device-routines.yml --repo Mentra-Community/MentraOS --ref dev
```

Resolve and record the actual acknowledged workflow and Core occurrence before
another dispatch. In `.github/scripts/nightly-device-routines.mjs`, Core freezes
catalog preferences, definitions, builds and requests once per occurrence.
Reconcile delivery using the original IDs; an uncertain acknowledgement is not
a reason to start another suite. Inspect that workflow's result and Slack
receipt artifacts. Do not replay an uncertain Slack webhook send.

For targeted verification, inspect the current inputs of
`.github/workflows/request-e2e-routine.yml`. The current request is:

```sh
gh workflow run request-e2e-routine.yml --repo Mentra-Community/MentraOS --ref dev \
  -f routine=ROUTINE_ID -f platform=PLATFORM -f channel=CHANNEL \
  -f source_build_run_id=BUILD_RUN_ID -f source_publication_attempt=PUBLICATION_ATTEMPT
```

`platform` is `android` or `ios-on-mac`; `channel` is `dev`, `staging` or `pr`.
For `pr`, also supply `-f pr=PR_NUMBER`. Substitute the enrolled routine and
verified publication coordinates. Adopt an existing equivalent request rather
than duplicating it. A private harness fix runs only after trusted merged-worker
activation; a label does not authorize unmerged worker code.

## Held authoring and source activation

Use `create-routine` for detailed authoring schemas. In the private harness,
`orchestration/README.md`, `orchestration/controller.ts`,
`framework/authoring/session.ts` and `contracts/controller.ts` define the current
interfaces. Run the provisioned client in that checkout:

```sh
bun run mentra-test lane request @reservation.json
bun run mentra-test lane wait @wait.json
bun run mentra-test author start @start.json
bun run mentra-test author command @command.json
bun run mentra-test author inspect @scope.json
bun run mentra-test lane give-back @give-back.json
```

Wait for a granted reservation and use returned IDs/generations. Normal author
start performs setup once; `setupMode: "manual"` exposes lifecycle actions when
diagnosing setup. Inspect `actions` for the failing phase, then execute the
returned action ID. Supported granular commands are not a guarantee that a
provider's internal subactions are individually callable. If a real adapter gap
prevents inspecting the needed state, extend that shared entry point rather than
creating another runner or manufacturing a cleanup/resume receipt.

Use the host's existing installation/source-verification operations for merged
harness activation. Do not rewrite live candidate/release files or mutate
controller SQLite. Keep source preparation separate from activation; verify the
old suite/executors, authoring reservations and owned resources have settled at
the normal boundary, then record the exact new installed source. If no provisioned
framework activation operation is available, report that capability gap and own
its resolution. `source.enroll` registers definitions; an authoring-job candidate
installer is not a generic framework-release activation command. Do not invent a
job or edit installation state to substitute for the missing operation.
