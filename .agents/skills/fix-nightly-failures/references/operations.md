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

After the current suite finishes, submit interactive verification through the
built-in machine authoring job. Prepare its diagnosis brief while members run. Read the
private harness [job guide](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/docs/ROUTINE-WORK.md),
[assigned-agent skill](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/.agents/skills/prepare-routine-work/SKILL.md)
and selected revision's `contracts/routine-work.ts`. Use the provisioned operator
connection in the harness checkout:

```sh
bun run mentra-test routine-work submit @work.json
bun run mentra-test routine-work inspect @work-id.json
```

`work.json` supplies `schemaVersion: 1`, stable `workId`, `kind: "create" | "edit"`,
`routineId`, English `brief` (`goal`, `stepsOrChanges`, `expected`), exact harness
`source`, published `build`, enrolled `target` and `requirements`. Local submissions
omit `origin`; inspect with `{workId}`. Use `edit` for an existing routine and
`create` for a new one; there is no diagnosis job type. For a causal group, name
one representative routine and include the affected original runs, evidence for
the shared cause, needed observation and any capability gap in its brief. Reuse
an existing compatible job before submitting another. Grouping does not add a
multi-routine target or authorize actions outside that job's source/build,
target and reservation; separate jobs only when distinct unresolved device work
or incompatible targeting requires them. Do not invent a patch.

The supervisor creates the workspace and machine agent, supplies its scoped
connection, and binds the job's reservation and held session. The assigned agent
uses `create-routine` and its inner `lane`/`author` commands; the coordinator does
not start a parallel reservation or session. Normal author start performs setup
once; the job agent may use `setupMode: "manual"` and returned lifecycle action IDs
when diagnosing setup. Provider subactions may still be monolithic. Report a
demonstrated adapter gap through the job and assign its shared fix; do not create
another runner or manufacture a cleanup/resume receipt. Ordinary targeted runs
remain separate and need no authoring job when the evidence supports that choice.

Use the host's existing installation/source-verification operations for merged
harness activation. Do not rewrite live candidate/release files or mutate
controller SQLite. Keep source preparation separate from activation; verify the
accepted requests/executors, authoring reservations and owned resources affected
by the replaced source/shared configuration have settled at the normal boundary,
then record the exact new installed source. An idle lane is insufficient when
another lane's accepted work still depends on that installation. If no provisioned
framework activation operation is available, report that capability gap and own
its resolution. `source.enroll` registers definitions; an authoring-job candidate
installer is not a generic framework-release activation command. Do not invent a
job or edit installation state to substitute for the missing operation.
